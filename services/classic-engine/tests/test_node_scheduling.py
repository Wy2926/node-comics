from concurrent.futures import Future
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import time

import numpy as np
import pytest

from classic_node.agent import Agent, Page
from classic_node.journal import Journal
from classic_node.protocol import ControlFailure, NodeFailure


class PendingPool:
    def __init__(self):
        self.calls = []

    def submit(self, operation, *args):
        future = Future()
        self.calls.append((future, operation, args))
        return future

    def finish(self, index=-1, *, response=None):
        future, operation, args = self.calls[index]
        try:
            future.set_result(operation(*args) if response is None else response)
        except Exception as error:
            future.set_exception(error)

    def shutdown(self, **_):
        pass


def clock():
    now = datetime.now(timezone.utc)
    return now.isoformat(), (now + timedelta(seconds=300)).isoformat()


def lease(key, *, pixels=100):
    _, expires = clock()
    return {'lease_id': str(key), 'lease_token': 'fixture-token', 'status': 'active',
            'expires_at': expires, 'language': 'en', 'config': {'engine': {'protocol_version': 3}},
            'input': {'width': pixels, 'height': 1}}


@pytest.fixture
def agent(tmp_path):
    local = {'node_id': 'fixture', 'resource_id': 'fixture', 'engine': {'gpu': 0},
             'max_leases': 8, 'local_pages': 2, 'download_workers': 4, 'delivery_workers': 4}
    transport = SimpleNamespace(control=SimpleNamespace(timeout=30), post=lambda *_: None)
    journal = Journal(tmp_path)
    value = Agent(local, SimpleNamespace(version='fixture', render_ipc_bytes=lambda *_: 0), transport, journal)
    value.apply_config({'version': 1, 'execution_slots': 8, 'enabled': True,
                        'request_seconds': 30, 'heartbeat_seconds': 10, 'poll_seconds': 20})
    for name in ('heartbeat_pool', 'claim_pool', 'notice_pool'):
        getattr(value, name).shutdown(wait=True)
        setattr(value, name, PendingPool())
    yield value
    value.close()
    journal.close()


def add_page(agent, key=0, **kwargs):
    server, _ = clock()
    agent.adopt(lease(key, **kwargs), server, time.monotonic())
    return agent.pages[str(key)]


@pytest.mark.parametrize('error,expected', [(NodeFailure('FUTURE_RENDER_DETAIL'), 'FUTURE_RENDER_DETAIL'),
                                          (ValueError('private text'), 'CLASSIC_RENDER_FAILED')])
def test_page_failure_preserves_diagnostic_codes_and_identifies_stage(agent, error, expected):
    page = add_page(agent)
    page.step = 'render'
    agent.pipeline.error(page, error)
    assert page.step == 'deliver' and page.completion['error']['code'] == expected
    assert agent.journal.get('lease:0')['completion']['error'] == {'code': expected}


@pytest.mark.parametrize('status', [400, 413, 415, 422])
def test_rejected_frozen_output_is_not_enqueued_for_upload_forever(agent, status):
    page = add_page(agent)
    frozen = {'lease_token': page.lease['lease_token'], 'result': {'output': {'byte_size': 5}}}
    agent.journal.freeze('lease:0', {'lease': page.lease, 'completion': frozen}, b'image')
    page.step, page.completion = 'deliver', frozen
    agent.pipeline.resize_reservation(page, agent.pipeline.delivery_reservation(frozen))
    agent.pipeline.error(page, ControlFailure('INVALID_PROVIDER_OUTPUT', status))
    assert page.completion == {'lease_token': page.lease['lease_token'], 'error': {'code': 'RESULT_REJECTED'}}
    assert agent.journal.output('lease:0') is None
    assert agent.journal.get('lease:0')['completion'] == page.completion
    calls = []
    agent.transport.post = lambda path, body: (calls.append((path, body)), {'status': 'terminal'})[1]
    assert agent.deliver(page, page.completion) == {'status': 'terminal'}
    assert calls[0][0].endswith('/complete')


@pytest.mark.parametrize('status', [0, 429, 500, 503])
def test_ambiguous_frozen_output_remains_recoverable(agent, status):
    page = add_page(agent)
    frozen = {'lease_token': page.lease['lease_token'], 'result': {'output': {'byte_size': 5}}}
    agent.journal.freeze('lease:0', {'lease': page.lease, 'completion': frozen}, b'image')
    page.step, page.completion = 'deliver', frozen
    agent.pipeline.error(page, ControlFailure('CONTROL_UNAVAILABLE', status))
    assert page.completion == frozen
    assert agent.journal.output('lease:0') == b'image'


def test_updates_apply_translation_without_renewal_and_never_revive_expiry(agent):
    page = add_page(agent)
    before = page.deadline, page.lease['expires_at'], page.renewed_at
    translated = {'revision': 'translated', 'translations': {'0': 'hello'}}
    page.update({'status': 'active', 'translations': translated})
    assert page.translations == translated
    assert (page.deadline, page.lease['expires_at'], page.renewed_at) == before
    page.deadline = time.monotonic() - 1
    page.update({'status': 'active', 'translations': {'revision': 'late'}})
    assert page.stopped and page.translations == translated


