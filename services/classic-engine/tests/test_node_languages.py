"""Target capabilities use Qt glyph coverage and the selected font fingerprint."""
from types import SimpleNamespace

import pytest

from classic_node import runtime


def prepare(monkeypatch, tmp_path, covers):
    font = tmp_path / 'font.fixture'
    font.write_bytes(b'font identity')
    monkeypatch.setattr(runtime, 'model_identity', lambda *args: {})
    monkeypatch.setattr(runtime, 'package_version', lambda *args: 'test')
    monkeypatch.setattr(runtime, 'Engine', lambda **kwargs: SimpleNamespace(
        renderer=SimpleNamespace(covers=covers), close=lambda: None))
    return {'engine': {'models': 'unused', 'gpu': 0, 'font': [str(font)]}}


def test_ascii_font_reports_only_renderable_targets(monkeypatch, tmp_path):
    config = prepare(monkeypatch, tmp_path, str.isascii)
    node = runtime.Runtime(config)
    assert node.languages == ['en', 'id']
    first = node.version
    (tmp_path / 'font.fixture').write_bytes(b'changed font')
    assert runtime.Runtime(config).version != first


def test_no_supported_font_rejects_before_claim(monkeypatch, tmp_path):
    config = prepare(monkeypatch, tmp_path, lambda text: False)
    with pytest.raises(ValueError, match='Fonts do not cover'):
        runtime.Runtime(config)
