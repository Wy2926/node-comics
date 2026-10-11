"""Assemble the same pinned upstream assets as the Windows distribution."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT.parent / 'classic-engine'
sys.path.insert(0, str(ENGINE))
from tools.prepare_mtu import prepare


def build(output, cache, *, existing_root=False):
    output.mkdir(parents=True, exist_ok=existing_root)
    if (output / '.source-revision').exists():
        raise ValueError('Never rebuild assets in a completed release')
    assets = prepare(output, cache)
    fonts = json.loads((output / 'licenses/font-sources.json').read_text(encoding='utf-8'))['fonts']
    release = {'platform': 'linux-amd64', 'protocol_version': 3,
               'fonts': ['fonts/' + font['name'] for font in fonts],
               'upstream': assets['upstream'], 'files': assets['files']}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=output,
                                         prefix='.release-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(release, indent=2) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o644)
        temporary.replace(output / 'release.json')
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--existing-root', action='store_true', help='Prepare assets alongside this release source and venv')
    args = parser.parse_args()
    build(args.output, args.cache, existing_root=args.existing_root)
