"""The node owns encoding and preserves source transparency before direct upload."""
import base64
import hashlib
from io import BytesIO
from types import SimpleNamespace

import pytest
from PIL import Image
from classic_node.protocol import digest
from classic_node.runtime import Runtime


@pytest.mark.parametrize('alpha', [False, True])
def test_final_png_metadata_and_source_alpha_are_produced_on_node(monkeypatch, alpha):
    import classic_node.runtime as module
    image = Image.new('RGBA' if alpha else 'RGB', (80, 64), (255, 255, 255, 90) if alpha else 'white')
    stream = BytesIO()
    image.save(stream, 'PNG')
    data = stream.getvalue()
    metadata = {'byte_size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                'width': 80, 'height': 64, 'mime': 'image/png'}
    runtime = Runtime.__new__(Runtime)
    runtime.version = 'test'
    runtime.engine = SimpleNamespace(font=[], direction='auto')
    rgb, opacity = runtime.decode(data, metadata)
    analysis = {'input_hash': metadata['sha256'], 'segments': [{'id': '0'}], 'regions': [{'bbox': [0, 0, 80, 64]}]}
    translated = {'analysis_hash': digest(analysis), 'language': 'en', 'translations': {'0': 'Hello'}, 'revision': 'a'*64}
    monkeypatch.setattr(module, 'lettering_areas', lambda *a: [None])
    monkeypatch.setattr(module, 'resolve_colors', lambda *a: ('black', 'white'))
    def draw(canvas, *args, **kwargs):
        canvas.putpixel((10, 10), (0, 0, 0))
        return {'rendered': True}
    monkeypatch.setattr(module, 'draw_region', draw)
    packed = runtime.render(rgb, analysis, translated, 'en', opacity)
    output = base64.b64decode(packed['image'])
    info = packed['result']['output']
    assert info['sha256'] == hashlib.sha256(output).hexdigest()
    assert info['md5'] == hashlib.md5(output).hexdigest() and info['byte_size'] == len(output)
    with Image.open(BytesIO(output)) as result:
        assert result.format == 'PNG' and result.size == (80, 64)
        assert result.getpixel((10, 10))[:3] == (0, 0, 0)
        if alpha:
            assert result.getchannel('A').getextrema() == (90, 90)
