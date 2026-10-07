from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from threading import Lock

import pytest

from classic_node.timing import collect, measured, record, waiting_for


def test_collector_isolates_pages_and_accumulates_ocr_workers():
    with ThreadPoolExecutor(4) as pool:
        with collect() as first:
            jobs = [pool.submit(copy_context().run, record, 'ocr_lock_wait', .25) for _ in range(8)]
            for job in jobs:
                job.result()
        with collect() as second:
            record('ocr_lock_wait', .5)
    record('ocr_lock_wait', 100)
    assert first == {'ocr_lock_wait': 2.}
    assert second == {'ocr_lock_wait': .5}


def test_timed_lock_releases_on_failure():
    lock = Lock()
    with collect() as values:
        try:
            with waiting_for(lock, 'inpaint_lock_wait'):
                raise ValueError('fixture')
        except ValueError:
            pass
    assert not lock.locked() and values['inpaint_lock_wait'] >= 0


def test_measured_accumulates_calls_and_records_failure(monkeypatch):
    clock = iter((1., 1.25, 2., 2.5, 3., 4.))
    monkeypatch.setattr('classic_node.timing.perf_counter', lambda: next(clock))
    with collect() as values:
        with measured('analyze_bubbles'):
            pass
        with pytest.raises(ValueError, match='fixture'):
            with measured('analyze_bubbles'):
                raise ValueError('fixture')
    with measured('analyze_bubbles'):
        pass  # No collector: must not leak into the previous page.
    assert values == {'analyze_bubbles': .75}


def test_nested_measurement_does_not_add_substage_time_to_parent(monkeypatch):
    clock = iter((10., 11., 13., 17.))
    monkeypatch.setattr('classic_node.timing.perf_counter', lambda: next(clock))
    with collect() as values:
        with measured('analyze'):
            with measured('analyze_ocr'):
                pass
    assert values == {'analyze': 7., 'analyze_ocr': 2.}