@pytest.mark.parametrize('status', ['stop', 'terminal'])
def test_old_heartbeat_does_not_shorten_newer_renewal_or_override_stop(agent, status):
    page = add_page(agent)
    server, expires = clock()
    sent = time.monotonic()
    page.update({'status': 'active', 'expires_at': expires}, server, sent + 1)
    deadline = page.deadline
    page.update({'status': 'active', 'expires_at': expires}, server, sent)
    assert page.deadline == deadline
    page.update({'status': status, 'code': 'LEASE_STOPPED'})
    page.update({'status': 'active', 'expires_at': expires}, server, sent + 2)
    assert (page.stopped or page.terminal) and page.deadline == deadline


def test_three_channels_stay_independent_and_updates_do_not_force_heartbeat(agent):
    page = add_page(agent)
    page.step = 'text'
    agent.poll_control()
    assert len(agent.heartbeat_pool.calls) == len(agent.claim_pool.calls) == len(agent.notice_pool.calls) == 1
    heartbeat_at = agent.last_heartbeat
    deadline = page.deadline
    translated = {'revision': 'ready', 'translations': {'0': 'hello'}}
    agent.notice_pool.finish(response={'revision': 2, 'claim_ready': False,
                                      'leases': [{'lease_id': '0', 'status': 'active', 'translations': translated}]})
    agent.poll_control()
    assert page.translations == translated and page.deadline == deadline
    assert agent.last_heartbeat == heartbeat_at
    # Neither a blocked heartbeat nor a blocked claim prevents notice handling.
    assert not agent.heartbeat_future.done() and not agent.claim_future.done()
    assert len(agent.heartbeat_pool.calls) == len(agent.claim_pool.calls) == 1


def test_empty_claim_waits_and_stale_notice_cannot_restart_it(agent):
    agent.poll_control()
    # This notice predates the current claim's admission generation.
    agent.notice_claim_generation = agent.claim_generation - 1
    agent.claim_pool.finish(response=False)
    agent.notice_pool.finish(response={'revision': 2, 'claim_ready': True, 'leases': []})
    agent.poll_control()
    for _ in range(20):
        agent.poll_control()
    assert len(agent.claim_pool.calls) == 1
    assert agent.next_claim > time.monotonic()


def test_slow_empty_claim_starts_fresh_backoff_after_dispatch_deadline_elapsed(agent):
    agent.poll_control()
    agent.next_claim = time.monotonic() - 1
    agent.claim_pool.finish(response=False)
    agent.poll_control()
    assert len(agent.claim_pool.calls) == 1 and agent.next_claim > time.monotonic()


@pytest.mark.parametrize('change', ['config', 'memory'])
def test_empty_claim_completion_preserves_newer_admission_wake(agent, change):
    page = add_page(agent)
    page.step = 'text'
    agent.pipeline.resize_reservation(page, 1024)
    agent.poll_control()
    assert agent.next_claim > time.monotonic()
    if change == 'config':
        agent.apply_config({**agent.config, 'version': 2})
    else:
        agent.pipeline.resize_reservation(page, 512)
    assert agent.next_claim == 0
    agent.claim_pool.finish(response=False)
    agent.poll_control()
    assert len(agent.claim_pool.calls) == 2
    # The wake is consumed by that dispatch; another empty response must wait.
    agent.claim_pool.finish(response=False)
    agent.poll_control()
    assert len(agent.claim_pool.calls) == 2 and agent.next_claim > time.monotonic()


def test_successful_batch_continues_when_download_capacity_is_available(agent):
    agent.poll_control()
    for key in range(4):
        page = add_page(agent, key)
        page.step = 'analyze'
        agent.pipeline.resize_reservation(page, agent.pipeline.input_reservation(page))
    agent.claim_pool.finish(response=True)
    agent.poll_control()
    assert len(agent.claim_pool.calls) == 2
    assert len(agent.heartbeat_pool.calls) == 1


def test_fresh_ready_notice_and_resource_release_refill_immediately(agent):
    agent.last_heartbeat = time.monotonic()
    agent.next_claim = time.monotonic() + 20
    agent.poll_control()
    request = agent.notice_pool.calls[-1][2][1]
    assert request['can_claim'] and request['config_version'] == 1
    agent.notice_pool.finish(response={'revision': 1, 'claim_ready': True, 'leases': []})
    agent.poll_control()
    assert len(agent.claim_pool.calls) == 1
    agent.claim_pool.finish(response=False)
    agent.poll_control()
    page = add_page(agent)
    agent.pipeline.resize_reservation(page, 1024)
    agent.pipeline.release(page)
    agent.poll_control()
    assert len(agent.claim_pool.calls) == 2


def test_claim_is_small_and_retry_retains_durable_request_id(agent):
    requests = []

    def post(_, body):
        requests.append(dict(body))
        if len(requests) == 1:
            raise ControlFailure('CONTROL_UNAVAILABLE')
        server, _ = clock()
        return {'request_id': body['request_id'], 'server_time': server, 'leases': []}

    agent.transport.post = post
    with pytest.raises(ControlFailure):
        agent.claim()
    assert requests[0]['count'] == 4
    agent.config['enabled'] = False
    assert agent.claim() is False
    assert requests[0] == requests[1]
    assert agent.journal.get('claim') is None


