"""Selectable OCR boundaries, ordered paragraph results and local worker failures."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import numpy as np
from PIL import Image
import pytest

from classic_node.config import execution_settings, load
from mtu_engine.ocr.mlx import MLXOCR


def test_public_ocr_and_color_imports_do_not_load_either_runtime():
    subprocess.run([sys.executable, '-c', '''
import sys
import mtu_engine.ocr
import mtu_engine.colors
assert not {'torch', 'transformers', 'mlx', 'mlx_vlm', 'rapidocr', 'manga_ocr', 'onnxruntime'} & sys.modules.keys()
'''], check=True)


def configuration(tmp_path, **options):
    path = tmp_path / 'node.json'
    path.write_text(json.dumps({'protocol_version': 3, 'control_url': 'https://example.test',
        'node_id': 'test', 'node_token': 'fixture', 'resource_id': 'test',
        'engine': {'backend': 'mps', 'ocr_backend': 'mlx8', 'ocr_model': 'quantized',
                   'ocr_python': 'venv/python', 'ocr_batch_size': 8} | options}))
    return path


def test_mlx_configuration_keeps_venv_symlink_and_omits_paths_in_diagnostics(tmp_path):
    executable = tmp_path / 'venv/python'
    executable.parent.mkdir()
    executable.symlink_to(sys.executable)
    result = load(configuration(tmp_path))
    assert result['engine']['ocr_python'] == str(executable)
    assert result['engine']['ocr_model'] == str(tmp_path / 'quantized')
    public = execution_settings(result)['engine']
    assert public['ocr_backend'] == 'mlx8'
    assert not {'ocr_model', 'ocr_python'} & public.keys()


@pytest.mark.parametrize('option', [
    {'backend': 'cuda'}, {'ocr_backend': 'auto'}, {'ocr_python': None}, {'ocr_model': ''},
    {'ocr_batch_size': True}, {'ocr_batch_size': '8'}, {'ocr_batch_size': 0}, {'ocr_batch_size': 9},
])
def test_invalid_backend_configuration_fails_before_model_load(tmp_path, option):
    with pytest.raises(ValueError):
        load(configuration(tmp_path, **option))


def block(box, lines=1):
    return SimpleNamespace(xyxy=box, lines=[object()] * lines)


def test_paragraph_batches_are_bounded_and_restore_geometry_order():
    batches = []
    def recognize(crops):
        batches.append([crop.size for crop in crops])
        return [str(crop.size) for crop in crops]
    ocr = MLXOCR.__new__(MLXOCR)
    ocr.batch_size, ocr._recognize = 2, recognize
    regions = [block((0, 0, 20, 20), 3), block((-3, -3, 2, 2)),
               block((2, 2, 5, 6)), block((30, 30, 40, 40))]
    result = asyncio.run(ocr.recognize(np.zeros((20, 20, 3), np.uint8), regions, None))
    assert batches == [[(2, 2), (3, 4)], [(20, 20)]]
    assert [r.texts for r in result] == [['(20, 20)', '', ''], ['(2, 2)'], ['(3, 4)'], []]
    assert [r.line_aligned for r in result] == [False, True, True, False]
    assert all(r.language is None for r in result)
    assert regions[0].xyxy == (0, 0, 20, 20) and len(regions[0].lines) == 3


def test_empty_paragraphs_cannot_authorize_erasure_and_count_mismatch_fails():
    ocr = MLXOCR.__new__(MLXOCR)
    ocr.batch_size, ocr._recognize = 8, lambda crops: ['', '']
    rows = asyncio.run(ocr.recognize(np.zeros((10, 10, 3), np.uint8),
        [block((0, 0, 5, 5)), block((0, 0, 5, 5), 2)], None))
    assert not any(''.join(row.texts) for row in rows)
    with pytest.raises(ValueError):
        asyncio.run(ocr.recognize(np.zeros((10, 10, 3), np.uint8), [block((0, 0, 5, 5))], None))


def test_worker_uses_exact_interpreter_and_does_not_replay_failed_page(tmp_path, monkeypatch):
    executable = tmp_path / 'python'
    executable.symlink_to(sys.executable)
    starts, responses = [], iter([RuntimeError('worker crashed'), {'texts': []}])
    def start(self):
        starts.append(self.python)
        self._process = SimpleNamespace(poll=lambda: None)
        return {'backend': 'mlx8'}
    def close(self):
        self._process = None
    def exchange(self, request):
        value = next(responses)
        if isinstance(value, Exception):
            raise value
        return value
    monkeypatch.setattr(MLXOCR, '_start', start)
    monkeypatch.setattr(MLXOCR, '_exchange', exchange)
    monkeypatch.setattr(MLXOCR, 'close', close)
    worker = MLXOCR(executable, tmp_path)
    with pytest.raises(RuntimeError, match='worker crashed'):
        worker._recognize([Image.new('RGB', (2, 2))])
    assert worker._process is None and starts == [str(executable)]
    assert worker._recognize([Image.new('RGB', (2, 2))]) == []
    assert starts == [str(executable)] * 2


@pytest.mark.parametrize('child,expected', [
    ("import sys; sys.stdin.readline(); print('{\"texts\": []}', flush=True)", None),
    ('pass', RuntimeError),
    ("import sys; sys.stdin.buffer.read()", TimeoutError),
])
def test_worker_pipes_finish_exit_or_timeout_and_close(child, expected):
    worker = MLXOCR.__new__(MLXOCR)
    process = subprocess.Popen([sys.executable, '-c', child], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    worker._process = process
    os.set_blocking(process.stdin.fileno(), False)
    os.set_blocking(process.stdout.fileno(), False)
    try:
        if expected:
            with pytest.raises(expected):
                worker._exchange(b'{}\n', timeout=.3)
        else:
            assert worker._exchange(b'{}\n', timeout=5) == {'texts': []}
    finally:
        worker.close()
    assert process.poll() is not None and process.stdin.closed and process.stdout.closed


def test_quantized_model_verification_requires_complete_int8_artifact(tmp_path):
    from mtu_engine.ocr.models import MODEL_REVISION, MODEL_SHA256, PROCESSOR_FILES, digest, verify_mlx
    for name in ('model.safetensors', 'model.safetensors.index.json', 'SOURCE-README.md', *PROCESSOR_FILES):
        (tmp_path / name).write_text('fixture')
    (tmp_path / 'config.json').write_text(json.dumps({'quantization': {'bits': 8, 'group_size': 64}}))
    manifest = {'source_revision': MODEL_REVISION, 'source_sha256': MODEL_SHA256, 'bits': 8,
                'files': {p.name: {'sha256': digest(p)} for p in tmp_path.iterdir()}}
    path = tmp_path / 'conversion-source.json'
    path.write_text(json.dumps(manifest))
    assert verify_mlx(tmp_path)['backend'] == 'mlx8'
    manifest['bits'] = 4
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match='quantization'):
        verify_mlx(tmp_path)
    manifest['bits'] = 8
    path.write_text(json.dumps(manifest))
    (tmp_path / 'model.safetensors').write_text('changed')
    with pytest.raises(ValueError, match='checksum'):
        verify_mlx(tmp_path)
    del manifest['files']['model.safetensors']
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match='quantization'):
        verify_mlx(tmp_path)


def test_inactive_classic_options_do_not_block_mlx_or_enter_diagnostics(tmp_path):
    config = load(configuration(tmp_path, ocr_min_batch_size=99,
        ocr_arena_extend_strategy='unused', ocr_arena_shrinkage='unused'))
    assert not {'ocr_min_batch_size', 'ocr_arena_extend_strategy', 'ocr_arena_shrinkage'} & config['engine'].keys()
    assert execution_settings(config)['engine']['ocr_backend'] == 'mlx8'


def test_truncated_generation_is_empty_and_batch_generator_closes(monkeypatch):
    from mtu_engine.ocr.worker import XiaomiModel
    tensor = SimpleNamespace(numpy=lambda: np.zeros((2, 2)))
    reader = XiaomiModel.__new__(XiaomiModel)
    reader.processor = SimpleNamespace(
        apply_chat_template=lambda *a, **kw: dict.fromkeys(
            ('input_ids', 'attention_mask', 'pixel_values', 'image_grid_thw'), tensor),
        tokenizer=SimpleNamespace(decode=lambda tokens, **kw: 'complete text'))
    reader.model = SimpleNamespace(language_model=None,
        get_input_embeddings=lambda *a, **kw: SimpleNamespace(to_dict=lambda: {}))
    reader.generation_processor = None
    closed = []
    class Generator:
        has_work = True
        def __init__(self, *a, **kw): pass
        def insert(self, *a, **kw): return [7, 3]
        def next(self):
            self.has_work = False
            return [], [SimpleNamespace(uid=3, token=2, finish_reason='length'),
                        SimpleNamespace(uid=7, token=1, finish_reason='stop')]
        def close(self): closed.append(True)
    monkeypatch.setitem(sys.modules, 'mlx', SimpleNamespace(core=SimpleNamespace(array=lambda x: x, synchronize=lambda: None)))
    monkeypatch.setitem(sys.modules, 'mlx.core', sys.modules['mlx'].core)
    monkeypatch.setitem(sys.modules, 'mlx_vlm.generate.ar', SimpleNamespace(
        BatchGenerator=Generator, _split_prompt_kwargs_per_row=lambda *a: {}))
    assert reader.recognize([Image.new('RGB', (2, 2))] * 2) == ['complete text', '']
    assert closed == [True]


@pytest.mark.parametrize('fails', [False, True])
def test_preparation_publishes_only_complete_self_contained_int8(tmp_path, monkeypatch, fails):
    from tools import prepare_xiaomi
    from mtu_engine.ocr import models
    source, output = tmp_path / 'source', tmp_path / 'prepared'
    source.mkdir()
    for name in (*models.PROCESSOR_FILES, 'README.md', 'model.safetensors'):
        (source / name).write_text('original ' + name)
    checksum = models.digest(source / 'model.safetensors')
    monkeypatch.setattr(models, 'MODEL_SHA256', checksum)
    monkeypatch.setattr(prepare_xiaomi, 'MODEL_SHA256', checksum)
    monkeypatch.setattr(prepare_xiaomi, 'version', lambda _: 'test')
    def convert(src, dst, **options):
        assert options['q_bits'] == 8 and options['q_group_size'] == 64
        dst = Path(dst)
        dst.mkdir()
        (dst / 'model.safetensors').write_text('quantized')
        if fails:
            raise RuntimeError('conversion failed')
        (dst / 'config.json').write_text(json.dumps({'quantization': {'bits': 8, 'group_size': 64}}))
        (dst / 'model.safetensors.index.json').write_text('{}')
    monkeypatch.setitem(sys.modules, 'mlx_vlm.convert', SimpleNamespace(convert=convert))
    # Restore environment modified by preparation after each test.
    for name in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'TOKENIZERS_PARALLELISM'):
        monkeypatch.setenv(name, '1')
    if fails:
        with pytest.raises(RuntimeError, match='conversion failed'):
            prepare_xiaomi.prepare(source, output)
        assert not output.exists()
    else:
        assert prepare_xiaomi.prepare(source, output)['backend'] == 'mlx8'
        for name in models.PROCESSOR_FILES:
            assert (output / name).read_bytes() == (source / name).read_bytes()
        assert (output / 'SOURCE-README.md').read_bytes() == (source / 'README.md').read_bytes()
        assert prepare_xiaomi.prepare(tmp_path / 'absent-source', output) == models.verify_mlx(output)
    assert not list(tmp_path.glob('xiaomi-*'))
