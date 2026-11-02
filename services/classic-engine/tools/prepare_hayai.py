"""Prepare checksum-pinned Hayai assets without loading models or converting weights."""
import argparse
import json
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory

from mtu_engine.ocr.models import SOURCES, file_hash, verify_hayai


def prepare(source, output):
    source, output = Path(source), Path(output)
    if output.exists():
        return verify_hayai(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix='hayai-', dir=output.parent) as directory:
        prepared = Path(directory) / 'prepared'
        for folder, spec in SOURCES.items():
            target = prepared / folder
            target.mkdir(parents=True)
            for name, checksum in spec['files'].items():
                original = source / folder / name
                if not original.exists():
                    from huggingface_hub import hf_hub_download
                    hf_hub_download(spec['repo'], name, revision=spec['revision'], local_dir=source / folder)
                if file_hash(original) != checksum:
                    raise ValueError('Hayai source checksum mismatch')
                shutil.copyfile(original, target / name)
        (prepared / 'source.json').write_text(json.dumps(SOURCES, indent=2) + '\n')
        identity = verify_hayai(prepared)
        prepared.rename(output)
    return identity


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Pinned source cache; download missing files')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    prepare(args.source, args.output)