def test_pre_upgrade_pending_claim_replays_original_count_and_identity(agent):
    pending = {'request_id': 'saved-before-upgrade', 'config_version': 1, 'count': 32}
    agent.journal.put('claim', pending)
    requests = []

    def post(_, body):
        requests.append(dict(body))
        server, _ = clock()
        return {'request_id': body['request_id'], 'server_time': server, 'leases': []}

    agent.transport.post = post
    agent.config['enabled'] = False
    assert agent.claim() is False
    assert requests == [pending] and agent.journal.get('claim') is None


@pytest.mark.parametrize('hint', [.1, .237, .3])
def test_empty_competing_claim_hint_retries_boundedly_then_returns_to_normal_wait(agent, monkeypatch, hint):
    current = [100.0]
    monkeypatch.setattr('classic_node.agent.time.monotonic', lambda: current[0])
    replies = [{'retry_after_seconds': hint}, {}]

    def post(_, body):
        server, _ = clock()
        return {'request_id': body['request_id'], 'server_time': server, 'leases': [], **replies.pop(0)}

    agent.transport.post = post
    agent.poll_control()
    agent.claim_pool.finish()
    agent.poll_control()
    assert agent.next_claim == 100 + hint and len(agent.claim_pool.calls) == 1
    # A hint cannot bypass the node's local admission gate.
    agent.config['enabled'] = False
    current[0] = 100.4
    agent.poll_control()
    assert len(agent.claim_pool.calls) == 1
    agent.config['enabled'] = True
    agent.poll_control()
    agent.claim_pool.finish()
    agent.poll_control()
    assert len(agent.claim_pool.calls) == 2 and agent.next_claim == 120.4


@pytest.mark.parametrize('hint', [0, 21, '0.1', float('nan')])
def test_invalid_claim_retry_hint_preserves_pending_receipt(agent, hint):
    def post(_, body):
        server, _ = clock()
        return {'request_id': body['request_id'], 'server_time': server, 'leases': [], 'retry_after_seconds': hint}

    agent.transport.post = post
    with pytest.raises(ControlFailure, match='CONTROL_INVALID_RESPONSE'):
        agent.claim()
    assert agent.journal.get('claim') is not None


def test_accepted_downloads_bound_admission_and_count_pending_memory(agent):
    first = add_page(agent, 0, pixels=24_000_000)
    second = add_page(agent, 1, pixels=24_000_000)
    third = add_page(agent, 2, pixels=24_000_000)
    assert first.reserved == second.reserved == third.reserved == 0
    assert agent.pipeline.used == 0
    # Merely retaining their metadata must not allow further over-admission.
    assert agent.claim_capacity() == 0
    for page in (first, second, third):
        page.lease['input']['width'] = 100
    assert agent.claim_capacity() == 1
    add_page(agent, 3)
    assert agent.claim_capacity() == 0


def test_freeze_returns_peak_budget_but_keeps_delivery_buffers_accounted(agent):
    page = add_page(agent, pixels=24_000_000)
    initial = agent.pipeline.input_reservation(page)
    agent.pipeline.resize_reservation(page, initial)
    page.rgb = page.cleaned = page.analysis = page.alpha = object()
    agent.next_claim = time.monotonic() + 20
    result = {'output_bytes': b'a' * 3072, 'result': {'output': {'byte_size': 3072}}}
    agent.pipeline.freeze(page, result)
    assert page.rgb is page.cleaned is page.analysis is page.alpha is None
    assert 0 < page.reserved == agent.pipeline.used < initial
    assert page.reserved >= 3072 * 2
    assert agent.journal.output('lease:0') == result['output_bytes']
    assert 'output_bytes' not in agent.journal.get('lease:0')['completion']
    assert agent.next_claim == 0
    agent.pipeline.release(page)
    assert agent.pipeline.used == page.reserved == 0


def test_restored_frozen_completion_is_included_in_resident_budget(agent):
    completion = {'result': {'output': {'byte_size': 3072}}}
    agent.journal.freeze('lease:0', {'completion': completion}, b'a' * 3072)
    page = add_page(agent)
    assert page.step == 'deliver' and page.completion == completion
    assert page.reserved == agent.pipeline.used == agent.pipeline.delivery_reservation(completion)


def test_late_configuration_response_never_rolls_back_newer_version(agent):
    original = dict(agent.config)
    agent.apply_config({**original, 'version': 2, 'execution_slots': 4})
    agent.apply_config(original)
    assert agent.config['version'] == 2 and agent.config['execution_slots'] == 4


def isolate_pipeline_pools(agent):
    for name in ('download', 'compute', 'render', 'control', 'delivery'):
        getattr(agent.pipeline, name).shutdown(wait=True)
        setattr(agent.pipeline, name, PendingPool())


def render_analysis(page, blocks=2):
    page.analysis = {'regions': [{} for _ in range(blocks)], 'bubble_mask': 'encoded-mask-fixture'}
    page.translations = {'translations': {str(index): 'translated' for index in range(blocks)}}


@pytest.mark.parametrize('workers', [1, 2])
def test_render_has_independent_bounded_slots_and_keeps_memory(agent, workers):
    isolate_pipeline_pools(agent)
    agent.pipeline.render_workers = workers
    pages = [add_page(agent, i) for i in range(6)]
    for page in pages:
        page.step = 'render' if int(page.lease['lease_id']) < 3 else 'inpaint'
        page.rgb = page.cleaned = object()
        render_analysis(page, 1)
        agent.pipeline.resize_reservation(page, 1024)
    agent.pipeline.tick()
    assert len(agent.pipeline.render.calls) == workers
    assert len(agent.pipeline.compute.calls) == 2
    assert sum(p.future is not None for p in pages) == workers + 2
    for _ in range(10):
        agent.pipeline.tick()
    assert len(agent.pipeline.render.calls) == workers  # No executor backlog.
    assert len(agent.pipeline.compute.calls) == 2
    assert agent.pipeline.used == 6 * 1024 + workers * 100
    # Finish computation while the first render remains blocked.
    agent.pipeline.compute.finish(0, response=object())
    agent.pipeline.tick()
    assert len(agent.pipeline.compute.calls) == 3
    assert not agent.pipeline.render.calls[0][0].done()


