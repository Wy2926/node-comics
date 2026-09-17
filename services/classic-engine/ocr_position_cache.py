"""Bounded exact XPOS constants shared across one CPU/CUDA OCR model.

Math derived from MIT's pinned ocr/xpos_relative_position.py (Microsoft 2022,
MIT license notice in that file). Retain CPU construction and operation order
on cache misses so this changes neither weights nor positional arithmetic.
"""
from collections import OrderedDict
import types
import weakref

import torch
from manga_translator.ocr.xpos_relative_position import (
    XPOS, fixed_pos_embedding, duplicate_interleave, rotate_every_two,
)


class PositionCache:
    def __init__(self, network, max_bytes=32 * 1024**2, max_entries=2048):
        self.max_bytes, self.max_entries = max_bytes, max_entries
        self.entries = OrderedDict()
        self.signatures = weakref.WeakKeyDictionary()
        self.size = self.hits = self.misses = 0
        self.originals = []
        for module in network.modules():
            if isinstance(module, XPOS):
                original = module.forward
                self.originals.append((module, original))
                def forward(current, x, offset=0, downscale=False, original=original):
                    if torch.is_grad_enabled() or x.device.type not in ('cpu', 'cuda'):
                        return original(x, offset, downscale)
                    sin, cos = self.constants(current, x, offset, downscale)
                    return (x * cos) + (rotate_every_two(x) * sin)
                module.forward = types.MethodType(forward, module)

    def constants(self, module, x, offset, downscale):
        buffer = module.scale
        # Recompute identity if buffers move, change dtype or are edited in place.
        stamp = (buffer.data_ptr(), buffer._version, str(buffer.device), buffer.dtype)
        previous = self.signatures.get(module)
        if previous is None or previous[0] != stamp:
            signature = tuple(buffer.detach().cpu().tolist())
            self.signatures[module] = stamp, signature
        else:
            signature = previous[1]
        length = x.shape[1]
        key = (str(buffer.device), buffer.dtype, x.dtype, signature, module.scale_base,
               length, offset, downscale)
        if key in self.entries:
            self.hits += 1
            self.entries.move_to_end(key)
            return self.entries[key]
        self.misses += 1
        min_pos = -(length + offset) // 2
        max_pos = length + offset + min_pos
        scale = buffer ** torch.arange(min_pos, max_pos, 1).to(buffer).div(module.scale_base)[:, None]
        sin, cos = fixed_pos_embedding(scale)
        if scale.shape[0] > length:
            scale, sin, cos = scale[-length:], sin[-length:], cos[-length:]
        if downscale:
            scale = 1 / scale
        value = (duplicate_interleave(sin * scale), duplicate_interleave(cos * scale))
        cost = sum(t.numel() * t.element_size() for t in value)
        if cost <= self.max_bytes and self.max_entries > 0:
            while self.entries and (self.size + cost > self.max_bytes or len(self.entries) >= self.max_entries):
                _, removed = self.entries.popitem(last=False)
                self.size -= sum(t.numel() * t.element_size() for t in removed)
            self.entries[key] = value
            self.size += cost
        return value

    def describe(self):
        return {'bytes': self.size, 'max_bytes': self.max_bytes, 'entries': len(self.entries),
                'hits': self.hits, 'misses': self.misses}

    def close(self):
        for module, original in self.originals:
            module.forward = original
        self.originals.clear()
        self.entries.clear()
        self.signatures.clear()
        self.size = 0
