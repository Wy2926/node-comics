from concurrent.futures import Future
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import time

import pytest

from classic_node.agent import Agent, Page
from classic_node.journal import Journal
from classic_node.protocol import ControlFailure


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
            'expires_at': expires, 'language': 'en', 'config': {'engine': {'version': 'fixture'}},
            'input': {'width': pixels, 'height': 1}}


@pytest.fixture
def agent(tmp_path):
    local = {'node_id': 'fixture', 'resource_id': 'fixture', 'engine': {'gpu': -1},
             'max_leases': 8, 'local_pages': 2, 'download_workers': 4, 'delivery_workers': 4}
    transport = SimpleNamespace(control=SimpleNamespace(timeout=30), post=lambda *_: None)
    journal = Journal(tmp_path, 512 * 1024 * 1024)
    value = Agent(local, SimpleNamespace(version='fixture'), transport, journal)
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


def test_empty_competing_claim_hint_retries_boundedly_then_returns_to_normal_wait(agent, monkeypatch):
    current = [100.0]
    monkeypatch.setattr('classic_node.agent.time.monotonic', lambda: current[0])
    replies = [{'retry_after_seconds': .1}, {}]

    def post(_, body):
        server, _ = clock()
        return {'request_id': body['request_id'], 'server_time': server, 'leases': [], **replies.pop(0)}

    agent.transport.post = post
    agent.poll_control()
    agent.claim_pool.finish()
    agent.poll_control()
    assert agent.next_claim == 100.1 and len(agent.claim_pool.calls) == 1
    # A hint cannot bypass the node's local admission gate.
    agent.config['enabled'] = False
    current[0] = 100.2
    agent.poll_control()
    assert len(agent.claim_pool.calls) == 1
    agent.config['enabled'] = True
    agent.poll_control()
    agent.claim_pool.finish()
    agent.poll_control()
    assert len(agent.claim_pool.calls) == 2 and agent.next_claim == 120.2


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
    result = {'image': 'a' * 4096, 'result': {'output': {'byte_size': 3072}}}
    agent.pipeline.freeze(page, result)
    assert page.rgb is page.cleaned is page.analysis is page.alpha is None
    assert 0 < page.reserved == agent.pipeline.used < initial
    assert page.reserved >= len(result['image']) * 3 + 3072
    assert agent.next_claim == 0
    agent.pipeline.release(page)
    assert agent.pipeline.used == page.reserved == 0


def test_restored_frozen_completion_is_included_in_resident_budget(agent):
    completion = {'image': 'a' * 4096, 'result': {'output': {'byte_size': 3072}}}
    agent.journal.put('lease:0', {'completion': completion})
    page = add_page(agent)
    assert page.step == 'deliver' and page.completion == completion
    assert page.reserved == agent.pipeline.used == agent.pipeline.delivery_reservation(completion)


def test_late_configuration_response_never_rolls_back_newer_version(agent):
    original = dict(agent.config)
    agent.apply_config({**original, 'version': 2, 'execution_slots': 4})
    agent.apply_config(original)
    assert agent.config['version'] == 2 and agent.config['execution_slots'] == 4
