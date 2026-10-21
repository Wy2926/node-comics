"""Prepare the private runtime and assets once; application updates reuse them.

Invoked only by prepare.ps1 with private, checksum-verified Python/uv. No GPU,
node identity, service, registry write, or global package installation is needed.
"""
import argparse
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_release import Builder
from build_support import event


def install(args):
    root = args.root.resolve()
    manifest = json.loads((root / 'portable.json').read_text(encoding='utf-8'))
    if manifest.get('format') != 'gpu-portable-v1':
        raise ValueError('Unsupported portable package')
    destination = root / 'payload'
    if destination.exists():
        raise ValueError('Payload already exists; never overwrite an installed node')
    work = root / '.setup'
    stage = work / 'payload-staging'
    # Only this exact generated directory may be discarded after interruption.
    if work.resolve() != work or stage.is_symlink() or stage.resolve().parent != work.resolve():
        raise ValueError('Unsafe staging directory')
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    args.output, args.work, args.version = stage, work, manifest['version']
    builder = Builder(args)
    builder.prepare_models()
    builder.package_runtime()
    builder.package_fonts()
    builder.write_manifest()
    # One same-volume directory rename is the commit point. Failed installs
    # never expose a half-installed runtime to node start/doctor.
    stage.rename(destination)
    event('portable_ready', payload=str(destination))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--uv', type=Path, required=True)
    parser.add_argument('--backend', choices=('cuda', 'amd'), required=True)
    install(parser.parse_args())
