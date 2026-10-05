"""Offline build-time verification; target-host check still requires an NVIDIA GPU."""
import json
from pathlib import Path


def verify(root):
    import torch
    from PIL import features
    from classic_node.runtime import LANGUAGE_PROBES
    from mtu_engine.assets import verify as verify_assets
    from mtu_engine.engine import Renderer
    if not torch.version.cuda or not features.check('webp'):
        raise ValueError('Runtime requires CUDA-enabled PyTorch and WebP support')
    verify_assets(root / 'models')
    manifest = json.loads((root / 'release.json').read_text())
    renderer = Renderer(root / 'models', [str(root / name) for name in manifest['fonts']])
    for language, probe in LANGUAGE_PROBES.items():
        if not renderer.covers(probe):
            raise ValueError('Missing font coverage: ' + language)
    # Import every stage here, so missing binary/module dependencies fail the build.
    from manga_translator.detection.default import DefaultDetector
    from ballontranslator.modules.textdetector.ctd import CTDModel
    from manga_translator.ocr.model_48px_ctc import Model48pxCTCOCR
    from manga_translator.inpainting.inpainting_lama_mpe import LamaLargeInpainter
    from manga_translator.mask_refinement import dispatch
    print('Verified upstream, model hashes, imports and Qt fonts; run check on the target GPU.')


if __name__ == '__main__':
    verify(Path('/opt/node'))
