from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from threading import Lock

from manhua_engine.timing import collect, record, waiting_for


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
