"""Paragraph sampling with Comic Translate; language scoring owned by MOT."""
import importlib.util
from pathlib import Path
import numpy as np

class ScriptRouter:
    def __init__(self, models, probes):
        spec = importlib.util.spec_from_file_location('mot_native',
            Path(models).parent / 'upstream/mot/ocr.py')
        self.native = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.native)
        self.native.DETECT_CANDIDATES = ['en', 'japan', 'korean', 'ch']
        self.native._WEIGHTS['en'] = self.native._WEIGHTS['es']
        self.probes = probes

    def choose(self, predictions):
        native = self.native
        accepted = {lang: [row] if row['text'].strip() and row['conf'] >= .5 else []
                    for lang, row in predictions.items()}
        # Reject absent script evidence before the upstream first-candidate tie
        # default. Classification weights and character categories stay upstream.
        if not any(native._WEIGHTS[lang].get(native._script(char), 0) > 0
                   for lang, rows in accepted.items() for row in rows for char in row['text']):
            return None
        native._ocr_lines = lambda image, lang, retry=False: accepted[lang]
        try:
            return native.detect_lang(np.zeros((1, 1, 3), dtype=np.uint8))
        finally:
            native._ocr_lines = None  # Do not retain private text between pages.

    def classify(self, image, blocks):
        from modules.detection.script_detection import _largest_line_crop
        from modules.utils.textblock import TextBlock
        crops, indices = [], []
        routes = [None] * len(blocks)
        for index, block in enumerate(blocks):
            candidate = TextBlock(text_bbox=block.xyxy, lines=np.asarray(block.lines).tolist(),
                                  direction='vertical' if block.src_is_vertical else 'horizontal')
            crop, direction = _largest_line_crop(image, candidate)
            if crop is None or not crop.size:
                continue
            crops.append(np.rot90(crop) if direction == 'vertical' else crop)
            indices.append(index)
        if crops:
            results = {lang: model.probe(crops) for lang, model in self.probes.items()}
            for offset, index in enumerate(indices):
                routes[index] = self.choose({
                    'en': results['en'][offset], 'korean': results['korean'][offset],
                    'ch': results['ch'][offset], 'japan': results['ch'][offset]})
        return routes
