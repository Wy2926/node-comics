"""Assemble the same pinned upstream assets as the Windows distribution."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT.parent / 'classic-engine'
sys.path.insert(0, str(ENGINE))
from tools.prepare_mtu import prepare


def build(output, cache):
    output.mkdir(parents=True, exist_ok=False)
    assets = prepare(output, cache)
    fonts = json.loads((output / 'licenses/font-sources.json').read_text(encoding='utf-8'))['fonts']
    release = {'platform': 'linux-amd64', 'protocol_version': 3,
               'fonts': ['fonts/' + font['name'] for font in fonts],
               'upstream': assets['upstream'], 'files': assets['files']}
    (output / 'release.json').write_text(json.dumps(release, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    args = parser.parse_args()
    build(args.output, args.cache)
