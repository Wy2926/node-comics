"""Explicit device selection; no automatic GPU or CPU fallback."""
import platform
import sys
from threading import RLock


BACKENDS = ('cuda', 'amd', 'mps')
ORT_PACKAGES = {'cuda': 'onnxruntime-gpu', 'amd': 'onnxruntime-directml', 'mps': 'onnxruntime'}
# Different models share the MPS command stream. PyTorch 2.14.1 can segfault
# when one worker copies tensors while another encodes an arange operation.
# Protect the entire device scope, including transfers and model teardown.
_MPS_LOCK = RLock()


def device_context(backend, gpu):
    import torch
    return _MPS_LOCK if backend == 'mps' else torch.cuda.device(gpu)


def validate_backend(backend, gpu):
    import torch
    if backend not in BACKENDS:
        raise ValueError('backend must be cuda, amd or mps')
    if backend == 'mps':
        if sys.platform != 'darwin' or platform.machine() != 'arm64':
            raise RuntimeError('MPS backend requires the separate Apple Silicon macOS environment')
        if gpu != 0:
            raise ValueError('MPS backend supports device 0 only')
        if not torch.backends.mps.is_available():
            raise RuntimeError('MPS is unavailable; CPU fallback is disabled')
        return
    hip = bool(torch.version.hip)
    if backend == 'cuda' and hip:
        raise RuntimeError('CUDA backend requires a CUDA PyTorch environment, not ROCm')
    if backend == 'amd' and (sys.platform != 'win32' or not hip):
        raise RuntimeError('AMD backend requires the separate Windows ROCm/DirectML environment')
    if not torch.cuda.is_available() or not 0 <= gpu < torch.cuda.device_count():
        raise RuntimeError('The configured GPU is unavailable; CPU fallback is disabled')
    if backend == 'amd' and (gpu != 0 or torch.cuda.device_count() != 1):
        raise RuntimeError('AMD backend currently supports a single GPU at device 0 only')
