"""Record actual CUDA tensor execution without recording image or OCR data."""
from collections import Counter
import os
import torch


class CudaRuntime:
    def __init__(self, device):
        self.device = torch.device(device)
        self.handles, self.counts = [], Counter()
        self.trace = os.environ.get('ENGINE_TRACE_DEVICES', '0') == '1'

    async def load(self, models):
        for label, model in models.items():
            await model.load(str(self.device))
            network = model.model.generator if label == 'inpainter' else model.model
            if any(parameter.device != self.device for parameter in network.parameters()):
                raise RuntimeError('Configured CUDA model loaded on another device')
            if not self.trace:
                continue
            for module in network.modules():
                if isinstance(module, (torch.nn.Conv2d, torch.nn.ConvTranspose2d, torch.nn.Linear)):
                    def record(mod, args, component=label):
                        actual = args[0].device
                        if actual != self.device or mod.weight.device != self.device:
                            raise RuntimeError('Configured CUDA model executed on another device')
                        self.counts[(component, str(actual))] += 1
                    self.handles.append(module.register_forward_pre_hook(record))

    def evidence(self):
        return {'adapter': torch.cuda.get_device_name(self.device), 'torch': torch.__version__,
                'runtime': ('rocm-' + str(torch.version.hip)) if torch.version.hip else 'cuda-' + str(torch.version.cuda),
                'execution_tracing': self.trace,
                'executed': [{'stage': stage, 'device': device, 'calls': calls}
                             for (stage, device), calls in sorted(self.counts.items())]}

    def close(self):
        for handle in self.handles:
            handle.remove()
        self.handles.clear()
