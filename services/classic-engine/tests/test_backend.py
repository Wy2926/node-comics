"""Backend selection is explicit; CUDA defaults and dependency closure stay isolated."""
import json
from pathlib import Path
import sys
import tomllib
from types import SimpleNamespace

import pytest

from classic_node.config import ENGINE_DEFAULTS, execution_settings, load
from mtu_engine.backend import validate_backend


@pytest.mark.parametrize('selection', [None, 'cuda', 'amd'])
def test_backend_config_is_opt_in_and_keeps_resource_defaults(tmp_path, selection):
    engine = {} if selection is None else {'backend': selection}
    path = tmp_path / 'node.json'
    path.write_text(json.dumps({'protocol_version': 3, 'control_url': 'https://example.test',
        'node_id': 'test', 'node_token': 'fixture', 'resource_id': 'test', 'engine': engine}))
    config = load(path)
    assert config['engine']['backend'] == (selection or 'cuda')
    assert config['local_pages'] == 2 and config['max_leases'] == 8
    assert config['inpaint_slots'] == 2
    assert config['engine']['ocr_batch_size'] == 4
    assert config['engine']['ocr_min_batch_size'] == 1
    assert config['engine']['ocr_arena_extend_strategy'] == 'kSameAsRequested'
    assert config['engine']['ocr_arena_shrinkage'] is True
    assert execution_settings(config)['engine']['backend'] == (selection or 'cuda')
    engine['backend'] = 'auto'
    value = json.loads(path.read_text())
    value['engine'] = engine
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match='backend must be cuda or amd'):
        load(path)


@pytest.mark.parametrize('backend,hip,platform,gpu,count,error', [
    ('cuda', None, 'win32', 0, 1, None),
    ('cuda', None, 'linux', 1, 2, None),
    ('amd', 'test-hip', 'win32', 0, 1, None),
    ('cuda', 'test-hip', 'win32', 0, 1, 'not ROCm'),
    ('amd', None, 'win32', 0, 1, 'separate Windows'),
    ('amd', 'test-hip', 'linux', 0, 1, 'separate Windows'),
    ('amd', 'test-hip', 'win32', 0, 2, 'single GPU'),
    ('amd', 'test-hip', 'win32', 1, 2, 'single GPU'),
    ('amd', 'test-hip', 'win32', 0, 0, 'CPU fallback is disabled'),
    ('cuda', None, 'win32', 1, 1, 'CPU fallback is disabled'),
])
def test_backend_fails_closed_before_loading_models(monkeypatch, backend, hip, platform, gpu, count, error):
    torch = SimpleNamespace(version=SimpleNamespace(hip=hip), cuda=SimpleNamespace(
        is_available=lambda: count > 0, device_count=lambda: count))
    monkeypatch.setitem(sys.modules, 'torch', torch)
    monkeypatch.setattr('mtu_engine.backend.sys', SimpleNamespace(platform=platform))
    if error:
        with pytest.raises(RuntimeError, match=error):
            validate_backend(backend, gpu)
    else:
        validate_backend(backend, gpu)


def test_backend_dependency_locks_do_not_mix_gpu_runtimes():
    root = Path(__file__).resolve().parents[1]
    cuda = tomllib.loads((root / 'uv.lock').read_text(encoding='utf-8'))
    amd = tomllib.loads((root / 'environments/amd/uv.lock').read_text(encoding='utf-8'))
    cuda_names = {p['name'] for p in cuda['package']}
    amd_names = {p['name'] for p in amd['package']}
    assert 'onnxruntime-gpu' in cuda_names and 'onnxruntime-directml' not in cuda_names
    assert not any(n.startswith(('rocm', 'amd-torch')) for n in cuda_names)
    assert 'onnxruntime-directml' in amd_names
    assert not amd_names.intersection({'onnxruntime', 'onnxruntime-gpu'})
    assert not any(n.startswith('nvidia-') for n in amd_names)
    assert {'amd-torch-device-gfx1030', 'rocm-sdk-device-gfx1030'} <= amd_names
    assert ENGINE_DEFAULTS['backend'] == 'cuda'
