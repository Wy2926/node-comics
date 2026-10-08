"""Real spawn/shared-memory lifecycle tests without Qt, models, or CUDA."""
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from io import BytesIO
import json
import os
from pathlib import Path
import posixpath
import subprocess
import sys
from threading import Thread
import time
import traceback
from types import SimpleNamespace

import numpy as np
import psutil
import pytest
from PIL import Image

from classic_node import render_pool as rp
from classic_node.timing import collect, record


class FakeRenderer:
    def render(self, original, cleaned, regions, translations, language, mask, *, mask_cache_bytes=None,
               bubble_prepared=False, bubble_components=None):
        assert not original.flags.writeable and not cleaned.flags.writeable and not mask.flags.writeable
        if regions:
            Path(regions[0]['started']).touch()
        if language in ('slow', 'linger'):
            time.sleep(.3 if language == 'slow' else 30)
        if language == 'error':
            raise ValueError('private OCR fixture must not leave the worker')
        if language == 'crash':
            os._exit(23)
        if language == 'encode-error':
            raise rp.NodeFailure('CLASSIC_OUTPUT_ENCODE_FAILED')
        if language == 'unknown-node-error':
            raise rp.NodeFailure('PRIVATE_FIXTURE_DETAIL')
        result = np.bitwise_xor(original, cleaned)
        result[:, :, 0] ^= mask
        result[0, 0, 1] = (mask_cache_bytes or 0) % 256
        if bubble_prepared:
            labels, stats = bubble_components
            assert not labels.flags.writeable and not stats.flags.writeable
            result[..., 2] ^= labels.astype(np.uint8)
            result[0, 0, 2] ^= int(stats[0, 4]) % 256
        return result


def fake_initialize(models, fonts, threads, barrier, cpu_slots=None):
    # Top-level functions remain importable by the actual spawn interpreter.
    rp._renderer, rp._startup_barrier = FakeRenderer(), barrier
    rp._cpu_slots, rp._cpu_width = cpu_slots, threads
    Thread(target=rp._watch_parent, daemon=True).start()


def wait_until(predicate, seconds=5):
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, 'Timed out waiting for worker state'
        time.sleep(.01)


def assert_removed(names):
    for name in names:
        try:
            segment = rp.SharedMemory(name=name)
        except FileNotFoundError:
            continue
        segment.close()
        pytest.fail(f'Owned shared segment was not removed: {name}')


@pytest.fixture
def inputs():
    original = np.arange(9 * 8 * 3, dtype=np.uint8).reshape(8, 9, 3)
    return original, np.full_like(original, 17), np.full((8, 9), 23, np.uint8)


def identity():
    return {'version': 'fixture', 'analysis': {'input_hash': '0' * 64},
            'translated': {'analysis_hash': '1' * 64, 'revision': 'fixture'}}


@pytest.fixture
def pool(monkeypatch):
    monkeypatch.setattr(rp, '_initialize', fake_initialize)
    allocations, shared_memory = [], rp.SharedMemory

    def tracked_shared_memory(*args, **kwargs):
        segment = shared_memory(*args, **kwargs)
        if kwargs.get('create'):
            allocations.append(segment.name)
        return segment

    monkeypatch.setattr(rp, 'SharedMemory', tracked_shared_memory)
    pool = rp.RenderPool('unused-models', (), workers=2, threads=1)
    try:
        yield pool, allocations
    finally:
        pool.close()
        assert_removed(allocations)


def render(pool, inputs, language='en', **kwargs):
    original, cleaned, mask = inputs
    return pool.render(original, cleaned, [], ['text'], language, mask, **(identity() | kwargs))


def test_spawn_preserves_inputs_pixels_and_persistent_workers(pool, inputs):
    instance, names = pool
    instance.warmup()
    executor = instance._pool
    workers = list(executor._processes.values())
    assert len(workers) == 2 and all(worker.is_alive() for worker in workers)
    before = [array.copy() for array in inputs]
    result = render(instance, inputs, mask_cache_bytes=431)
    expected = np.bitwise_xor(inputs[0], inputs[1])
    expected[:, :, 0] ^= inputs[2]
    expected[0, 0, 1] = 431 % 256
    assert result == rp.pack_result(expected, inputs[0], None, **identity())
    for value, saved in zip(inputs, before):
        np.testing.assert_array_equal(value, saved)
    assert isinstance(result['output_bytes'], bytes) and rp.ipc_bytes(9, 8) == 576
    assert set(result) == {'result', 'output_bytes'}  # No transport timing or RGB array leaks into identity.
    assert_removed(names)
    render(instance, inputs)
    assert instance._pool is executor
    instance.close()
    assert all(not worker.is_alive() for worker in workers)
    with pytest.raises(rp.RenderPoolError, match='CLASSIC_RENDER_POOL_CLOSED'):
        render(instance, inputs)


