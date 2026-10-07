"""Bounded CPU page workers; the parent owns each shared input buffer."""
from concurrent.futures import ProcessPoolExecutor, TimeoutError
from concurrent.futures.process import BrokenProcessPool
import multiprocessing
from multiprocessing.connection import wait
from multiprocessing.shared_memory import SharedMemory
import os
import sys
from threading import BoundedSemaphore, Condition, Lock, Thread
from time import perf_counter

from .protocol import NodeFailure, pack_result
from .timing import collect, record


_OUTPUT_ERRORS = {'CLASSIC_OUTPUT_TOO_LARGE', 'CLASSIC_OUTPUT_ENCODE_FAILED'}


class RenderPoolError(RuntimeError):
    def __init__(self, code='CLASSIC_RENDER_WORKER_FAILED'):
        self.code = code
        super().__init__(code)


class RenderMemoryError(RenderPoolError):
    def __init__(self):
        super().__init__('CLASSIC_RENDER_IPC_MEMORY')


def ipc_bytes(width, height):
    """RGB original, RGB cleaned, bubble mask and source alpha; no RGB return copy."""
    return int(width) * int(height) * 8


def render_page(renderer, original, cleaned, regions, translations, language, bubble_mask, *,
                alpha, version, analysis, translated, allow_tiles=False, mask_cache_bytes=None,
                check_cancelled=None):
    """The same whole-page operation serves child workers and local fallback."""
    import numpy as np
    started = perf_counter()
    try:
        rendered = renderer.render(original, cleaned, regions, translations, language, bubble_mask,
                                   mask_cache_bytes=mask_cache_bytes) if any(text.strip() for text in translations) else cleaned
    finally:
        record('render_layout', perf_counter() - started)
    if check_cancelled is not None:
        check_cancelled()
    if not isinstance(rendered, np.ndarray) or rendered.shape != original.shape or rendered.dtype != np.uint8:
        raise RenderPoolError()
    return pack_result(rendered, original, alpha, version, analysis, translated, allow_tiles=allow_tiles)


_renderer = None
_startup_barrier = None


def _watch_parent():
    parent = multiprocessing.parent_process()
    if parent is not None:
        # A kernel sentinel avoids PID reuse and also handles watchdog os._exit.
        try:
            wait([parent.sentinel])
        finally:
            os._exit(1)


def _initialize(models, fonts, threads, barrier):
    global _renderer, _startup_barrier
    Thread(target=_watch_parent, name='render-parent', daemon=True).start()
    try:
        os.environ['CUDA_VISIBLE_DEVICES'] = ''
        for name in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
            os.environ[name] = str(threads)
        from mtu_engine.engine import Renderer
        import cv2
        import torch
        _renderer = Renderer(models, fonts)
        # Renderer imports can change native limits; enforce the assigned budget
        # after those imports and reject any accidental device initialization.
        torch.set_num_threads(threads)
        cv2.setNumThreads(threads)
        if torch.cuda.is_initialized():
            raise RuntimeError('Render workers must remain CPU-only')
        _startup_barrier = barrier
    except BaseException:
        # ProcessPoolExecutor prints initializer failures: never forward originals.
        raise RenderPoolError('CLASSIC_RENDER_WORKER_INIT_FAILED') from None


def _ready():
    # One blocked startup task per worker ensures all persistent renderers exist
    # before warmup returns, rather than letting one process consume every probe.
    _startup_barrier.wait()


def _views(segment, shape):
    import numpy as np
    height, width = shape
    pixels = height * width
    return {
        'original': np.ndarray((height, width, 3), np.uint8, buffer=segment.buf),
        'cleaned': np.ndarray((height, width, 3), np.uint8, buffer=segment.buf, offset=pixels * 3),
        'mask': np.ndarray((height, width), np.uint8, buffer=segment.buf, offset=pixels * 6),
        'alpha': np.ndarray((height, width), np.uint8, buffer=segment.buf, offset=pixels * 7),
    }


