"""Build GPU-independent model artifacts using the shared, locked converters."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT.parent / 'classic-engine'
sys.path.insert(0, str(ROOT))
from build_support import download, run, sha256


def build(output, cache):
    output.mkdir(parents=True, exist_ok=False)
    models = output / 'models'
    lock = json.loads((ROOT / 'toolchain.lock.json').read_text())
    manifest = json.loads((ENGINE / 'manhua_engine/models.json').read_text())
    for asset in manifest['models']:
        source = download(asset['url'], asset['sha256'], cache / asset['sha256'])
        target = models / asset['name']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    inputs = {}
    for name in ('ocr_source', 'ocr_checkpoint'):
        asset = lock[name]
        suffix = '.py' if name == 'ocr_source' else '.zip'
        inputs[name] = download(asset['url'], asset['sha256'], cache / (asset['sha256'] + suffix))
    env = dict(os.environ, PYTHONHASHSEED='0')
    run([ROOT / 'build-deps/ocr/.venv/bin/python', ENGINE / 'tools/build_ocr.py',
         '--source-file', inputs['ocr_source'], '--archive', inputs['ocr_checkpoint'],
         '--work', '/tmp/ocr-build', '--output', models / 'ocr-fp32'], cwd=ENGINE, env=env)
    run([ROOT / 'build-deps/lama/.venv/bin/python', '-m', 'tools.build_lama',
         '--models', models], cwd=ENGINE, env=env)
    # Exclude conversion checkpoints and full reference OCR from the runtime layer.
    for asset in manifest['models']:
        if asset.get('build_only'):
            (models / asset['name']).unlink()
    (models / 'ocr-fp32/ocr.onnx').unlink()
    fonts = json.loads((ROOT / 'assets.json').read_text())['fonts']
    for font in fonts:
        for directory, name, url, checksum in (
            ('fonts', font['name'], font['url'], font['sha256']),
            ('licenses', font['notice'], font['notice_url'], font['notice_sha256']),
        ):
            target = output / directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(download(url, checksum, cache / checksum), target)
    shutil.copyfile(ROOT / 'assets.json', output / 'licenses/font-sources.json')
    release = {
        'platform': 'linux-amd64', 'protocol_version': 3,
        'fonts': ['fonts/' + font['name'] for font in fonts],
        'files': {path.relative_to(output).as_posix(): sha256(path)
                  for path in sorted(output.rglob('*')) if path.is_file()},
    }
    (output / 'release.json').write_text(json.dumps(release, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    args = parser.parse_args()
    build(args.output, args.cache)