def test_real_render_thread_does_not_hold_compute_slot(agent):
    from threading import Event
    began, release, computed = Event(), Event(), Event()
    agent.local['local_pages'] = 1
    rendering, waiting = add_page(agent, 0), add_page(agent, 1)
    rendering.step, waiting.step = 'render', 'text'
    rendering.analysis = {'regions': [{}]}
    def render(*_, **kwargs):
        began.set()
        assert release.wait(5)
        return {'result': {'output': None}, 'output_bytes': None}
    agent.runtime.render = render
    agent.runtime.inpaint = lambda *_, **kwargs: (computed.set(), object())[1]
    try:
        agent.pipeline.tick()
        assert began.wait(3)
        waiting.step = 'inpaint'
        agent.pipeline.tick()
        assert computed.wait(3)
        assert not rendering.future.done()
    finally:
        release.set()
        if rendering.future:
            rendering.future.result(timeout=5)


def test_inpaint_progress_is_not_queued_behind_older_unanalyzed_pages(agent):
    isolate_pipeline_pools(agent)
    agent.local['local_pages'] = 1
    queued, prepared = add_page(agent, 0), add_page(agent, 1)
    queued.step, prepared.step = 'analyze', 'inpaint'
    queued.ready_at, prepared.ready_at = 1, 2
    agent.pipeline.tick()
    assert queued.future is None and prepared.future is not None


@pytest.mark.parametrize('terminal', [False, True])
def test_cancelled_render_drains_before_releasing_buffers(agent, terminal):
    isolate_pipeline_pools(agent)
    page = add_page(agent)
    page.step = 'render'
    page.rgb = page.cleaned = sentinel = object()
    render_analysis(page)
    agent.pipeline.resize_reservation(page, 1024)
    agent.pipeline.tick()
    page.update({'status': 'terminal' if terminal else 'stop'})
    agent.reap()
    assert page.rgb is sentinel and agent.pipeline.used == 1224
    agent.pipeline.render.finish(0)
    agent.reap()
    if not terminal:
        assert page.render_reserved == 0
        assert page.rgb is page.cleaned is sentinel and agent.pipeline.used == page.reserved == 1024
        for _ in range(3):
            agent.reap()
        assert agent.pipeline.used == 1024
        agent.pipeline.delivery.finish(response={'status': 'terminal'})
        agent.reap()
    assert not agent.pages and agent.pipeline.used == 0 and page.rgb is None


def test_failed_render_does_not_block_other_pages(agent):
    isolate_pipeline_pools(agent)
    first, second = add_page(agent, 0), add_page(agent, 1)
    first.step = second.step = 'render'
    for page in (first, second):
        render_analysis(page, 1)
        agent.pipeline.resize_reservation(page, 1024)
    agent.pipeline.tick()
    agent.pipeline.render.calls[0][0].set_exception(NodeFailure('CLASSIC_LAYOUT_OVERFLOW'))
    agent.pipeline.tick()
    assert first.step == 'deliver' and first.completion['error']['code'] == 'CLASSIC_LAYOUT_OVERFLOW'
    assert second.future is not None and len(agent.pipeline.render.calls) == 2
    assert first.render_reserved == 0 and first.reserved == 1024
    assert agent.pipeline.used == 2 * 1024 + 100
    agent.pipeline.delivery.finish(response={'status': 'terminal'})
    agent.reap()
    assert list(agent.pages) == ['1'] and agent.pipeline.used == second.reserved == 1124


@pytest.mark.parametrize('spare', [0, 75, 300, 1000])
def test_render_cache_is_bounded_reserved_once_and_freed_after_drain(agent, spare):
    isolate_pipeline_pools(agent)
    agent.pipeline.render_workers = 3
    pages = [add_page(agent, i) for i in range(3)]
    for page in pages:
        page.step = 'render'
        render_analysis(page)
        agent.pipeline.resize_reservation(page, agent.pipeline.input_reservation(page))
    initial = agent.pipeline.used
    agent.pipeline.limit = initial + spare
    seen = []
    def render(*_, mask_cache_bytes, **kwargs):
        seen.append(mask_cache_bytes)
        return {'result': {'output': None}, 'output_bytes': None}
    agent.runtime.render = render
    budgets = [min(200, max(0, spare - index * 200)) for index in range(3)]
    for _ in range(3):
        agent.pipeline.tick()
    assert len(agent.pipeline.render.calls) == 3  # Zero cache must not stall work.
    assert agent.pipeline.used == initial + sum(budgets) <= agent.pipeline.limit
    assert [page.reserved - agent.pipeline.input_reservation(page) for page in pages] == budgets
    assert [page.render_reserved for page in pages] == budgets
    for index in range(3):
        agent.pipeline.render.finish(index)
    assert seen == budgets  # Each submitted operation captures its own budget.
    for page in pages:
        agent.pipeline.advance(page)
        assert page.render_reserved == 0
        assert page.reserved == agent.pipeline.delivery_reservation(page.completion)
    assert agent.pipeline.used == sum(page.reserved for page in pages) < initial
    for page in pages:
        agent.pipeline.release(page)
    assert agent.pipeline.used == 0


