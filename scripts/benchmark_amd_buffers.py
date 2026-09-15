"""Real AMD buffer reuse and deferred-text image preparation; no LLM/R2 calls."""
import argparse
import base64
import hashlib
from io import BytesIO
import json
from pathlib import Path
import time
import uuid

import httpx
import numpy as np
from PIL import Image
from benchmark_amd import ROOT, Load, engine, summarize_resources, write_json


def main(args):
    folder = args.directory.resolve()
    detail = json.loads((ROOT/'private-test-data/amd-original-models/stages.json').read_text(encoding='utf-8'))
    report = {'scope': 'same original AMD models; local HTTP; delayed translations supplied from validated sample; no LLM/R2', 'phases': []}
    # The prior v2 image is an independent pixel baseline, not this run's output.
    expected = np.array(Image.open(ROOT/'private-test-data/amd-original-models/result.png').convert('RGB'))
    expected_hash = hashlib.sha256(expected.tobytes()).hexdigest()
    with engine(folder, args.port) as (url, token, child, health):
        load = Load(url, token, ROOT/'samples/starlight-bookshop.png', detail['translations'], detail['segments'], folder, health['version'])
        for i in range(2):
            row = load.page('warmup', i)
            assert row['success'] and row['output_sha256'] == expected_hash
        for name, refs in [('full-input', False), ('image-references', True), ('full-input-repeat', False)]:
            load.use_image_refs = refs
            phase = load.phase(name, 1, pages=args.pages)
            assert phase['successes'] == args.pages and phase['max_pixel_difference'] == 0 and phase['cache_rebuilds'] == 0
            report['phases'].append(phase)
        pending, events = [], []
        began = time.monotonic()
        with httpx.Client(base_url=url, headers={'Authorization': 'Bearer '+token}, timeout=300, trust_env=False) as client:
            # Deliberately make no translation available until EVERY page has
            # completed OCR/LaMa. This tests real image work with delayed text;
            # durable scheduler correctness is separately covered by HTTP tests.
            for index in range(args.deferred_pages):
                body = {'image': load.encoded, 'scope': str(uuid.uuid4()), 'config': load.config}
                analyzed = client.post('/v1/analyze', json=body).raise_for_status().json()
                assert analyzed['segments'] == detail['segments']
                body.pop('image')
                body.update(image_ref=analyzed['image_ref'], input_hash=analyzed['input_hash'], analysis=analyzed)
                painted = client.post('/v1/inpaint', json=body).raise_for_status().json()
                assert painted['cached']
                body['cache_key'] = painted['cache_key']
                pending.append(body)
                event = {'page': index, 'event': 'image_prepared', 'seconds': time.monotonic()-began, 'text_available': False}
                events.append(event); print(json.dumps(event), flush=True)
            preparation_seconds = time.monotonic()-began
            for index, body in enumerate(pending):
                body.update(translations=detail['translations'], language='zh-Hans')
                rendered = client.post('/v1/render', json=body).raise_for_status().json()
                output = np.array(Image.open(BytesIO(base64.b64decode(rendered['image']))).convert('RGB'))
                assert np.array_equal(output, expected) and not rendered['cache_rebuilt']
                events.append({'page': index, 'event': 'rendered', 'seconds': time.monotonic()-began, 'pixel_identical': True})
        report['deferred_text'] = {'pages': len(pending), 'prepared_before_any_text': len(pending),
                                   'preparation_seconds': preparation_seconds, 'total_seconds': time.monotonic()-began,
                                   'events': events, 'cache_rebuilds': 0, 'max_pixel_difference': 0}
        if args.soak_seconds:
            load.use_image_refs = True
            phase = load.phase('cache-pressure', 1, seconds=args.soak_seconds)
            assert phase['failures'] == 0 and phase['max_pixel_difference'] == 0 and phase['cache_rebuilds'] == 0
            report['phases'].append(phase)
        report['health_after'] = httpx.get(url+'/health', timeout=30, trust_env=False).raise_for_status().json()
        report['reference_output_sha256'] = expected_hash
        write_json(folder/'report.json', report)
    summarize_resources(folder, report['phases'])
    write_json(folder/'report.json', report)
    print(json.dumps({'event': 'BUFFER_BENCHMARK_COMPLETE', 'report': str(folder/'report.json')}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT/'private-test-data'/('amd-buffers-'+time.strftime('%Y%m%d-%H%M%S')))
    parser.add_argument('--pages', type=int, default=6)
    parser.add_argument('--deferred-pages', type=int, default=5)
    parser.add_argument('--port', type=int, default=18100)
    parser.add_argument('--soak-seconds', type=int, default=0)
    args = parser.parse_args()
    if min(args.pages, args.deferred_pages) < 1 or args.soak_seconds < 0:
        parser.error('page counts must be positive')
    main(args)
