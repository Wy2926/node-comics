"""Target languages follow installed fonts, without operator whitelists or models."""
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

import pytest

from classic_node import runtime


@pytest.fixture
def no_models(monkeypatch):
    monkeypatch.setattr(runtime, 'model_identity', lambda *args: {})
    monkeypatch.setattr(runtime, 'package_version', lambda *args: 'test')
    monkeypatch.setattr(runtime, 'Engine', lambda **kwargs: SimpleNamespace(close=lambda: None))
    return {'engine': {'models': 'unused', 'ocr_language': 'auto', 'gpu': -1, 'font': []}}


def test_ascii_font_reports_only_renderable_targets_and_is_hashed_once(no_models, monkeypatch, tmp_path):
    font = tmp_path / 'ascii.fixture'
    font.write_bytes(b'isolated font identity')
    monkeypatch.setattr(runtime, 'font_paths', lambda *args: (str(font),))
    monkeypatch.setattr(runtime, 'coverage', lambda *args: frozenset(range(128)))
    original = runtime.file_hash
    hashed = Counter()

    def file_hash(path):
        hashed[str(path)] += 1
        return original(path)

    monkeypatch.setattr(runtime, 'file_hash', file_hash)
    node = runtime.Runtime(no_models)
    assert node.languages == ['en', 'id']
    assert hashed[str(font)] == 1
    node.close()


def test_no_supported_font_rejects_node_before_it_can_claim(no_models, monkeypatch):
    monkeypatch.setattr(runtime, 'font_paths', lambda *args: ())
    with pytest.raises(ValueError, match='Fonts do not cover'):
        runtime.Runtime(no_models)


def test_bundled_noto_font_reports_multilingual_targets(no_models):
    font = Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
    if not font.is_file():
        pytest.skip('Docker Noto Sans CJK acceptance')
    no_models['engine']['font'] = [str(font)]
    node = runtime.Runtime(no_models)
    assert {'zh-Hans', 'zh-Hant', 'ja', 'ko', 'en', 'fr', 'es', 'de'} <= set(node.languages)
    node.close()
