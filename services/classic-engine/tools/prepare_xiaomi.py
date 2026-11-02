"""Prepare the pinned Xiaomi MLX INT8 model, including processor and provenance."""
import argparse
from importlib.metadata import version
import json
import os
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory

from mtu_engine.ocr.models import MODEL_ID, MODEL_REVISION, MODEL_SHA256, PROCESSOR_FILES, digest, verify_mlx


def prepare(source, output):
    source, output = Path(source), Path(output)
    if output.exists():
        return verify_mlx(output)
    if not source.exists():
        from huggingface_hub import snapshot_download
        snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_dir=source,
            allow_patterns=['*.json', '*.jinja', '*.safetensors', 'README.md'], max_workers=4)
    if digest(source / 'model.safetensors') != MODEL_SHA256:
        raise ValueError('Source is not the pinned Xiaomi checkpoint')
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
    from mlx_vlm.convert import convert
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix='xiaomi-', dir=output.parent) as directory:
        converted = Path(directory) / 'model'
        convert(str(source), str(converted), quantize=True, q_bits=8, q_group_size=64,
                dtype='bfloat16', trust_remote_code=False)
        # Keep the exact HF processor instead of the converter's MLX defaults.
        for name in PROCESSOR_FILES:
            shutil.copy2(source / name, converted / name)
        shutil.copy2(source / 'README.md', converted / 'SOURCE-README.md')
        manifest = {'source_revision': MODEL_REVISION, 'source_sha256': MODEL_SHA256,
            'bits': 8, 'group_size': 64, 'scope': 'Language weights only; vision BF16; KV unquantized',
            'versions': {name: version(name) for name in ('mlx', 'mlx-metal', 'mlx-vlm', 'transformers')},
            'files': {p.name: {'sha256': digest(p), 'bytes': p.stat().st_size}
                      for p in sorted(converted.iterdir()) if p.is_file()}}
        (converted / 'conversion-source.json').write_text(json.dumps(manifest, indent=2) + '\n')
        identity = verify_mlx(converted)
        converted.rename(output)
    return identity


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Pinned source directory; download if absent')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    prepare(args.source, args.output)
