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
def collect():
    values, lock = {}, Lock()
    token = current.set((values, lock))
    try:
        yield values
    finally:
        current.reset(token)


def record(name, seconds):
    target = current.get()
    if target is not None:
        values, lock = target
        with lock:
            values[name] = values.get(name, 0.) + seconds


@contextmanager
def stage(name):
    """Wall time, including any native synchronization inside the operation."""
    start = perf_counter()
    try:
        yield
    finally:
        record(name, perf_counter() - start)


@contextmanager
def waiting_for(lock, name):
    start = perf_counter()
    lock.acquire()
    try:
        record(name, perf_counter() - start)
        yield
    finally:
        lock.release()
