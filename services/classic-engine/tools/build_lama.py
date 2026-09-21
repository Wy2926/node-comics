"""Export fixed-shape LaMa Large using real-valued DFT matrices.

Follows the separable DFT approach documented by Carve-Photos/lama, with
4-D MatMul instead of their higher-rank MatMul/Einsum graph. The Fourier
basis is calculated in float64 at build time, then stored as FP32.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import numpy as np
import onnx
import torch
from torch import nn
from tools.lama_model import FFCResNetGenerator, FourierUnit

CHECKPOINT_SHA256 = '11d30fbb3000fb2eceae318b75d9ced9229d99ae990a7f8b3ac35c8d31f2c935'
ARCHITECTURE = 'lama-large-matrix-dft-512-v1'

class MatrixFourier(nn.Module):
    def __init__(self, original, h, w):
        super().__init__()
        self.conv_layer, self.bn, self.relu = original.conv_layer, original.bn, original.relu

        def basis(n, k):
            angle = (-2 * torch.pi * torch.arange(n, dtype=torch.float64)[:, None]
                     * torch.arange(k, dtype=torch.float64)[None, :] / n)
            return (angle.cos() / n**.5).float(), (angle.sin() / n**.5).float()

        ch, sh = basis(h, h)
        cw, sw = basis(w, w // 2 + 1)
        # Real inverse DFT doubles conjugate pairs, except DC and Nyquist.
        weights = torch.full((w // 2 + 1,), 2.)
        weights[0] = weights[-1] = 1
        for name, value in dict(ch=ch, sh=sh, cw=cw, sw=sw, weights=weights).items():
            self.register_buffer(name, value)

    def forward(self, x):
        re, im = x @ self.cw, x @ self.sw
        r = (re.transpose(-1, -2) @ self.ch - im.transpose(-1, -2) @ self.sh).transpose(-1, -2)
        i = (re.transpose(-1, -2) @ self.sh + im.transpose(-1, -2) @ self.ch).transpose(-1, -2)
        f = torch.stack((r, i), dim=2).flatten(1, 2)
        f = self.relu(self.bn(self.conv_layer(f)))
        f = f.reshape(x.shape[0], -1, 2, x.shape[-2], x.shape[-1] // 2 + 1)
        r, i = f[:, :, 0], f[:, :, 1]
        re = (r.transpose(-1, -2) @ self.ch.T + i.transpose(-1, -2) @ self.sh.T).transpose(-1, -2)
        im = (-r.transpose(-1, -2) @ self.sh.T + i.transpose(-1, -2) @ self.ch.T).transpose(-1, -2)
        return (re * self.weights) @ self.cw.T + (im * self.weights) @ self.sw.T

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=Path, default=Path('models'))
    args = parser.parse_args()
    checkpoint = args.models / 'lama_large_512px.ckpt'
    with checkpoint.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != CHECKPOINT_SHA256:
            raise ValueError('LaMa checkpoint checksum mismatch')
    torch.set_num_threads(2)
    net = FFCResNetGenerator(4, 3, add_out_act='sigmoid', n_blocks=18,
        init_conv_kwargs={'ratio_gin': 0, 'ratio_gout': 0, 'enable_lfu': False},
        downsample_conv_kwargs={'ratio_gin': 0, 'ratio_gout': 0, 'enable_lfu': False},
        resnet_conv_kwargs={'ratio_gin': .75, 'ratio_gout': .75, 'enable_lfu': False})
    net.load_state_dict(torch.load(checkpoint, map_location='cpu', weights_only=True)['gen_state_dict'])
    net.eval().requires_grad_(False)
    converted = copy.deepcopy(net)
    for name, module in list(converted.named_modules()):
        if isinstance(module, FourierUnit):
            parent, attr = name.rsplit('.', 1)
            setattr(converted.get_submodule(parent), attr, MatrixFourier(module, 64, 64))
    rng = np.random.default_rng(12)
    x = torch.from_numpy(rng.random((1, 3, 512, 512), dtype=np.float32))
    mask = torch.zeros(1, 1, 512, 512)
    mask[:, :, 120:240, 120:240] = 1
    destination = args.models / 'lama-onnx'
    destination.mkdir(parents=True, exist_ok=True)
    model = destination / 'lama-large-512.onnx'
    with torch.inference_mode():
        error = (net(x, mask) - converted(x, mask)).abs()
        maximum, mean = error.max().item(), error.mean().item()
        if maximum > 1e-4 or mean > 1e-5:
            raise RuntimeError('DFT conversion failed numerical comparison')
        torch.onnx.export(converted, (x, mask), str(model), input_names=['image', 'mask'],
                          output_names=['output'], opset_version=17, dynamo=False)
    onnx.checker.check_model(str(model))
    with model.open('rb') as stream:
        checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
    descriptor = {'architecture': ARCHITECTURE, 'checkpoint_sha256': CHECKPOINT_SHA256,
        'file': model.name, 'sha256': checksum, 'torch': torch.__version__, 'onnx': onnx.__version__,
        'precision': 'fp32', 'opset': 17, 'source_revision': '95227a2bb0fd306cd4f0c104d57284026f991b3a',
        'reference_max_abs': maximum, 'reference_mean_abs': mean}
    (destination / 'build.json').write_text(json.dumps(descriptor, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(descriptor, indent=2))


if __name__ == '__main__':
    main()
