"""Bounded, analysis-local reuse of identical native crops and preprocessing."""
from contextlib import contextmanager
from contextvars import ContextVar

import cv2
import numpy as np

from classic_node.timing import record

_current = ContextVar('analysis_images', default=None)


@contextmanager
def page_images(image):
    # Working-memory allowance, not an unbounded cache of every detected line.
    state = {'image': image, 'entries': {}, 'owned': set(), 'used': 0, 'limit': image.nbytes}
    token = _current.set(state)
    try:
        yield
    finally:
        record('analysis_image_cache_bytes', state['used'])
        state.clear()
        _current.reset(token)


def _reuse(key, calculate, owner=None):
    state = _current.get()
    if state is None:
        return calculate()
    item = state['entries'].get(key)
    if item is not None:
        record('analysis_image_cache_hits', 1)
        return item[1]
    value = calculate()
    record('analysis_image_cache_misses', 1)
    owner_bytes = owner.nbytes if owner is not None and id(owner) not in state['owned'] else 0
    if value is not None and state['used'] + value.nbytes + owner_bytes <= state['limit']:
        if not value.flags.owndata:
            value = value.copy()
        value.flags.writeable = False
        # Keep identity-keyed inputs alive; ids must not be recycled within a page.
        state['entries'][key] = (owner, value)
        state['used'] += value.nbytes + owner_bytes
        state['owned'].add(id(value))
        if owner is not None:
            state['owned'].add(id(owner))
    return value


def crop(image, points, calculate):
    state = _current.get()
    if state is None or state['image'] is not image:
        return calculate(image, points)
    polygon = np.asarray(points, dtype=np.float64)
    return _reuse(('crop', polygon.shape, polygon.tobytes()), lambda: calculate(image, points))


def bgr(image):
    return _reuse(('bgr', id(image)), lambda: cv2.cvtColor(image, cv2.COLOR_RGB2BGR), image)


def normalized(image, ratio, shape, calculate):
    # Batch padding is part of the key. Different long-line batches never share
    # tensors just because the unpadded crop matches.
    return _reuse(('paddle', id(image), float(ratio), tuple(shape)), calculate, image)
