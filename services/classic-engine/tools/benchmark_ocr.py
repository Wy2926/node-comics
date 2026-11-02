"""Measure the selected node OCR through its real analysis pipeline, offline."""
import argparse
import json
import os
from pathlib import Path
import statistics
from time import perf_counter

import numpy as np
from PIL import Image

from classic_node.config import load
from classic_node.runtime import Runtime
from classic_node.timing import collect
from mtu_engine.assets import file_hash
from mtu_engine.engine import serialize_region

SAMPLES = Path(__file__).resolve().parents[3] / 'backend/website/src/assets/home'


def run(args):
    if args.output.exists():
        raise ValueError('Use a new output file; do not overwrite an earlier comparison')
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
    config = load(args.config)
    # This tool performs analysis only; do not create unused render processes.
    config['render_workers'] = 1
    started = perf_counter()
    runtime = Runtime(config)
    report = {'version': runtime.version, 'ocr': runtime.engine.ocr.identity,
              'startup_seconds': perf_counter() - started, 'pages': []}
    try:
        for path in args.input:
            with Image.open(path) as image:
                rgb = np.array(image.convert('RGB'))
            runtime.engine.analyze(rgb)  # Warm this page's shapes, outside timings.
            runs = []
            for _ in range(args.repeats):
                started = perf_counter()
                with collect() as timings:
                    regions, *_ = runtime.engine.analyze(rgb)
                runs.append({'analysis_seconds': perf_counter() - started,
                    'ocr_seconds': timings.get('analyze_route', 0) + timings.get('analyze_ocr', 0),
                    'texts': [region.text for region in regions]})
            if any(run['texts'] != runs[0]['texts'] for run in runs[1:]):
                raise ValueError('OCR results changed between repeated runs')
            report['pages'].append({'file': path.name, 'sha256': file_hash(path), 'runs': runs,
                'median_ocr_seconds': statistics.median(run['ocr_seconds'] for run in runs),
                'regions': [serialize_region(region) for region in regions]})
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    finally:
        runtime.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--input', type=Path, nargs='+',
                        default=[SAMPLES / 'mono-original.png', SAMPLES / 'color-original.jpg'])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repeats', type=int, default=5)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error('--repeats must be positive')
    run(args)