def test_prepared_component_arrays_cross_shared_memory_readonly(pool, inputs):
    instance, _ = pool
    labels = np.ones(inputs[2].shape, np.int32)
    stats = np.array([[0, 0, 1, 1, 23], [0, 0, 1, 1, 49]], np.int32)
    labels.flags.writeable = stats.flags.writeable = False
    snapshot = [array.copy() for array in inputs]
    for array in inputs:
        array.flags.writeable = False
    options = {'bubble_prepared': True, 'bubble_components': (labels, stats)}
    expected = rp.render_page(FakeRenderer(), inputs[0], inputs[1], [], ['text'], 'en', inputs[2],
                              alpha=None, **identity(), **options)
    assert render(instance, inputs, **options) == expected
    assert rp.ipc_bytes(9, 8, 2) == 9 * 8 * 12 + stats.nbytes
    for before, after in zip(snapshot, inputs):
        np.testing.assert_array_equal(before, after)


def test_worker_errors_are_sanitized_and_pool_survives(pool, inputs):
    instance, names = pool
    with pytest.raises(rp.RenderPoolError) as failure:
        render(instance, inputs, 'error')
    detail = ''.join(traceback.format_exception(failure.value))
    assert failure.value.code == 'CLASSIC_RENDER_WORKER_FAILED'
    assert 'private OCR' not in detail
    assert_removed(names)
    render(instance, inputs)


@pytest.mark.parametrize('alpha_kind', ['none', 'opaque', 'partial', 'transparent', 'pil'])
def test_spawn_whole_page_matches_local_with_alpha_and_separate_timings(pool, inputs, alpha_kind):
    instance, names = pool
    alpha = None if alpha_kind == 'none' else np.full(inputs[0].shape[:2], 255, np.uint8)
    if alpha_kind in ('partial', 'pil'):
        alpha[:3] = 0
        alpha[3:5] = 64  # The overlay stays binary; the browser retains source opacity.
    if alpha_kind == 'transparent':
        alpha.fill(0)
    if alpha_kind == 'pil':
        alpha = Image.fromarray(alpha)
    readonly = [array.view() for array in inputs]
    for array in readonly:
        array.flags.writeable = False
    try:
        with collect() as direct_timings:
            expected = rp.render_page(FakeRenderer(), readonly[0], readonly[1], [], ['text'], 'en', readonly[2],
                                      alpha=alpha, **identity())
        with collect() as worker_timings:
            record('parent_work', .25)
            result = render(instance, inputs, alpha=alpha)
        assert result == expected and set(result) == {'result', 'output_bytes'}
        assert worker_timings.pop('parent_work') == .25
        assert set(worker_timings) == set(direct_timings) | {'render_cpu_wait'}
        assert 'render_layout' in worker_timings and 'render_diff' in worker_timings
        assert all(seconds >= 0 for seconds in worker_timings.values())
        if alpha_kind == 'transparent':
            assert result['result']['representation'] == 'original' and result['output_bytes'] is None
        else:
            with Image.open(BytesIO(result['output_bytes'])) as patch:
                assert set(np.asarray(patch.convert('RGBA'))[:, :, 3].ravel()) <= {0, 255}
        with collect() as next_timings:
            assert render(instance, inputs) == render(instance, inputs)
        assert 'parent_work' not in next_timings
        assert_removed(names)
    finally:
        if isinstance(alpha, Image.Image):
            alpha.close()


def test_empty_translations_skip_renderer_but_still_pack_cleaned_page(pool, inputs):
    instance, names = pool
    expected = rp.pack_result(inputs[1], inputs[0], None, **identity())
    with collect() as timings:
        result = instance.render(inputs[0], inputs[1], [], ['', '  \n'], 'error', inputs[2], **identity())
    assert result == expected and 'render_layout' in timings and 'render_encode' in timings
    assert_removed(names)


