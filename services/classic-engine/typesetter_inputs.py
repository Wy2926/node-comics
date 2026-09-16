"""Supply validated page geometry to upstream's cached-bubble input boundary.

The renderer does not run detection or fetch models. Node Comics supplies its
existing bubble masks after removing protected source text and page margins.
"""
from contextvars import ContextVar
from dataclasses import dataclass
import numpy as np


@dataclass
class BubbleInput:
    mask: np.ndarray
    detections: tuple = ()


current_bubbles = ContextVar('typesetter_bubbles', default=None)


def get_cached_bubbles_with_mangalens(image, **kwargs):
    value = current_bubbles.get()
    if value is None or value.mask.shape != image.shape[:2]:
        raise ValueError('Missing validated typesetter geometry')
    return value


def build_bubble_mask_from_mangalens_result(value, shape):
    if value.mask.shape != tuple(shape):
        raise ValueError('Invalid typesetter geometry shape')
    return value.mask.copy()