def test_render_cache_reservation_blocks_new_downloads_until_freeze(agent):
    isolate_pipeline_pools(agent)
    page = add_page(agent)
    page.step = 'render'
    render_analysis(page)
    initial = agent.pipeline.input_reservation(page)
    agent.pipeline.resize_reservation(page, initial)
    # A minimum-size download fits before cache admission, but not afterward.
    empty_download = Page(lease(1, pixels=0), clock()[0], time.monotonic())
    download_bytes = agent.pipeline.input_reservation(empty_download)
    agent.pipeline.limit = initial + download_bytes + 100
    assert agent.pipeline.claim_capacity() > 0
    agent.pipeline.tick()
    assert page.reserved == initial + 200 and agent.pipeline.claim_capacity() == 0
    waiting = add_page(agent, 1, pixels=0)
    agent.pipeline.tick()
    assert waiting.future is None and waiting.reserved == 0
    agent.pipeline.render.finish(response={'result': {'output': None}, 'output_bytes': None})
    agent.pipeline.tick()
    assert waiting.future is not None and waiting.reserved == download_bytes
    assert agent.pipeline.used <= agent.pipeline.limit


@pytest.mark.parametrize('outcome', ['render-error', 'freeze-error', 'stop', 'cancel-future'])
def test_render_cache_returns_before_slow_failure_receipt_without_discarding_working_buffers(agent, monkeypatch, outcome):
    isolate_pipeline_pools(agent)
    page = add_page(agent, pixels=24_000_000)
    page.step = 'render'
    render_analysis(page, 3)
    page.rgb = page.cleaned = sentinel = object()
    initial = agent.pipeline.input_reservation(page)
    agent.pipeline.resize_reservation(page, initial)
    download_bytes = agent.pipeline.input_reservation(SimpleNamespace(lease=lease(1)))
    agent.pipeline.limit = initial + download_bytes
    agent.pipeline.tick()
    assert page.render_reserved == download_bytes and agent.pipeline.used == agent.pipeline.limit
    waiting = add_page(agent, 1)
    agent.pipeline.tick()
    assert waiting.future is None
    if outcome == 'render-error':
        page.future.set_exception(NodeFailure('CLASSIC_LAYOUT_OVERFLOW'))
    elif outcome == 'freeze-error':
        def fail_freeze(current, result):
            assert current.render_reserved == 0 and current.reserved == initial
            raise OSError('fixture freeze failed')
        monkeypatch.setattr(agent.pipeline, 'freeze', fail_freeze)
        agent.pipeline.render.finish(response={'result': {'output': None}, 'output_bytes': None})
    elif outcome == 'stop':
        page.update({'status': 'stop'})
        agent.pipeline.render.finish()  # page.check fails before render starts.
    else:
        assert page.future.cancel()
    agent.reap()
    assert page.step == 'deliver' and page.future is not None and not page.future.done()
    assert page.render_reserved == 0 and page.reserved == initial
    assert page.rgb is page.cleaned is sentinel
    assert waiting.future is not None and waiting.reserved == download_bytes
    assert agent.pipeline.used == initial + download_bytes
    # A slow/retried failure receipt keeps RGB/cleaned, not a dead render cache.
    page.future.set_exception(ControlFailure('CONTROL_UNAVAILABLE'))
    page.next_stop = 0
    for _ in range(3):
        agent.reap()
    assert page.render_reserved == 0 and page.reserved == initial
    assert page.rgb is page.cleaned is sentinel
    assert agent.pipeline.used == initial + download_bytes


def test_close_returns_render_cache_after_draining_without_changing_working_budget(agent):
    page = add_page(agent)
    page.step = 'render'
    render_analysis(page)
    page.rgb = page.cleaned = sentinel = object()
    agent.pipeline.resize_reservation(page, 1024)
    agent.runtime.render = lambda *args, **kwargs: {'result': {'output': None}, 'output_bytes': None}
    agent.pipeline.tick()
    page.future.result(timeout=5)
    assert page.render_reserved == 200 and agent.pipeline.used == 1224
    agent.pipeline.close()
    assert page.render_reserved == 0 and page.reserved == agent.pipeline.used == 1024
    assert page.rgb is page.cleaned is sentinel
    agent.pipeline.close()
    assert page.reserved == agent.pipeline.used == 1024


def test_render_timings_survive_freeze_without_changing_result(agent):
    from classic_node.timing import record
    page = add_page(agent)
    page.step = 'render'
    def operation():
        record('render_layout', .125)
        return {'result': {'output': None}, 'output_bytes': None}
    agent.pipeline.submit(page, agent.pipeline.render, 'render', operation)
    page.future.result(timeout=5)
    agent.pipeline.advance(page)
    saved = agent.journal.get('lease:0')['completion']
    assert saved['timings']['render_layout'] == .125
    assert saved['result'] == {'output': None}


