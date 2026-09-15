"""Original manga models on AMD. Fourier submodules run unchanged on CPU.

No weight conversion, OCR replacement, mask approximation or renderer changes.
Execution hooks record actual module input/parameter devices, never image/text.
"""
from collections import Counter
import json
import os
from pathlib import Path
import re

import torch
import torch_directml
from manga_translator.inpainting.inpainting_lama_mpe import FourierUnit


class DirectMLRuntime:
    def __init__(self, device):
        if os.name != 'nt' or not re.fullmatch(r'directml:\d+', device):
            raise RuntimeError('Expected Windows ENGINE_DEVICE=directml:index')
        index = int(device.split(':')[1])
        if index >= torch_directml.device_count():
            raise RuntimeError('Requested DirectML device is unavailable')
        self.device = torch_directml.device(index)
        self.name = torch_directml.device_name(index).rstrip('\x00')
        if 'AMD' not in self.name and 'Radeon' not in self.name:
            raise RuntimeError('Selected DirectML adapter is not an AMD GPU')
        self.counts = Counter()
        self.handles = []
        self.fourier_units = 0
        self.profile_dir = Path(os.environ['ENGINE_PROFILE_DIR']) if os.environ.get('ENGINE_PROFILE_DIR') else None
        if self.profile_dir:
            self.profile_dir.mkdir(parents=True, exist_ok=True)

    async def load(self, models):
        for label, model in models.items():
            await model.load(str(self.device))
            network = model.model.generator if label == 'inpainter' else model.model
            if label == 'ocr':
                # DirectML's autoregressive beam/cache indexing diverges from
                # PyTorch CPU on this runtime. Keep exact decoding on CPU while
                # accelerating the unchanged visual backbone and encoder.
                network.to('cpu')
                network.backbone.to(self.device)
                network.encoders.to(self.device)
                model.device, model.use_gpu = 'cpu', False
                self.handles.append(network.backbone.register_forward_pre_hook(
                    lambda _, args: (args[0].to(self.device),)))
                self.handles.append(network.encoders.register_forward_pre_hook(
                    lambda _, args: tuple(arg.to(self.device) for arg in args)))
                self.handles.append(network.encoders.register_forward_hook(
                    lambda _, args, output: output.cpu()))
            if label == 'inpainter':
                for module in network.modules():
                    if isinstance(module, FourierUnit):
                        # DirectML has no complex tensor/FFT implementation.
                        # Keep the entire original FourierUnit intact on CPU.
                        module.to('cpu')
                        self.fourier_units += 1
                        self.handles.append(module.register_forward_pre_hook(lambda _, args: (args[0].cpu(),)))
                        self.handles.append(module.register_forward_hook(lambda _, args, output: output.to(self.device)))
            for module in network.modules():
                if isinstance(module, (torch.nn.Conv2d, torch.nn.ConvTranspose2d, torch.nn.Linear)):
                    def record(mod, args, component=label):
                        actual = args[0].device.type
                        if mod.weight.device.type != actual:
                            raise RuntimeError('Model/input device mismatch')
                        self.counts[(component, mod.__class__.__name__, actual)] += 1
                    self.handles.append(module.register_forward_pre_hook(record))

    def evidence(self):
        return {'adapter': self.name, 'torch': torch.__version__, 'runtime': 'torch-directml-0.2.5.dev240914',
                'fourier_units_on_cpu': self.fourier_units,
                'ocr_decoder_device': 'cpu', 'ocr_visual_encoder_device': str(self.device),
                'executed': [{'stage': stage, 'module': module, 'device': device, 'calls': count}
                             for (stage, module, device), count in sorted(self.counts.items())]}

    def close(self):
        if self.profile_dir:
            (self.profile_dir / 'execution-summary.json').write_text(json.dumps(self.evidence(), indent=2), encoding='utf-8')
        for handle in self.handles:
            handle.remove()
        self.handles.clear()
