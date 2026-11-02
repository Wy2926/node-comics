"""Selectable paragraph OCR; importing this module loads no model runtime."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Reading:
    texts: list[str]
    language: str | None = None
    line_aligned: bool = False


def create(name, models, gpu=0, threads=2, *, batch_size, backend='cuda', model=None, **options):
    if name == 'classic':
        from .classic import ClassicOCR
        return ClassicOCR(models, gpu, threads, backend=backend, batch_size=batch_size, **options)
    if name == 'hayai':
        from .hayai import HayaiOCR
        return HayaiOCR(model, gpu, backend=backend, batch_size=batch_size)
    raise ValueError('ocr_backend must be classic or hayai')