@pytest.mark.parametrize('spare', [0, 799, 800, 1000, 1700, 2400, 3000])
def test_ipc_and_cache_share_bounded_budget_with_local_fallback(agent, spare):
    isolate_pipeline_pools(agent)
    agent.pipeline.render_workers = 3
    agent.runtime.render_ipc_bytes = lambda w, h: w * h * 8
    pages = [add_page(agent, i) for i in range(3)]
    for page in pages:
        page.step = 'render'
        render_analysis(page)
        agent.pipeline.resize_reservation(page, agent.pipeline.input_reservation(page))
    initial = agent.pipeline.used
    agent.pipeline.limit = initial + spare
    seen, expected = [], []
    remaining = spare
    for _ in pages:
        ipc = 800 if remaining >= 800 else 0
        remaining -= ipc
        pooled = ipc > 0
        cache = min(200, remaining)
        remaining -= cache
        expected.append((pooled, cache, ipc + cache))
    def render(*args, use_render_pool, mask_cache_bytes, check_cancelled, masks):
        check_cancelled()
        seen.append((use_render_pool, mask_cache_bytes))
        return {'result': {'output': None}, 'output_bytes': None}
    agent.runtime.render = render
    for _ in range(3):
        agent.pipeline.tick()
    assert len(agent.pipeline.render.calls) == 3  # No memory deadlock or backlog.
    assert [p.render_reserved for p in pages] == [e[2] for e in expected]
    assert agent.pipeline.used == initial + spare - remaining <= agent.pipeline.limit
    for index, page in enumerate(pages):
        agent.pipeline.render.finish(index)
        agent.pipeline.advance(page)
        assert page.render_reserved == 0
    assert seen == [e[:2] for e in expected]
    assert agent.pipeline.used == sum(p.reserved for p in pages)


@pytest.mark.parametrize('outcome', ['failure', 'stop', 'cancel-future'])
def test_ipc_reservation_outlives_worker_and_returns_before_terminal_receipt(agent, outcome):
    isolate_pipeline_pools(agent)
    agent.runtime.render_ipc_bytes = lambda *_: 800
    page = add_page(agent)
    page.step = 'render'
    render_analysis(page)
    page.rgb = page.cleaned = sentinel = object()
    initial = agent.pipeline.input_reservation(page)
    agent.pipeline.resize_reservation(page, initial)
    agent.pipeline.limit = initial + 1000
    agent.pipeline.tick()
    assert page.render_reserved == 1000 and agent.pipeline.used == initial + 1000
    if outcome == 'failure':
        page.future.set_exception(NodeFailure('CLASSIC_RENDER_WORKER_FAILED'))
    elif outcome == 'stop':
        page.update({'status': 'stop'})
        agent.reap()
        assert page.render_reserved == 1000 and page.rgb is sentinel
        agent.pipeline.render.finish()
    else:
        assert page.future.cancel()
    agent.reap()
    assert page.render_reserved == 0 and page.reserved == agent.pipeline.used == initial
    assert page.rgb is page.cleaned is sentinel
    assert page.future is not None and not page.future.done()  # Slow terminal delivery.


@pytest.mark.parametrize('bubble', [None, 'encoded-mask-fixture'])
@pytest.mark.parametrize('texts,blocks', [(['', ' \t', '\u3000'], 0), (['', 'hello', '\n'], 1), (['a', 'b', 'c'], 3)])
def test_reference_cache_requires_bubble_and_counts_only_nonempty_translations(agent, bubble, texts, blocks):
    isolate_pipeline_pools(agent)
    page = add_page(agent)
    page.step = 'render'
    render_analysis(page, len(texts))
    page.analysis['bubble_mask'] = bubble
    page.translations['translations'] = {str(index): text for index, text in enumerate(texts)}
    agent.pipeline.resize_reservation(page, 1024)
    agent.pipeline.tick()
    expected = 100 * blocks if bubble else 0
    assert page.render_reserved == expected and agent.pipeline.used == 1024 + expected
    assert page.future is not None  # No optional cache must never stall a page.


def test_ready_batch_keeps_useful_cache_before_admitting_more_ipc(agent):
    isolate_pipeline_pools(agent)
    agent.pipeline.render_workers = 5
    agent.runtime.render_ipc_bytes = lambda w, h: w * h * 8
    pages = [add_page(agent, key) for key in range(6)]
    for page in pages:
        page.step = 'render'
        render_analysis(page, 3)
        agent.pipeline.resize_reservation(page, 1024)
    initial = agent.pipeline.used
    agent.pipeline.limit = initial + 5 * 800
    seen = []
    def render(*args, use_render_pool, mask_cache_bytes, masks, check_cancelled):
        check_cancelled()
        seen.append((use_render_pool, mask_cache_bytes))
        return {'result': {'output': None}, 'output_bytes': None}
    agent.runtime.render = render
    for _ in range(3):
        agent.pipeline.tick()
    # Three IPC+full-cache pages consume 3300 bytes; both remaining admitted
    # pages render locally with full cache instead of disabling mask reuse.
    assert [page.render_reserved for page in pages] == [1100] * 3 + [300] * 2 + [0]
    assert agent.pipeline.used == agent.pipeline.limit - 100
    assert len(agent.pipeline.render.calls) == 5 and pages[-1].future is None
    for index in range(5):
        agent.pipeline.render.finish(index)
    assert seen == [(True, 300)] * 3 + [(False, 300)] * 2


