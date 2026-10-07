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


def test_resolved_cpu_settings_start_only_cpu_pool_and_do_not_change_identity(monkeypatch, tmp_path):
    config = prepare(monkeypatch, tmp_path, str.isascii)
    config.update(render_workers=1, _render_threads=2)
    config['engine']['threads'] = 2
    direct = runtime.Runtime(config)
    assert direct.render_pool is None and direct.render_ipc_bytes(80, 64) == 0
    calls = []
    pool = SimpleNamespace(close=lambda: calls.append('closed'))
    monkeypatch.setattr(runtime, 'RenderPool', lambda *args: (calls.append(args), pool)[1])
    config.update(render_workers=4, _render_threads=1)
    config['engine']['threads'] = 3
    parallel = runtime.Runtime(config)
    assert parallel.version == direct.version and parallel.render_pool is pool
    assert calls == [('unused', config['engine']['font'], 4, 1)]
    parallel.close()
    assert calls[-1] == 'closed'
