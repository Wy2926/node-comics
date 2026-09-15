"""Compare AMD v1/v2 single-page HTTP latency, same models and exact pixels.

Requires the previously validated private sample translations; no LLM/R2 calls.
One client, one GPU model instance, unique per-page cache scopes. The v2 CPU
panel process is part of that page's pipeline, not another GPU model replica.
"""
import argparse
import json
from pathlib import Path
import time

from benchmark_amd import ROOT, Load, engine, summarize_resources, write_json


def main(args):
    folder = args.directory.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    detail = json.loads((ROOT/'private-test-data/amd-original-models/stages.json').read_text(encoding='utf-8'))
    report = {'scope': 'single-page local HTTP pipeline, no LLM/R2', 'phases': []}
    reference = None
    for label, optimized in [('v1-serial', False), ('v2-parallel-panels', True), ('v1-repeat', False)]:
        target = folder/label
        with engine(target, args.port, optimized=optimized, threads=4, inpaint_workers=1) as (url, token, child, health):
            load = Load(url, token, ROOT/'samples/starlight-bookshop.png', detail['translations'],
                        detail['segments'], target, health['version'])
            load.reference = reference
            for index in range(2):
                warm = load.page('warmup', index)
                if not warm['success'] or warm.get('max_pixel_difference', 0) != 0:
                    raise RuntimeError('Warmup output differs from original')
            reference = load.reference
            phase = load.phase(label, 1, pages=args.pages)
            if phase['successes'] != args.pages or phase['max_pixel_difference'] != 0 or phase['cache_rebuilds']:
                raise RuntimeError('Page validation failed; inspect private report')
            phase['health'] = health
        summarize_resources(target, [phase])
        report['phases'].append(phase)
        write_json(folder/'report.json', report)
    print(json.dumps({'event': 'SINGLE_PAGE_COMPLETE', 'report': str(folder/'report.json')}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pages', type=int, default=10)
    parser.add_argument('--port', type=int, default=18100)
    parser.add_argument('--directory', type=Path, default=ROOT/'private-test-data'/('amd-single-http-'+time.strftime('%Y%m%d-%H%M%S')))
    args = parser.parse_args()
    if args.pages < 1:
        parser.error('pages must be positive')
    main(args)