@pytest.mark.parametrize('nonempty_page', [None, 1])
def test_blank_translations_take_neither_ipc_nor_cache_from_ready_batch(agent, nonempty_page):
    isolate_pipeline_pools(agent)
    agent.pipeline.render_workers = 3
    agent.runtime.render_ipc_bytes = lambda w, h: w * h * 8
    pages = [add_page(agent, key) for key in range(3)]
    for index, page in enumerate(pages):
        page.step = 'render'
        render_analysis(page, 1)
        page.translations['translations']['0'] = 'hello' if index == nonempty_page else ' \n\t\u3000'
        agent.pipeline.resize_reservation(page, 1024)
    agent.pipeline.limit = 3 * 1024 + 800
    seen = []
    def render(*args, use_render_pool, mask_cache_bytes, **kwargs):
        seen.append((use_render_pool, mask_cache_bytes))
        return {'result': {'output': None}, 'output_bytes': None}
    agent.runtime.render = render
    agent.pipeline.tick()
    assert [page.render_reserved for page in pages] == [800 if index == nonempty_page else 0 for index in range(3)]
    for index in range(3):
        agent.pipeline.render.finish(index)
    assert seen == [(index == nonempty_page, 0) for index in range(3)]
    assert agent.pipeline.used == 3 * 1024 + (800 if nonempty_page is not None else 0)


def native_masks(page, names=('mask', 'raw_mask', 'bubble_mask')):
    size = page.lease['input']
    result = {}
    for name in names:
        array = np.ones((size['height'], size['width']), dtype=np.uint8)
        array.flags.writeable = False
        result[name] = array
    return result


def test_native_masks_are_page_local_counted_and_trimmed_at_stage_boundaries(agent):
    isolate_pipeline_pools(agent)
    page, other = add_page(agent, 0), add_page(agent, 1)
    other.step = 'text'
    assert page.masks is not other.masks and not page.masks and not other.masks
    cached = native_masks(page, ('mask', 'bubble_mask'))
    rgb = np.zeros((1, 100, 3), dtype=np.uint8)
    metadata = {**page.lease['input'], 'sha256': 'fixture-sha'}
    analysis = {'input_hash': 'fixture-sha', 'regions': [{}], 'segments': [{'id': '0'}],
                'bubble_mask': 'encoded-mask-fixture'}
    seen = []
    agent.input_bytes = lambda current: (b'image', metadata)
    agent.runtime.decode = lambda data, meta: (rgb, None)
    def analyze(image, input_hash, *, masks):
        assert image is rgb and input_hash == 'fixture-sha' and masks is page.masks
        masks.update(cached)
        return analysis
    def inpaint(image, checkpoint, *, masks):
        assert checkpoint is analysis and masks is page.masks
        assert masks['mask'] is cached['mask'] and not masks['mask'].flags.writeable
        seen.append('inpaint')
        return rgb.copy()
    def render(*args, masks, **kwargs):
        assert masks is page.masks and set(masks) == {'bubble_mask'}
        assert masks['bubble_mask'] is cached['bubble_mask']
        seen.append('render')
        return {'result': {'output': None}, 'output_bytes': None}
    agent.runtime.analyze, agent.runtime.inpaint, agent.runtime.render = analyze, inpaint, render
    initial = agent.pipeline.input_reservation(page)
    agent.pipeline.limit = initial
    agent.pipeline.tick()
    assert page.mask_reserved == 300 and page.reserved == initial
    agent.pipeline.download.finish()
    agent.pipeline.tick()
    agent.pipeline.compute.finish(0)
    assert page.mask_reserved == 300  # Still reserved until the future is drained.
    agent.pipeline.tick()
    assert page.mask_reserved == 200 and page.reserved == agent.pipeline.used == initial - 100
    assert page.step == 'inpaint' and page.analysis_future is not None
    agent.pipeline.compute.finish(1)
    agent.pipeline.advance(page)
    assert set(page.masks) == {'bubble_mask'} and page.mask_reserved == 100
    assert page.reserved == agent.pipeline.used == initial - 200
    assert page.step == 'text' and page.analysis_future is not None
    page.translations = {'translations': {'0': 'hello'}}
    agent.pipeline.control.finish(response={'receipt': None})
    agent.pipeline.tick()
    assert page.render_reserved == 100
    agent.pipeline.render.finish()
    agent.pipeline.advance(page)
    assert seen == ['inpaint', 'render'] and not page.masks and page.mask_reserved == 0
    assert page.reserved == agent.pipeline.used == agent.pipeline.delivery_reservation(page.completion)
    assert not other.masks and other.mask_reserved == 0