def test_large_page_preserves_output_limit_error_and_tile_contract(pool):
    instance, names = pool
    original = np.zeros((2, 17000, 3), np.uint8)
    cleaned, mask = np.full_like(original, 17), np.zeros(original.shape[:2], np.uint8)
    with collect() as failed_timings, pytest.raises(rp.NodeFailure, match='CLASSIC_OUTPUT_TOO_LARGE'):
        render(instance, (original, cleaned, mask))
    assert 'render_layout' in failed_timings
    assert_removed(names)
    result = render(instance, (original, cleaned, mask), allow_tiles=True)
    expected = cleaned.copy()
    expected[0, 0, 1] = 0
    assert result == rp.pack_result(expected, original, None, allow_tiles=True, **identity())
    assert result['result']['representation'] == 'overlay-tiles-v1'
    assert result['output_bytes'].startswith(b'NCOT0001')
    assert_removed(names)


@pytest.mark.parametrize('language,code', [('encode-error', 'CLASSIC_OUTPUT_ENCODE_FAILED'),
                                         ('unknown-node-error', 'CLASSIC_RENDER_WORKER_FAILED')])
def test_worker_only_forwards_whitelisted_output_errors(pool, inputs, language, code):
    instance, names = pool
    expected_type = rp.NodeFailure if language == 'encode-error' else rp.RenderPoolError
    with pytest.raises(expected_type) as failure:
        render(instance, inputs, language)
    assert failure.value.code == code
    assert 'PRIVATE_FIXTURE_DETAIL' not in ''.join(traceback.format_exception(failure.value))
    assert_removed(names)
    render(instance, inputs)


def test_local_page_cancel_after_layout_never_packs(monkeypatch, inputs):
    stopped = False

    def draw(*args, **kwargs):
        nonlocal stopped
        stopped = True
        return inputs[1]

    def check():
        if stopped:
            raise rp.NodeFailure('LEASE_STOPPED')

    monkeypatch.setattr(rp, 'pack_result', lambda *a, **k: pytest.fail('Cancelled local page reached encoding'))
    with collect() as timings, pytest.raises(rp.NodeFailure, match='LEASE_STOPPED'):
        rp.render_page(SimpleNamespace(render=draw), inputs[0], inputs[1], [], ['text'], 'en', inputs[2],
                       alpha=None, check_cancelled=check, **identity())
    assert set(timings) == {'render_layout'}


@pytest.mark.parametrize('alpha', [np.ones((8, 9), np.float32), np.ones((8, 9, 1), np.uint8)])
def test_invalid_alpha_fails_before_shared_allocation(pool, inputs, alpha):
    instance, names = pool
    with pytest.raises(rp.RenderPoolError, match='CLASSIC_RENDER_INPUT_INVALID'):
        render(instance, inputs, alpha=alpha)
    assert names == []


def test_cancel_drains_running_worker_before_unlink_and_preserves_error(pool, inputs, tmp_path):
    instance, names = pool
    instance.warmup()
    marker = tmp_path / 'started'
    cancellation = RuntimeError('cancelled by parent only')

    def check_cancelled():
        if marker.exists():
            raise cancellation

    started = time.monotonic()
    with pytest.raises(RuntimeError) as failure:
        instance.render(inputs[0], inputs[1], [{'started': str(marker)}], ['text'], 'slow', inputs[2],
                        check_cancelled=check_cancelled, **identity())
    assert failure.value is cancellation and marker.exists()
    assert time.monotonic() - started >= .28
    assert_removed(names)
    render(instance, inputs)


def test_close_joins_running_work_and_removes_shared_memory(pool, inputs, tmp_path):
    instance, names = pool
    instance.warmup()
    marker = tmp_path / 'started'
    with ThreadPoolExecutor(1) as threads:
        future = threads.submit(instance.render, inputs[0], inputs[1], [{'started': str(marker)}],
                                ['text'], 'slow', inputs[2], **identity())
        wait_until(marker.exists)
        instance.close()
        assert future.done()
        assert future.result()['result']['width'] == inputs[0].shape[1]
    assert_removed(names)
    instance.close()