def _render_shared(name, shape, regions, translations, language, mask_cache_bytes, has_alpha,
                   version, analysis, translated, allow_tiles):
    segment, arrays, packed, timings, error_code = None, {}, None, {}, None
    try:
        segment = SharedMemory(name=name)
        arrays = _views(segment, shape)
        for value in arrays.values():
            value.flags.writeable = False
        del value
        with collect() as timings:
            packed = render_page(_renderer, arrays['original'], arrays['cleaned'], regions,
                translations, language, arrays['mask'], alpha=arrays['alpha'] if has_alpha else None,
                version=version, analysis=analysis, translated=translated,
                allow_tiles=allow_tiles, mask_cache_bytes=mask_cache_bytes)
    except NodeFailure as error:
        error_code = error.code if error.code in _OUTPUT_ERRORS else 'CLASSIC_RENDER_WORKER_FAILED'
    except BaseException:
        error_code = 'CLASSIC_RENDER_WORKER_FAILED'
    finally:
        # Drop traceback and ndarray references before closing the mapping.
        arrays.clear()
        if segment is not None:
            segment.close()
    # Never pickle original exceptions, tracebacks, or image arrays. Operational
    # timing is transported separately from the immutable protocol result.
    return {'packed': packed, 'timings': timings, 'error_code': error_code}


def _reserve_backing(segment):
    if sys.platform == 'linux':
        # ftruncate alone succeeds on an almost-full tmpfs; a subsequent NumPy
        # store could SIGBUS the parent. Reserve this newly owned object first.
        allocate = getattr(os, 'posix_fallocate', None)
        if allocate is None:
            raise OSError('Shared-memory backing reservation is unavailable')
        descriptor = os.open(os.path.join('/dev/shm', segment.name), os.O_RDWR)
        try:
            allocate(descriptor, 0, segment.size)
        finally:
            os.close(descriptor)


def _dispose(segment):
    try:
        segment.close()
    finally:
        segment.unlink()


def _shutdown(pool):
    while True:
        try:
            pool.shutdown(wait=True, cancel_futures=True)
            return
        except (KeyboardInterrupt, SystemExit):
            # Shared buffers must outlive workers even during an interrupted exit.
            continue


def _drain(future):
    future.cancel()
    while True:
        try:
            future.result()
            return False
        except BrokenProcessPool:
            return True
        except BaseException:
            if future.done():
                return False