@pytest.mark.parametrize('restored', [False, True])
@pytest.mark.parametrize('has_masks', [False, True])
def test_prepare_fills_or_restores_masks_once_and_releases_unused_allowance(agent, restored, has_masks):
    isolate_pipeline_pools(agent)
    page = add_page(agent)
    page.step, page.data = 'analyze', b'image'
    page.metadata = {**page.lease['input'], 'sha256': 'fixture-sha'}
    analysis = {'input_hash': 'fixture-sha', 'segments': [{'id': '0'}] if has_masks else [], 'regions': []}
    page.analysis = analysis if restored else None
    initial = agent.pipeline.input_reservation(page)
    agent.pipeline.resize_reservation(page, initial)
    page.mask_reserved = 300
    rgb = np.zeros((1, 100, 3), dtype=np.uint8)
    agent.runtime.decode = lambda *_: (rgb, None)
    calls = []
    def populate(masks):
        assert masks is page.masks
        if has_masks:
            masks.update(native_masks(page, ('mask',)))
    def analyze(image, input_hash, *, masks):
        assert not restored
        calls.append('analyze')
        populate(masks)
        return analysis
    def restore(checkpoint, size, masks):
        assert restored and checkpoint is analysis and size == (100, 1)
        calls.append('restore')
        populate(masks)
    agent.runtime.analyze, agent.runtime.restore_masks = analyze, restore
    agent.pipeline.tick()
    agent.pipeline.compute.finish()
    agent.pipeline.advance(page)
    expected = 100 if has_masks else 0
    assert calls == ['restore' if restored else 'analyze']
    assert page.mask_reserved == expected and agent.pipeline.used == initial - 300 + expected
    assert page.analysis_future is not None  # Waiting for acceptance holds only actual native masks.


@pytest.mark.parametrize('restored', [False, True])
def test_failed_prepare_discards_partial_masks_only_after_future_drains(agent, restored):
    isolate_pipeline_pools(agent)
    page = add_page(agent)
    page.step, page.data = 'analyze', b'image'
    page.metadata = {**page.lease['input'], 'sha256': 'fixture-sha'}
    page.analysis = {'input_hash': 'fixture-sha'} if restored else None
    page.mask_reserved = 300
    initial = agent.pipeline.input_reservation(page)
    agent.pipeline.resize_reservation(page, initial)
    agent.runtime.decode = lambda *_: (np.zeros((1, 100, 3), dtype=np.uint8), None)
    def fail(masks):
        masks.update(native_masks(page, ('mask',)))
        raise NodeFailure('CLASSIC_OCR_INVALID')
    agent.runtime.analyze = lambda *_args, masks: fail(masks)
    agent.runtime.restore_masks = lambda _analysis, _size, masks: fail(masks)
    agent.pipeline.tick()
    agent.pipeline.compute.finish()
    assert set(page.masks) == {'mask'} and page.mask_reserved == 300
    agent.pipeline.advance(page)
    assert page.step == 'deliver' and not page.masks and page.mask_reserved == 0
    assert page.reserved == agent.pipeline.used == initial - 300


@pytest.mark.parametrize('first', ['analysis', 'compute'])
def test_mask_cleanup_waits_for_both_compute_and_analysis_receipt_to_drain(agent, first):
    isolate_pipeline_pools(agent)
    page = add_page(agent)
    page.step, page.analysis = 'inpaint', {'regions': [{}]}
    page.rgb = sentinel = object()
    page.masks.update(native_masks(page))
    page.mask_reserved = 300
    agent.pipeline.resize_reservation(page, 1024 + 300)
    compute, receipt = Future(), Future()
    page.future, page.analysis_future = compute, receipt
    failed, pending = (receipt, compute) if first == 'analysis' else (compute, receipt)
    failed.set_exception(NodeFailure('CLASSIC_INPAINT_FAILED'))
    agent.pipeline.advance(page)
    assert len(page.masks) == 3 and page.mask_reserved == 300
    assert agent.pipeline.used == 1324 and page.pending_error is not None
    pending.set_result(object() if first == 'analysis' else {'receipt': None})
    agent.pipeline.advance(page)
    assert page.step == 'deliver' and not page.masks and page.mask_reserved == 0
    assert page.rgb is sentinel and page.reserved == agent.pipeline.used == 1024
    agent.pipeline.tick()
    assert page.future is not None and not page.future.done()  # A slow failure receipt owns no masks.


@pytest.mark.parametrize('status', ['expired', 'stop', 'terminal'])
def test_idle_masks_are_released_before_stop_receipt_or_terminal_cleanup(agent, status):
    isolate_pipeline_pools(agent)
    page = add_page(agent)
    page.step = 'text'
    page.masks.update(native_masks(page, ('bubble_mask',)))
    page.mask_reserved = 100
    agent.pipeline.resize_reservation(page, 1124)
    if status == 'expired':
        page.deadline = time.monotonic() - 1
    else:
        page.update({'status': status})
    agent.reap()
    assert not page.masks and page.mask_reserved == 0
    if status == 'terminal':
        assert not agent.pages and agent.pipeline.used == 0
    else:
        assert page.future is not None and not page.future.done()
        assert agent.pipeline.used == page.reserved == 1024


def test_close_waits_for_native_mask_readers_before_clearing_cache(agent):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    began, release = Event(), Event()
    page = add_page(agent)
    page.step, page.analysis = 'inpaint', {'regions': [{}]}
    page.masks.update(native_masks(page))
    page.mask_reserved = 300
    agent.pipeline.resize_reservation(page, 1324)
    def inpaint(*args, masks):
        assert masks is page.masks
        began.set()
        assert release.wait(5)
        assert len(masks) == 3
        return object()
    agent.runtime.inpaint = inpaint
    agent.pipeline.tick()
    assert began.wait(3)
    with ThreadPoolExecutor(1) as threads:
        closing = threads.submit(agent.pipeline.close)
        try:
            assert not closing.done() and page.mask_reserved == 300 and len(page.masks) == 3
        finally:
            release.set()
        closing.result(timeout=5)
    assert not page.masks and page.mask_reserved == 0 and agent.pipeline.used == 1024
    agent.pipeline.release(page)
    assert page.reserved == agent.pipeline.used == 0
