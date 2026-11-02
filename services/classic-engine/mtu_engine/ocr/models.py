"""Pinned Hayai weights, inference code, tokenizer and SigLIP2 processor."""
import json
from pathlib import Path

from mtu_engine.assets import file_hash

SOURCES = {'model': {'repo': 'JustANormalTinkerer/hayai-ocr-v2.5-nova',
           'revision': '2803d0dc005fa4396ab1e7c5a472d2c450a247f7',
           'license': 'Apache-2.0',
           'files': {'README.md': '1ecc6eae28d5d8297c48592b288d9099943fe94ff4ad288923fed79df38c69ef',
                     'config.json': '880c99360c77733032fe06e94de8123dca21610cab782c6df43e4e26c9d37c41',
                     'configuration_hayai.py': '47abd38cf1bae7aef27d01f5b8b4aa0960a7bc625a8afad79c4762ff5e5ed970',
                     'model.safetensors': 'ac63cd177c5b68bd91e18dd4408e0400461c7cf19f484b0da1643e232d1ffc3a',
                     'modeling_hayai.py': '3409131b4a35fc1bc1f0d7c40f906f79d10f57476f40fe05939c5a1a0ba9d527',
                     'tokenizer.json': 'f8a0a909c628a684fe463094614e236a8b1d3609e7770f77e7beafaf1056bf13',
                     'tokenizer_config.json': '6fb6c69afaedf1275872d3e62e276fd4467bd00da7a84cbbb5566a2cd28f58f6'}},
 'processor': {'repo': 'google/siglip2-base-patch16-naflex',
               'revision': 'b53b807d3a2d5e2b3911292f2d69e5341cdc064c',
               'license': 'Apache-2.0',
               'files': {'README.md': 'd4353009ea90b7de43575c4ba7e547e195e3239a62f7746afb16ae4ca7fa390a',
                         'config.json': 'c0b8c2e7f0527b0bea1b1d9abe0381c0f294352df92439c54590b8420e539118',
                         'preprocessor_config.json': '1125703e5446d5b6ff4d5893a33bac128cdd21dc12e3dad2469a648fb0ae3bf7'}}}


def verify_hayai(directory):
    directory = Path(directory).resolve()
    manifest = directory / 'source.json'
    if json.loads(manifest.read_text()) != SOURCES:
        raise ValueError('Expected the pinned Hayai artifact')
    for folder, source in SOURCES.items():
        for name, checksum in source['files'].items():
            if file_hash(directory / folder / name) != checksum:
                raise ValueError('Hayai artifact checksum mismatch')
    return {'backend': 'hayai', 'manifest_sha256': file_hash(manifest)}
