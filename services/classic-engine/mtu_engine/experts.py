"""Local-only upstream paragraph recognition for Japanese manga."""
from pathlib import Path
from threading import Lock

import numpy as np
from PIL import Image

from classic_node.timing import waiting_for


class Japanese:
    def __init__(self, models, gpu):
        from loguru import logger
        logger.disable('manga_ocr')
        from manga_ocr import MangaOcr
        directory = Path(models) / 'manga'
        for name in ('config.json', 'preprocessor_config.json', 'tokenizer_config.json',
                     'vocab.txt', 'pytorch_model.bin'):
            if not (directory / name).is_file():
                raise ValueError('Missing prepared Manga OCR assets; runtime downloads are disabled')
        self.model = MangaOcr(str(directory))
        if self.model.model.device.type != 'cuda' or self.model.model.device.index != gpu:
            raise RuntimeError('Manga OCR requires the configured CUDA device')
        self._lock = Lock()

    def recognize(self, image, blocks, groups):
        height, width = image.shape[:2]
        for block, lines in zip(blocks, groups, strict=True):
            for line in lines:
                line.text, line.prob = '', 0.  # Manga OCR exposes no confidence.
            left, top, right, bottom = np.asarray(block.xyxy, dtype=int)
            left, right = np.clip([left, right], 0, width)
            top, bottom = np.clip([top, bottom], 0, height)
            if lines and right > left and bottom > top:
                # Read a complete paragraph without rotating vertical columns.
                # Keep all original polygons for masking and checkpointing.
                crop = Image.fromarray(image[top:bottom, left:right])
                with waiting_for(self._lock, 'ocr_lock_wait'):
                    text = self.model(crop)
                lines[0].text = text

    def close(self):
        self.model = None