class RenderPool:
    def __init__(self, models, fonts, workers, threads):
        if type(workers) is not int or workers < 1 or type(threads) is not int or threads < 1:
            raise ValueError('Invalid render worker or CPU thread count')
        self.models, self.fonts = str(models), tuple(map(str, fonts))
        self.workers, self.threads = workers, threads
        self._context = multiprocessing.get_context('spawn')
        self._pool = None
        self._lifecycle = Lock()
        self._state = Condition()
        self._slots = BoundedSemaphore(workers)
        self._active = 0
        self._closed = False

    def _get_pool(self):
        with self._lifecycle:
            if self._closed:
                raise RenderPoolError('CLASSIC_RENDER_POOL_CLOSED')
            if self._pool is None:
                barrier = self._context.Barrier(self.workers)
                pool = ProcessPoolExecutor(self.workers, mp_context=self._context, initializer=_initialize,
                                           initargs=(self.models, self.fonts, self.threads, barrier))
                try:
                    futures = [pool.submit(_ready) for _ in range(self.workers)]
                    for future in futures:
                        future.result()
                except BaseException as error:
                    if not isinstance(error, BrokenProcessPool):
                        # Cancelled startup probes must release their live peers.
                        # A dead worker may own this lock forever; a broken pool
                        # already terminates every peer, so never touch its barrier.
                        barrier.abort()
                    _shutdown(pool)
                    raise RenderPoolError('CLASSIC_RENDER_WORKER_INIT_FAILED') from None
                self._pool = pool
            return self._pool

    def _retire(self, pool):
        with self._lifecycle:
            if self._pool is pool:
                self._pool = None
            # BrokenProcessPool may mark a future done before killing its peers.
            # Joining the whole generation makes unlink safe for every caller.
            _shutdown(pool)

    def warmup(self):
        self._get_pool()

    def render(self, original, cleaned, regions, translations, language, bubble_mask, *,
               alpha=None, version, analysis, translated, allow_tiles=False,
               mask_cache_bytes=None, check_cancelled=None):
        import numpy as np
        has_alpha = alpha is not None
        if has_alpha:
            alpha = np.asarray(alpha)
        if (not isinstance(original, np.ndarray) or original.ndim != 3 or original.shape[2] != 3
                or original.dtype != np.uint8 or min(original.shape[:2]) <= 0
                or not isinstance(cleaned, np.ndarray) or cleaned.shape != original.shape or cleaned.dtype != np.uint8
                or (bubble_mask is not None and (not isinstance(bubble_mask, np.ndarray)
                    or bubble_mask.shape != original.shape[:2] or bubble_mask.dtype != np.uint8))
                or (alpha is not None and (alpha.shape != original.shape[:2] or alpha.dtype != np.uint8))):
            raise RenderPoolError('CLASSIC_RENDER_INPUT_INVALID')
        if check_cancelled is not None:
            check_cancelled()
        while not self._slots.acquire(timeout=.05):
            if check_cancelled is not None:
                check_cancelled()
            with self._state:
                if self._closed:
                    raise RenderPoolError('CLASSIC_RENDER_POOL_CLOSED')
        with self._state:
            if self._closed:
                self._slots.release()
                raise RenderPoolError('CLASSIC_RENDER_POOL_CLOSED')
            self._active += 1
        segment, arrays, future, pool = None, {}, None, None
        try:
            pool = self._get_pool()
            if check_cancelled is not None:
                check_cancelled()
            try:
                segment = SharedMemory(create=True, size=ipc_bytes(original.shape[1], original.shape[0]))
                _reserve_backing(segment)
            except (OSError, MemoryError):
                raise RenderMemoryError() from None
            arrays = _views(segment, original.shape[:2])
            np.copyto(arrays['original'], original)
            np.copyto(arrays['cleaned'], cleaned)
            if bubble_mask is None:
                arrays['mask'].fill(0)
            else:
                np.copyto(arrays['mask'], bubble_mask)
            if alpha is None:
                arrays['alpha'].fill(255)
            else:
                np.copyto(arrays['alpha'], alpha)
            alpha = None  # Release a temporary Pillow-to-array copy before waiting on the child.
            with self._lifecycle:
                if self._closed:
                    raise RenderPoolError('CLASSIC_RENDER_POOL_CLOSED')
                try:
                    future = pool.submit(_render_shared, segment.name, original.shape[:2], regions,
                                         translations, language, mask_cache_bytes, has_alpha,
                                         version, analysis, translated, allow_tiles)
                except (BrokenProcessPool, RuntimeError):
                    # Retire outside this non-reentrant lifecycle lock.
                    pass
            if future is None:
                self._retire(pool)
                raise RenderPoolError() from None
            while True:
                if check_cancelled is not None:
                    check_cancelled()
                try:
                    reply = future.result(timeout=.05)
                    break
                except TimeoutError:
                    continue
                except Exception:
                    raise RenderPoolError() from None
            if check_cancelled is not None:
                check_cancelled()
            for name, seconds in reply['timings'].items():
                record(name, seconds)
            if reply['error_code'] is not None:
                if reply['error_code'] in _OUTPUT_ERRORS:
                    raise NodeFailure(reply['error_code'])
                raise RenderPoolError()
            return reply['packed']
        finally:
            try:
                if future is not None and _drain(future):
                    self._retire(pool)
                arrays.clear()
                if segment is not None:
                    _dispose(segment)
            finally:
                with self._state:
                    self._active -= 1
                    self._state.notify_all()
                self._slots.release()

    def close(self):
        with self._lifecycle:
            with self._state:
                self._closed = True
            if self._pool is not None:
                pool, self._pool = self._pool, None
                _shutdown(pool)
        with self._state:
            while self._active:
                self._state.wait()
