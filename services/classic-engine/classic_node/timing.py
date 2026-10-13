"""Per-operation node diagnostics; never part of image or analysis identity."""
from contextlib import contextmanager
from contextvars import ContextVar
from threading import Lock
from time import perf_counter


current = ContextVar('image_timings', default=None)

# The deployed v3 center rejects unknown timing keys. Detailed local diagnostics
# must not silently extend that wire contract (or become image identity).
WIRE_FIELDS = frozenset(('download', 'download_queue', 'analyze', 'analyze_queue',
    'inpaint', 'inpaint_queue', 'render', 'render_queue', 'analysis_submit', 'text_wait',
    'local_total', 'output_put', 'render_areas', 'render_layout', 'render_diff',
    'render_encode', 'detect_lock_wait', 'ocr_lock_wait', 'inpaint_lock_wait'))


@contextmanager
def collect(fields=None):
    """Collect all offline metrics, or only the requested production fields."""
    values, lock = {}, Lock()
    token = current.set((values, lock, fields))
    try:
        yield values
    finally:
        current.reset(token)


def _target(name):
    target = current.get()
    if target is not None and (target[2] is None or name in target[2]):
        return target


def record(name, seconds, *, maximum=False):
    target = _target(name)
    if target is not None:
        values, lock, _ = target
        with lock:
            values[name] = max(values.get(name, 0.), seconds) if maximum else values.get(name, 0.) + seconds


@contextmanager
def stage(name):
    """Wall time, including any native synchronization inside the operation."""
    if _target(name) is None:
        yield
        return
    start = perf_counter()
    try:
        yield
    finally:
        record(name, perf_counter() - start)


@contextmanager
def waiting_for(lock, name):
    start = perf_counter() if _target(name) is not None else None
    lock.acquire()
    try:
        if start is not None:
            record(name, perf_counter() - start)
        yield
    finally:
        lock.release()