def test_broken_pool_is_joined_and_next_call_rebuilds(pool, inputs):
    instance, names = pool
    instance.warmup()
    old = instance._pool
    processes = list(old._processes.values())
    with pytest.raises(rp.RenderPoolError, match='CLASSIC_RENDER_WORKER_FAILED'):
        render(instance, inputs, 'crash')
    assert instance._pool is None
    assert all(not process.is_alive() for process in processes)
    assert_removed(names)
    render(instance, inputs)
    assert instance._pool is not old


@pytest.mark.parametrize('failure_at', ['create', 'reserve'])
def test_ipc_allocation_failure_is_distinct_and_cleans_owned_segment(pool, inputs, monkeypatch, failure_at):
    instance, names = pool
    instance.warmup()

    def fail(*args, **kwargs):
        raise OSError('No shared-memory backing')

    def forbidden_views(*args, **kwargs):
        pytest.fail('No shared page may be touched until backing is reserved')

    with monkeypatch.context() as patch:
        patch.setattr(rp, 'SharedMemory' if failure_at == 'create' else '_reserve_backing', fail)
        patch.setattr(rp, '_views', forbidden_views)
        with pytest.raises(rp.RenderMemoryError) as failure:
            render(instance, inputs)
        assert failure.value.code == 'CLASSIC_RENDER_IPC_MEMORY'
    assert len(names) == (failure_at == 'reserve')
    assert_removed(names)
    render(instance, inputs)


def test_capacity_wait_remains_cancellable_without_allocating(pool, inputs):
    instance, names = pool
    for _ in range(instance.workers):
        instance._slots.acquire()
    calls = 0

    def check():
        nonlocal calls
        calls += 1
        if calls > 1:
            raise RuntimeError('cancel before allocation')

    try:
        with pytest.raises(RuntimeError, match='cancel before allocation'):
            render(instance, inputs, check_cancelled=check)
        assert not names
    finally:
        for _ in range(instance.workers):
            instance._slots.release()


def test_linux_reserves_exact_owned_backing_and_closes_descriptor(monkeypatch):
    calls = []
    reserve = SimpleNamespace(O_RDWR=2, open=lambda path, mode: calls.append(('open', path, mode)) or 29,
                              close=lambda descriptor: calls.append(('close', descriptor)))

    def allocate(descriptor, offset, size):
        calls.append(('allocate', descriptor, offset, size))
        raise OSError('tmpfs full')

    reserve.posix_fallocate = allocate
    reserve.path = posixpath
    monkeypatch.setattr(rp, 'sys', SimpleNamespace(platform='linux'))
    monkeypatch.setattr(rp, 'os', reserve)
    with pytest.raises(OSError, match='tmpfs full'):
        rp._reserve_backing(SimpleNamespace(name='psm_owned_fixture', size=720))
    assert calls == [('open', '/dev/shm/psm_owned_fixture', 2), ('allocate', 29, 0, 720), ('close', 29)]
    del reserve.posix_fallocate
    with pytest.raises(OSError, match='unavailable'):
        rp._reserve_backing(SimpleNamespace(name='psm_owned_fixture', size=720))


@pytest.mark.parametrize('cuda_initialized', [False, True])
@pytest.mark.parametrize('threads', [2, 3])
def test_initializer_enforces_cpu_limits_after_renderer_imports(monkeypatch, cuda_initialized, threads):
    calls = []
    native_limits = {}

    def set_limit(library, value):
        native_limits[library] = value
        calls.append((library, value))

    def is_cuda_initialized():
        calls.append(('cuda_check',))
        return cuda_initialized

    def renderer(models, fonts):
        calls.append(('renderer', models, fonts))
        set_limit('cv2', 0)  # Ultralytics' import resets the OpenCV process setting.
        return object()

    for key in ('CUDA_VISIBLE_DEVICES', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
        monkeypatch.setenv(key, 'before')
    monkeypatch.setattr(rp, 'Thread', lambda **kwargs: SimpleNamespace(start=lambda: None))
    monkeypatch.setattr(rp, '_renderer', None)
    monkeypatch.setattr(rp, '_startup_barrier', None)
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(
        set_num_threads=lambda value: set_limit('torch', value),
        cuda=SimpleNamespace(is_initialized=is_cuda_initialized)))
    monkeypatch.setitem(sys.modules, 'cv2', SimpleNamespace(setNumThreads=lambda value: set_limit('cv2', value)))
    monkeypatch.setitem(sys.modules, 'mtu_engine.engine', SimpleNamespace(Renderer=renderer))
    barrier = object()
    if cuda_initialized:
        with pytest.raises(rp.RenderPoolError, match='CLASSIC_RENDER_WORKER_INIT_FAILED'):
            rp._initialize('models', ('font',), threads, barrier)
    else:
        rp._initialize('models', ('font',), threads, barrier)
    assert calls == [('renderer', 'models', ('font',)), ('cv2', 0), ('torch', threads),
                     ('cv2', threads), ('cuda_check',)]
    assert native_limits == {'torch': threads, 'cv2': threads}
    assert os.environ['CUDA_VISIBLE_DEVICES'] == ''
    assert os.environ['OMP_NUM_THREADS'] == str(threads)
    assert rp._startup_barrier is (None if cuda_initialized else barrier)


