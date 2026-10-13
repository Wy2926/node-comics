from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from threading import Lock

import pytest

from classic_node import timing
from classic_node.timing import WIRE_FIELDS, collect, record, stage, waiting_for


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


def test_batch_gauges_keep_maximum_instead_of_sum_across_calls():
    with collect() as values:
        for batch in (4, 2, 1):
            record('ocr_batch_max', batch, maximum=True)
            record('ocr_batches', 1)
    assert values == {'ocr_batch_max': 4, 'ocr_batches': 3}


def test_filtered_metrics_skip_clock_and_statistics_lock_but_keep_model_lock(monkeypatch):
    class StatisticsLock:
        def __enter__(self):
            raise AssertionError('Filtered metrics must not acquire the statistics lock')
        def __exit__(self, *args):
            pass
    def unexpected_clock():
        raise AssertionError('Filtered metrics must not read the clock')
    monkeypatch.setattr(timing, 'Lock', StatisticsLock)
    monkeypatch.setattr(timing, 'perf_counter', unexpected_clock)
    model_lock = Lock()
    with collect(WIRE_FIELDS) as values:
        record('ocr_batches', 1)
        record('ocr_batch_max', 4, maximum=True)
        with stage('ocr_infer'):
            pass
        with pytest.raises(ValueError, match='fixture'):
            with waiting_for(model_lock, 'offline_lock_wait'):
                assert model_lock.locked()
                raise ValueError('fixture')
    assert not model_lock.locked() and values == {}
    with stage('outside_collector'):
        pass


def test_offline_collection_nests_without_changing_production_filter():
    with collect(WIRE_FIELDS) as production:
        record('ocr_batches', 100)
        with collect() as offline:
            record('ocr_batches', 2)
            with stage('ocr_infer'):
                pass
        record('ocr_batches', 100)
        with stage('ocr_lock_wait'):
            pass
    assert set(production) == {'ocr_lock_wait'}
    assert production['ocr_lock_wait'] >= 0
    assert offline['ocr_batches'] == 2 and offline['ocr_infer'] >= 0
    assert timing.current.get() is None
