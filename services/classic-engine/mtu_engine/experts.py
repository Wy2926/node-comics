"""Local-only upstream Chinese and Japanese recognizers, without OCR heuristics."""
import logging
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from .ocr import OCR_BATCH_SIZE, valid_crop


class Chinese:
    def __init__(self, models, gpu, crop):
        import yaml
        from importlib.util import find_spec
        import sys
        # OpenOCR uses absolute tools.* imports. Coexist with our preparation /
        # validation CLI's tools package without rewriting either upstream file.
        package = Path(find_spec('openocr').origin).parent
        if str(package) not in sys.path:
            sys.path.append(str(package))
        import tools
        native_tools = str(package / 'tools')
        if native_tools not in tools.__path__:
            tools.__path__ = [native_tools, *tools.__path__]
        from openocr.tools.infer_rec import OpenRecognizer, logger
        logger.handlers = [logging.NullHandler()]
        logger.propagate = False
        logger.setLevel(logging.CRITICAL + 1)
        directory = Path(models)
        weights = directory / 'openocr/openocr_svtrv2_ch.pth'
        if not weights.is_file():
            raise ValueError('Missing prepared OpenOCR model; runtime downloads are disabled')
        config = yaml.safe_load((directory.parent / 'upstream/openocr/svtrv2_ch.yml').read_text(encoding='utf-8'))
        config['Global']['pretrained_model'] = str(weights)
        self.model = OpenRecognizer(config=config, mode='server', backend='torch', use_gpu='true', numId=gpu)
        if self.model.device.type != 'cuda' or self.model.device.index != gpu:
            raise RuntimeError('OpenOCR requires the configured CUDA device')
        self.crop = crop

    async def recognize(self, image, lines, config):
        crops, valid = [], []
        for line in lines:
            line.text, line.prob = '', 0.
            crop = self.crop(image, line.pts)
            if not valid_crop(crop):
                continue
            crops.append(cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
            valid.append(line)
        if crops:
            results = self.model(img_numpy_list=crops, batch_num=OCR_BATCH_SIZE)
            for line, row in zip(valid, results, strict=True):
                line.prob = float(row['score'])
                line.text = row['text'] if line.prob >= config.prob else ''
        return lines

    def close(self):
        self.model = self.crop = None


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
                lines[0].text = self.model(Image.fromarray(image[top:bottom, left:right]))

    def close(self):
        self.model = None
