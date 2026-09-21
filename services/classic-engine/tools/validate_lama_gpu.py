"""Prove final LaMa ONNX runs wholly on DirectML and compare to CPU FP32."""
import argparse
from collections import Counter
import json
from pathlib import Path
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

from manhua_engine.inpainting import model_identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', type=Path)
    parser.add_argument('mask', type=Path)
    parser.add_argument('--models', type=Path, default=Path('models'))
    parser.add_argument('--gpu', type=int, default=0)
    parser.add_argument('--output', type=Path, default=Path('artifacts/lama-validation/gpu-parity'))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    identity = model_identity(args.models)
    image = np.array(Image.open(args.image).convert('RGB').resize((512, 512)))
    mask = np.array(Image.open(args.mask).convert('L').resize((512, 512), Image.Resampling.NEAREST))
    inputs = {'image': image.transpose(2, 0, 1)[None].astype(np.float32) / 255,
              'mask': (mask > 0)[None, None].astype(np.float32)}
    report = {'models': identity, 'onnxruntime': ort.__version__, 'gpu_device_id': args.gpu,
              'cpu_fallback_disabled': True, 'shape': [1, 3, 512, 512]}
    results = {}
    for provider in ('DmlExecutionProvider', 'CPUExecutionProvider'):
        options = ort.SessionOptions()
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.enable_profiling = True
        options.profile_file_prefix = str(args.output / provider)
        if provider == 'DmlExecutionProvider':
            options.add_session_config_entry('session.disable_cpu_ep_fallback', '1')
        providers = [(provider, {'device_id': str(args.gpu)})] if provider.startswith('Dml') else [provider]
        session = ort.InferenceSession(str(args.models / 'lama-onnx/lama-large-512.onnx'),
                                       options, providers=providers)
        session.disable_fallback()
        assert session.get_providers()[0] == provider
        seconds = []
        for _ in range(4):
            started = time.perf_counter()
            result = session.run(['output'], inputs)[0]
            seconds.append(time.perf_counter() - started)
        profile = json.loads(Path(session.end_profiling()).read_text(encoding='utf-8'))
        assigned = Counter(event['args']['provider'] for event in profile
                           if event.get('cat') == 'Node' and event.get('args', {}).get('provider'))
        assert set(assigned) == {provider}, assigned
        assert np.isfinite(result).all()
        results[provider] = result
        report[provider] = {'seconds': seconds, 'profile_providers': dict(assigned)}
        del session
    delta = np.abs(results['DmlExecutionProvider'] - results['CPUExecutionProvider'])
    report['output_error'] = {'max_abs': float(delta.max()), 'mean_abs': float(delta.mean())}
    report['passed'] = float(delta.max()) < 1e-4 and float(delta.mean()) < 1e-5
    (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
