"""Automatic source-free routing, retries, and release asset identity."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from types import SimpleNamespace

import numpy as np
import pytest

from manhua_engine.ocr import Recognizer, korean_script


@pytest.mark.parametrize('text,confidence,expected', [
    ('한국어', .30, True), ('한', .8, True), ('한 ABC', .9, True),
    ('한 ABCD', .9, False), ('한국어', .29, False), ('日本語です', .99, False),
    ('简繁中文', .99, False), ('English', .99, False), ('123?!', .99, False), ('', .99, False),
])
def test_korean_route_requires_confident_hangul_script(text, confidence, expected):
    assert korean_script(text, confidence) is expected


def automatic(probe, small, korean):
    reader = Recognizer.__new__(Recognizer)
    reader.language = 'auto'
    reader.probe = SimpleNamespace(forward=probe)
    reader.small = SimpleNamespace(forward=small)
    reader.korean = SimpleNamespace(forward=korean)
    return reader


def pixels(value=255):
    return np.full((48,128,3), value, np.uint8), np.array([[0,0],[127,0],[127,47],[0,47]], np.float32)


def test_weak_raw_probe_routes_korean_and_preserves_colors():
    calls = Counter()
    def answer(name, text, confidence, fg=(0,0,0), bg=(255,255,255)):
        def forward(crop):
            calls[name] += 1
            return text, confidence, fg, bg
        return forward
    reader = automatic(answer('probe', '한국', .45, (120,30,20), (245,240,230)),
                       answer('small', 'wrong branch', .99), answer('ko', '한국어', .99))
    line = reader.read(*pixels())
    assert line['text'] == '한국어' and line['prob'] == .99
    assert line['fg'] == (120,30,20) and line['bg'] == (245,240,230)
    assert calls == {'probe':2, 'ko':1}
    assert line['attempts'] == 3


@pytest.mark.parametrize('confidence,accepted', [(.49, False), (.50, True), (.59, True)])
def test_final_filter_uses_selected_model_not_probe_confidence(confidence, accepted):
    reader = automatic(lambda _: ('English', .99, (0,0,0), (255,255,255)),
                       lambda _: ('selected text', confidence, (0,0,0), (255,255,255)),
                       lambda _: pytest.fail('Unexpected Korean recognition'))
    result = reader.read(*pixels())
    assert (result is not None) is accepted


def test_parallel_lines_do_not_share_a_last_language_selection():
    def probe(crop):
        return ('한국어' if crop[0,0,0] == 1 else 'English'), .99, (0,0,0), (255,255,255)
    reader = automatic(probe, lambda _: ('small', .99, (0,0,0), (255,255,255)),
                       lambda _: ('korean', .99, (0,0,0), (255,255,255)))
    values = [1,2] * 16
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda value: reader.read(*pixels(value))['text'], values))
    assert results == ['korean','small'] * 16


def test_warmup_includes_both_selection_branches():
    calls = []
    def forward(name):
        return lambda _: calls.append(name)
    automatic(forward('probe'), forward('small'), forward('korean')).warmup()
    assert calls == ['probe','small','korean']


@pytest.fixture
def assets(tmp_path, monkeypatch):
    import manhua_engine
    from manhua_engine import cli
    package = tmp_path / 'package'
    package.mkdir()
    source = tmp_path / 'source'
    source.mkdir()
    entries = []
    for name, language in [('detector.bin', None), ('ppocr/small.onnx', 'auto'),
                           ('ppocr/small.yml', 'auto'), ('ppocr/ko.onnx', 'ko'), ('ppocr/en.onnx', 'en')]:
        path = source / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(name.encode())
        entry = {'name':name, 'sha256':hashlib.sha256(path.read_bytes()).hexdigest(), 'url':path.as_uri()}
        if language: entry['language'] = language
        entries.append(entry)
    (package / 'models.json').write_text(json.dumps({'models':entries}))
    monkeypatch.setattr(cli, '__file__', str(package / 'cli.py'))
    monkeypatch.setattr(manhua_engine, '__file__', str(package / '__init__.py'))
    return source, entries


def test_auto_download_includes_small_dictionary_and_korean(assets, tmp_path):
    from manhua_engine.cli import download
    output = tmp_path / 'download'
    download(output, 'auto')
    assert {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()} == {
        'detector.bin', 'ppocr/small.onnx', 'ppocr/small.yml', 'ppocr/ko.onnx'}


def test_auto_identity_verifies_all_selected_models_and_dictionary(assets, monkeypatch):
    from classic_node.runtime import model_identity
    monkeypatch.setattr('manhua_engine.inpainting.model_identity', lambda _: {})
    root, entries = assets
    converted = root / 'ocr-fp32'
    converted.mkdir()
    files = {}
    for name in ('backbone.ncnn.param', 'backbone.ncnn.bin', 'decoder.onnx'):
        (converted / name).write_bytes(name.encode())
        files[name] = hashlib.sha256(name.encode()).hexdigest()
    (converted / 'build.json').write_text(json.dumps({
        'source_revision':'d5a3eee4a7b7b7754b71baa2ee82309dfff468bc',
        'checkpoint_sha256':'fc61c52f7a811bc72c54f6be85df814c6b60f63585175db27cb94a08e0c30101',
        'precision':'fp32', 'files':files}))
    identity = model_identity(root, 'auto')
    assert set(identity) == {'detector.bin', 'ppocr/small.onnx', 'ppocr/small.yml', 'ppocr/ko.onnx',
                             *(f'ocr-fp32/{name}' for name in files)}
    assert set(model_identity(root, 'ja')) == {'detector.bin', *(f'ocr-fp32/{name}' for name in files)}
    (root / 'ppocr/small.yml').write_bytes(b'wrong dictionary')
    with pytest.raises(ValueError, match='Model checksum mismatch: ppocr/small.yml'):
        model_identity(root, 'auto')
