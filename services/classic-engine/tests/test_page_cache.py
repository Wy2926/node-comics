from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import numpy as np

from classic_node.timing import collect
from mtu_engine.page_cache import _current, bgr, crop, normalized, page_images


def test_native_crop_conversion_and_exact_padding_reuse():
    source = np.zeros((200, 100, 3), np.uint8)
    points = np.arange(8).reshape(4, 2)
    calls = []
    def native(image, pts):
        calls.append('crop')
        return np.full((10, 20, 3), [1, 2, 3], np.uint8)
    with collect() as metrics, page_images(source):
        first = crop(source, points, native)
        assert crop(source, points.astype(float), native) is first
        blue = bgr(first)
        assert bgr(first) is blue and blue[0, 0].tolist() == [3, 2, 1]
        def prepare():
            calls.append('prepare')
            return np.ones((3, 48, 30), np.float32)
        padded = normalized(blue, 2., (3, 48, 320), prepare)
        assert normalized(blue, 2., (3, 48, 320), prepare) is padded
        assert normalized(blue, 3., (3, 48, 320), prepare) is not padded
        assert not first.flags.writeable and not padded.flags.writeable
    assert calls == ['crop', 'prepare', 'prepare']
    assert metrics['analysis_image_cache_hits'] == 3
    assert _current.get() is None


def test_budget_and_failure_release_and_cross_page_isolation():
    image = np.ones((10, 10, 3), np.uint8)
    barrier = Barrier(2)
    def run(_):
        with page_images(image):
            state = _current.get()
            first = bgr(image)
            # Input ownership and converted buffer exceed this tiny budget.
            assert state['used'] == 0
            assert bgr(image) is not first
            barrier.wait(timeout=5)
            return state
    with ThreadPoolExecutor(2) as pool:
        left, right = list(pool.map(run, range(2)))
    assert left is not right and not left and not right
