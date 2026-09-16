"""Prepare the original pinned manga models for native Windows deployment."""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
COMMIT = '95227a2bb0fd306cd4f0c104d57284026f991b3a'
SOURCE = ROOT / 'engines/mit-native'
MODELS = ROOT / 'engines/mit-models'


def prepare():
    if not (SOURCE / '.git').is_dir():
        cache = ROOT / 'engines/manga-image-translator'
        origin = str(cache) if (cache / '.git').is_dir() else 'https://github.com/zyddnys/manga-image-translator.git'
        subprocess.run(['git', 'clone', '--no-checkout', origin, str(SOURCE)], check=True)
        subprocess.run(['git', '-C', str(SOURCE), 'checkout', COMMIT], check=True)
    actual = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != COMMIT:
        raise RuntimeError('Unexpected upstream source revision')
    os.environ['MIT_ROOT'] = str(SOURCE)
    os.environ['MODEL_DIR'] = str(MODELS)
    import prepare as upstream
    upstream.prepare_source()
    # Device dispatch only. Inference math, weights and postprocessing unchanged.
    for relative in ['detection/default.py', 'ocr/model_48px.py', 'inpainting/inpainting_lama_mpe.py']:
        path = SOURCE / 'manga_translator' / relative
        value = path.read_text(encoding='utf-8')
        value = value.replace("self.device.startswith('cuda') or self.device == 'mps' or self.device == 'xpu'", "self.device != 'cpu'")
        value = value.replace("device.startswith('cuda') or device == 'mps' or device == 'xpu'", "device != 'cpu'")
        path.write_text(value, encoding='utf-8')
    upstream.prepare_models()
    print('PINNED_NATIVE_MODELS_READY', flush=True)


if __name__ == '__main__':
    prepare()