@pytest.mark.parametrize('broken', [False, True])
def test_failed_warmup_only_aborts_live_barrier_before_join_and_can_retry(monkeypatch, broken):
    events = []

    def abort():
        assert not broken, 'A dead process can own the shared barrier lock forever'
        events.append('abort')

    barrier = SimpleNamespace(abort=abort)
    pool = rp.RenderPool('', (), 2, 1)
    monkeypatch.setattr(pool, '_context', SimpleNamespace(Barrier=lambda workers: barrier,
                                                       BoundedSemaphore=lambda _: object()))
    future = Future()
    future.set_exception(BrokenProcessPool('private initialization detail') if broken else KeyboardInterrupt())
    executor = SimpleNamespace(submit=lambda *args: future,
                               shutdown=lambda **kwargs: events.append(('shutdown', kwargs)))
    monkeypatch.setattr(rp, 'ProcessPoolExecutor', lambda *args, **kwargs: executor)
    with pytest.raises(rp.RenderPoolError) as failure:
        pool.warmup()
    assert failure.value.code == 'CLASSIC_RENDER_WORKER_INIT_FAILED'
    assert events == ([] if broken else ['abort']) + [('shutdown', {'wait': True, 'cancel_futures': True})]
    assert pool._pool is None
    ready = Future()
    ready.set_result(None)
    executor.submit = lambda *args: ready
    pool.warmup()
    pool.close()


def test_broken_future_does_not_unlink_before_generation_shutdown(pool, inputs, monkeypatch):
    instance, names = pool
    events = []
    failed = Future()
    failed.set_exception(BrokenProcessPool('peer process is still exiting'))
    executor = SimpleNamespace(submit=lambda *args: failed,
                               shutdown=lambda **kwargs: events.append('joined'))
    monkeypatch.setattr(instance, '_get_pool', lambda: executor)
    dispose = rp._dispose

    def verify_dispose(segment):
        assert events == ['joined']
        events.append('unlink')
        dispose(segment)

    monkeypatch.setattr(rp, '_dispose', verify_dispose)
    with pytest.raises(rp.RenderPoolError):
        render(instance, inputs)
    assert events == ['joined', 'unlink']
    assert_removed(names)


@pytest.mark.parametrize('wait_raises', [False, True])
def test_parent_sentinel_exit_is_fail_closed(monkeypatch, wait_raises):
    def exited(code):
        raise SystemExit(code)

    def wait(sentinels):
        assert sentinels == [41]
        if wait_raises:
            raise OSError('invalid sentinel')

    monkeypatch.setattr(rp, 'multiprocessing', SimpleNamespace(parent_process=lambda: SimpleNamespace(sentinel=41)))
    monkeypatch.setattr(rp, 'wait', wait)
    monkeypatch.setattr(rp, 'os', SimpleNamespace(_exit=exited))
    with pytest.raises(SystemExit) as failure:
        rp._watch_parent()
    assert failure.value.code == 1


