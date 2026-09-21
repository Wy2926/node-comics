"""LaMa Large ONNX; GPU execution is mandatory unless CPU is explicit."""
import hashlib
import json
from pathlib import Path
from threading import Lock

import cv2
import numpy as np
import onnxruntime as ort

CHECKPOINT = 'lama_large_512px.ckpt'
CHECKSUM = '11d30fbb3000fb2eceae318b75d9ced9229d99ae990a7f8b3ac35c8d31f2c935'
ARCHITECTURE = 'lama-large-matrix-dft-512-v1'


def model_identity(models):
    root = Path(models) / 'lama-onnx'
    descriptor = json.loads((root / 'build.json').read_text(encoding='utf-8'))
    if (descriptor.get('architecture') != ARCHITECTURE or descriptor.get('checkpoint_sha256') != CHECKSUM
            or descriptor.get('precision') != 'fp32' or descriptor.get('file') != 'lama-large-512.onnx'):
        raise ValueError('Unsupported LaMa ONNX provenance; run tools.build_lama')
    model = root / 'lama-large-512.onnx'
    with model.open('rb') as stream:
        checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
    if checksum != descriptor['sha256']:
        raise ValueError('LaMa ONNX checksum mismatch')
    return {'lama-onnx/lama-large-512.onnx': checksum}


class Lama:
    input_size = 512

    def __init__(self, models, threads=2, gpu=0):
        model_identity(models)
        self.lock = Lock()
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        provider = 'CPUExecutionProvider' if gpu < 0 else 'DmlExecutionProvider'
        if provider not in ort.get_available_providers():
            raise RuntimeError('LaMa GPU requires ONNX Runtime DirectML on Windows; no automatic CPU fallback')
        if gpu >= 0:
            options.add_session_config_entry('session.disable_cpu_ep_fallback', '1')
        providers = [provider] if gpu < 0 else [(provider, {'device_id': str(gpu)})]
        self.session = ort.InferenceSession(str(Path(models) / 'lama-onnx/lama-large-512.onnx'),
                                            options, providers=providers)
        self.session.disable_fallback()
        if self.session.get_providers()[0] != provider:
            raise RuntimeError('LaMa requested provider was not activated')
        self.backend = 'onnx-cpu-fp32' if gpu < 0 else f'onnx-directml-fp32:{gpu}'

    def predict(self, rgb, mask):
        if (rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3
                or mask.shape != rgb.shape[:2] or any(n < 1 or n > self.input_size for n in mask.shape)):
            raise ValueError('Invalid LaMa image/mask shape or dtype')
        h, w = mask.shape
        rgb = cv2.copyMakeBorder(rgb, 0, self.input_size-h, 0, self.input_size-w, cv2.BORDER_REFLECT_101)
        # Reflect both together: an unmasked reflected copy of text leaks back
        # into the repair through LaMa's global Fourier receptive field.
        mask = cv2.copyMakeBorder(mask, 0, self.input_size-h, 0, self.input_size-w, cv2.BORDER_REFLECT_101)
        image = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None], dtype=np.float32) / 255
        binary = np.ascontiguousarray((mask > 0)[None, None], dtype=np.float32)
        # DirectML does not permit concurrent Run calls on a single session.
        with self.lock:
            output = self.session.run(['output'], {'image': image, 'mask': binary})[0]
        if output.shape != image.shape or not np.isfinite(output).all():
            raise ValueError('Invalid LaMa model output')
        return output[0, :, :h, :w].transpose(1, 2, 0).clip(0, 1) * 255

    def warmup(self):
        rgb = np.full((64, 64, 3), 255, np.uint8)
        mask = np.zeros((64, 64), np.uint8)
        mask[24:40, 24:40] = 255
        self.predict(rgb, mask)
