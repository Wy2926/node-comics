"""Startup-only backend checks; image stages keep the same PyTorch device path."""
import sys


def validate_backend(backend, gpu):
    import torch
    if backend not in ('cuda', 'amd'):
        raise ValueError('backend must be cuda or amd')
    hip = bool(torch.version.hip)
    if backend == 'cuda' and hip:
        raise RuntimeError('CUDA backend requires a CUDA PyTorch environment, not ROCm')
    if backend == 'amd' and (sys.platform != 'win32' or not hip):
        raise RuntimeError('AMD backend requires the separate Windows ROCm/DirectML environment')
    if not torch.cuda.is_available() or not 0 <= gpu < torch.cuda.device_count():
        raise RuntimeError('The configured GPU is unavailable; CPU fallback is disabled')
    if backend == 'amd' and (gpu != 0 or torch.cuda.device_count() != 1):
        raise RuntimeError('AMD backend currently supports a single GPU at device 0 only')
