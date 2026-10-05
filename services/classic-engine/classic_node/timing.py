"""Per-operation node diagnostics; never part of image or analysis identity."""
from contextlib import contextmanager
from contextvars import ContextVar
from threading import Lock
from time import perf_counter


current = ContextVar('image_timings', default=None)


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
def waiting_for(lock, name):
    start = perf_counter()
    lock.acquire()
    try:
        record(name, perf_counter() - start)
        yield
    finally:
        lock.release()
