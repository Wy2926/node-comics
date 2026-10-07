"""Upstream largest-line selection and scoring with shared MTU OCR crops."""
import importlib.util
from pathlib import Path
from threading import Lock
import numpy as np

from classic_node.timing import waiting_for
from .ocr import short_crop, valid_crop

class ScriptRouter:
    def __init__(self, models, probes):
        spec = importlib.util.spec_from_file_location('mot_native',
            Path(models).parent / 'upstream/mot/ocr.py')
        self.native = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.native)
        self.native.DETECT_CANDIDATES = ['en', 'japan', 'korean', 'ch']
        self.native._WEIGHTS['en'] = self.native._WEIGHTS['es']
        self.probes = probes
        self._score_lock = Lock()

    def choose(self, predictions):
        native = self.native
        accepted = {lang: [row] if row['text'].strip() and row['conf'] >= .5 else []
                    for lang, row in predictions.items()}
        # Reject absent script evidence before the upstream first-candidate tie
        # default. Classification weights and character categories stay upstream.
        if not any(native._WEIGHTS[lang].get(native._script(char), 0) > 0
                   for lang, rows in accepted.items() for row in rows for char in row['text']):
            return None
        # Only the scoring bridge mutates the shared upstream module. Crops and
        # GPU probes stay outside this short CPU-only critical section.
        with waiting_for(self._score_lock, 'ocr_lock_wait'):
            native._ocr_lines = lambda image, lang, retry=False: accepted[lang]
            try:
                return native.detect_lang(np.zeros((1, 1, 3), dtype=np.uint8))
            finally:
                native._ocr_lines = None  # Do not retain private text between pages.

    def classify(self, image, blocks, groups):
        from modules.detection.script_detection import _line_area
        crops, indices = [], []
        routes = [None] * len(blocks)
        readings = [None] * len(blocks)
        for index, block in enumerate(blocks):
            if not len(block.lines):
                continue
            line_index = max(range(len(block.lines)), key=lambda i: _line_area(block.lines[i]))
            # The same perspective crop/vertical rotation as formal recognition;
            # retain upstream largest-line selection without a second detector.
            crop = self.probes['ch'].recognizer.crop(image, groups[index][line_index].pts)
            if not valid_crop(crop):
                continue
            crops.append(crop)
            indices.append((index, line_index))
        if crops:
            results = {lang: model.probe(crops) for lang, model in self.probes.items()}
            for offset, (index, line_index) in enumerate(indices):
                routes[index] = self.choose({
                    'en': results['en'][offset], 'korean': results['korean'][offset],
                    'ch': results['ch'][offset], 'japan': results['ch'][offset]})
                # Long-line padding depends on its batch peers. Reuse only the
                # fixed-width path and only the model selected for this block.
                if routes[index] in self.probes and short_crop(crops[offset]):
                    readings[index] = (line_index, results[routes[index]][offset])
        return routes, readings  # Page-local; do not retain private text/crops.
