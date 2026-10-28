"""Generate full-font descriptors and Unicode coverage, without copying font bytes.

Requires fonttools==4.59.1. Source fonts must match services/compute-node/assets.json;
license notices are checked against the already shipped preview notices.
"""
import argparse
import hashlib
import json
from pathlib import Path
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(source):
    assets = json.loads((ROOT / 'services/compute-node/assets.json').read_text())['fonts']
    catalog = json.loads((ROOT / 'backend/shared/translation-fonts.json').read_text())['fonts']
    ids = {font['id'] for font in catalog if 'zh-Hans' in font['languages'] and 'zh-Hant' in font['languages']}
    resources, coverage = [], {}
    for asset in assets:
        if asset.get('id') not in ids:
            continue
        path = source / asset['name']
        notice = ROOT / 'apps/extension/public/fonts/translation' / asset['notice']
        if digest(path) != asset['sha256'] or digest(notice) != asset['notice_sha256']:
            raise ValueError('Checksum mismatch: ' + asset['id'])
        font = TTFont(path, recalcTimestamp=False)
        points = sorted(font.getBestCmap())
        ranges = []
        for point in points:
            if ranges and point == ranges[-1][1] + 1:
                ranges[-1][1] = point
            else:
                ranges.append([point, point])
        coverage[asset['id']] = ranges
        resources.append({**asset, 'bytes': path.stat().st_size, 'weight': font['OS/2'].usWeightClass,
                          'source_version': font['name'].getDebugName(5)})
        font.close()
    if len(resources) != len(ids):
        raise ValueError('Incomplete Chinese font catalog')
    output = ROOT / 'apps/extension/src/translation'
    (output / 'font-resources.json').write_text(json.dumps(resources, ensure_ascii=False, indent=2) + '\n')
    (output / 'font-coverage.json').write_text(json.dumps(coverage, separators=(',', ':')) + '\n')
    print(f'Generated {len(resources)} descriptors; no font bytes bundled.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    prepare(parser.parse_args().source)
