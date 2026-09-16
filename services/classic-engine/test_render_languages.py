"""Font integrity, transactional config and language-specific wrap semantics."""
import asyncio
import hashlib
from pathlib import Path
from unittest.mock import patch
import pytest
import render_languages as r
from hyphenation import DictionaryStore, resolve


def test_latin_sentence_spaces_and_font_cache_switching():
    from types import SimpleNamespace
    from unittest.mock import Mock
    compact = lambda text: text.replace('! ', '!')
    renderer = SimpleNamespace(compact_special_symbols=compact, get_char_glyph=Mock(), set_font=Mock())
    r.select_font(renderer, 'latin.ttf', 'fr')
    assert renderer.compact_special_symbols('Bonjour ! Ensemble...') == 'Bonjour ! Ensemble...'
    r.select_font(renderer, 'latin.ttf', 'pl')
    assert renderer.get_char_glyph.cache_clear.call_count == 1
    r.select_font(renderer, 'cjk.ttc', 'ja')
    assert renderer.compact_special_symbols is compact
    assert renderer.get_char_glyph.cache_clear.call_count == 2


def test_upstream_language_aliases_and_word_wrapping(tmp_path):
    for code, expected in [('PTB', 'pt-BR'), ('ESP', 'es-ES'), ('TRK', None), ('VIN', None), ('IND', None)]:
        assert resolve(code) == expected
    store = DictionaryStore(tmp_path, ['tr', 'vi', 'id'])
    for code in ['tr', 'TRK', 'vi', 'VIN', 'id', 'IND']:
        assert store.select(code).syllables('birlikte') == ['birlikte']


def test_font_integrity_and_offline_reuse(tmp_path, monkeypatch):
    monkeypatch.setenv('MODEL_DIR', str(tmp_path))
    raw = b'synthetic-font-resource'
    monkeypatch.setattr(r, 'FONT_RESOURCES', (('test.ttf', 'test.ttf', len(raw), hashlib.sha256(raw).hexdigest()),))
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, size): return raw
    with patch('urllib.request.urlopen', return_value=Response()) as request:
        r.prepare_fonts(['pl'])
        r.prepare_fonts(['uk'])
        assert request.call_count == 1
    path = r.font_directory() / 'test.ttf'
    path.write_bytes(b'corrupt')
    with patch('urllib.request.urlopen', side_effect=RuntimeError('offline')):
        with pytest.raises(RuntimeError): r.prepare_fonts(['pl'])
    assert path.read_bytes() == b'corrupt'


def test_failed_font_preparation_does_not_publish_configuration():
    import server
    class Request:
        async def stream(self): yield b'{"languages":["tr"]}'
    before = server.effective_runtime
    with patch.object(server, 'prepare_languages'), patch.object(server, 'prepare_fonts', side_effect=RuntimeError('checksum')):
        result = asyncio.run(server.configure(Request()))
    assert result.status_code == 422
    assert server.effective_runtime is before


def test_unknown_language_returns_specific_code_before_configuration_or_inference():
    import json
    import server
    class Request:
        def __init__(self, body): self.body = body
        async def stream(self): yield json.dumps(self.body).encode()
    before = server.effective_runtime
    response = asyncio.run(server.configure(Request({'languages':['xx']})))
    assert response.status_code == 422 and json.loads(response.body)['error'] == 'LANGUAGE_UNSUPPORTED'
    assert server.effective_runtime is before
    response = asyncio.run(server.process('render', Request({'language':'xx'})))
    assert response.status_code == 422 and json.loads(response.body)['error'] == 'LANGUAGE_UNSUPPORTED'