def test_abrupt_parent_exit_stops_children_and_reclaims_shared_segment(tmp_path):
    script = '''
import json, os, sys, threading, time, psutil
from pathlib import Path
from test_render_pool import fake_initialize, identity
from classic_node import render_pool as rp
import numpy as np
rp._initialize = fake_initialize
pool = rp.RenderPool('unused', (), 2, 1)
pool.warmup()
names = []
shared_memory = rp.SharedMemory
def track(*args, **kwargs):
    segment = shared_memory(*args, **kwargs)
    if kwargs.get('create'): names.append(segment.name)
    return segment
rp.SharedMemory = track
image = np.zeros((8, 9, 3), np.uint8)
marker = Path(sys.argv[1])
threading.Thread(target=pool.render, args=(image, image, [{'started': str(marker)}], ['text'], 'linger', None), kwargs=identity(), daemon=True).start()
while not marker.exists(): time.sleep(.01)
print(json.dumps({'children': [(p.pid, psutil.Process(p.pid).create_time()) for p in pool._pool._processes.values()], 'names': names}), flush=True)
os._exit(0)
'''
    env = dict(os.environ)
    env['PYTHONPATH'] = os.pathsep.join((str(Path(__file__).parent), str(Path(__file__).parents[1]), env.get('PYTHONPATH', '')))
    process = subprocess.Popen([sys.executable, '-c', script, str(tmp_path / 'started')],
                               env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        output, error = process.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        output, error = process.communicate(timeout=5)
        pytest.fail(f'Parent/children did not exit: {error}')
    assert process.returncode == 0, error
    record = json.loads(output.strip().splitlines()[-1])

    def live_owned_children():
        children = []
        for pid, created in record['children']:
            try:
                child = psutil.Process(pid)
                if child.create_time() == created and child.status() != psutil.STATUS_ZOMBIE:
                    children.append(child)
            except psutil.NoSuchProcess:
                pass
        return children

    try:
        wait_until(lambda: not live_owned_children())
        wait_until(lambda: all(not Path('/dev/shm', name).exists() for name in record['names']))
        assert_removed(record['names'])
    finally:
        for child in live_owned_children():
            try:
                child.kill()
            except psutil.NoSuchProcess:
                pass


@pytest.mark.parametrize('workers,threads', [(0, 1), (True, 1), (2, 0), (2, False)])
def test_invalid_cpu_limits_rejected(workers, threads):
    with pytest.raises(ValueError):
        rp.RenderPool('', (), workers, threads)


def test_valid_larger_pool_count_is_not_artificially_capped():
    pool = rp.RenderPool('', (), 32, 1)
    pool.close()


@pytest.mark.parametrize('fail', [False, True])
def test_output_borrows_only_idle_cpu_slots_and_returns_them(monkeypatch, fail):
    slots = rp.BoundedSemaphore(6)
    monkeypatch.setattr(rp, '_cpu_slots', slots)
    monkeypatch.setattr(rp, '_cpu_width', 2)
    # A peer already occupies its two assigned CPU slots.
    slots.acquire()
    slots.acquire()
    try:
        with rp._working_cpu():
            with rp._output_cpu() as workers:
                assert workers == 4
                assert not slots.acquire(False)
                if fail:
                    raise ValueError('encode failed')
    except ValueError:
        assert fail
    assert all(slots.acquire(False) for _ in range(4))
    assert not slots.acquire(False)
    for _ in range(6):
        slots.release()


def test_partial_cpu_acquisition_is_released_on_interruption(monkeypatch):
    events = []
    def acquire():
        if events:
            raise KeyboardInterrupt()
        events.append('acquire')
    monkeypatch.setattr(rp, '_cpu_slots', SimpleNamespace(acquire=acquire, release=lambda: events.append('release')))
    monkeypatch.setattr(rp, '_cpu_width', 2)
    with pytest.raises(KeyboardInterrupt), rp._working_cpu():
        pytest.fail('must not start without a full CPU allocation')
    assert events == ['acquire', 'release']


@pytest.mark.parametrize('allow_tiles', [False, True])
def test_small_output_does_not_borrow_idle_peer_cpu_slots(inputs, allow_tiles):
    original, cleaned, mask = inputs
    for array in inputs:
        array.flags.writeable = False
    actual = rp.render_page(FakeRenderer(), original, cleaned, [], ['text'], 'en', mask,
        alpha=None, **identity(), allow_tiles=allow_tiles,
        output_budget=lambda: pytest.fail('serial small output must not block peers'))
    assert actual['output_bytes']
