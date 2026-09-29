"""Lossless sparse RGB replacement pixels and canonical input validation."""
import hashlib
from io import BytesIO
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from classic_node.protocol import NodeFailure, digest, pack_result
from classic_node.runtime import Runtime


def fixture(alpha=None):
    image = Image.new('RGBA' if alpha is not None else 'RGB', (80, 64),
                      (240, 230, 220, alpha) if alpha is not None else (240, 230, 220))
    stream = BytesIO()
    image.save(stream, 'PNG')
    data = stream.getvalue()
    metadata = {'byte_size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                'width': 80, 'height': 64, 'mime': 'image/png', 'normalization_version': 1}
    runtime = Runtime.__new__(Runtime)
    runtime.version = 'test'
    runtime.engine = SimpleNamespace(font=[], direction='auto')
    analysis = {'input_hash': metadata['sha256'], 'segments': [{'id': '0'}],
                'regions': [{'bbox': [0, 0, 80, 64]}]}
    translated = {'analysis_hash': digest(analysis), 'language': 'en',
                  'translations': {'0': 'Hello'}, 'revision': 'a' * 64}
    return runtime, data, metadata, analysis, translated


@pytest.mark.parametrize('alpha', [None, 255, 90, 1, 0])
def test_render_crops_all_inpaint_and_lettering_changes_and_preserves_source_alpha(monkeypatch, alpha):
    import classic_node.runtime as module
    runtime, data, metadata, analysis, translated = fixture(alpha)
    rgb, opacity = runtime.decode(data, metadata)
    cleaned = rgb.copy()
    cleaned[6, 7] = (31, 45, 60)  # Erasure may be outside the new glyph.
    monkeypatch.setattr(module, 'lettering_areas', lambda *a: [None])
    monkeypatch.setattr(module, 'resolve_colors', lambda *a: ('black', 'white'))
    def draw(canvas, *args, **kwargs):
        canvas.putpixel((10, 10), (100, 101, 102))  # Includes already antialiased RGB.
        return {'rendered': True}
    monkeypatch.setattr(module, 'draw_region', draw)
    packed = runtime.render(rgb, cleaned, analysis, translated, 'en', opacity)
    result, output = packed['result'], packed['output_bytes']
    assert 'image' not in packed and result['normalization_version'] == 1
    assert (result['width'], result['height']) == (80, 64)
    if alpha == 0:
        assert result['representation'] == 'original' and result['bbox'] is None
        assert output is None and result['output'] is None
        return
    assert result['representation'] == 'overlay-v1'
    assert result['bbox'] == {'x': 7, 'y': 6, 'width': 4, 'height': 5}
    assert result['output']['sha256'] == hashlib.sha256(output).hexdigest()
    assert result['output']['byte_size'] == len(output) and 'md5' not in result['output']
    with Image.open(BytesIO(output)) as patch:
        assert patch.format == 'WEBP' and patch.size == (4, 5)
        rgba = np.asarray(patch.convert('RGBA'))
    assert set(np.unique(rgba[..., 3])) == {0, 255}
    assert tuple(rgba[0, 0]) == (31, 45, 60, 255)
    assert tuple(rgba[4, 3]) == (100, 101, 102, 255)
    # Integer 1:1 source-atop with binary source alpha replaces RGB only.
    reconstructed = np.array(Image.open(BytesIO(data)).convert('RGBA'))
    region = reconstructed[6:11, 7:11, :3]
    region[rgba[..., 3] == 255] = rgba[..., :3][rgba[..., 3] == 255]
    expected = cleaned.copy()
    expected[10, 10] = (100, 101, 102)
    assert np.array_equal(reconstructed[..., :3], expected)
    assert np.all(reconstructed[..., 3] == (255 if alpha is None else alpha))


def test_zero_visible_diff_returns_successful_original_without_artifact():
    runtime, data, metadata, analysis, translated = fixture()
    rgb, alpha = runtime.decode(data, metadata)
    packed = pack_result(Image.fromarray(rgb), rgb, alpha, runtime.version, analysis, translated)
    assert packed['output_bytes'] is None
    assert packed['result']['representation'] == 'original'
    assert packed['result']['bbox'] is packed['result']['output'] is None


def test_result_encoding_uses_its_own_byte_limit(monkeypatch):
    import classic_node.protocol as protocol
    runtime, data, metadata, analysis, translated = fixture()
    rgb, alpha = runtime.decode(data, metadata)
    final = Image.fromarray(rgb)
    final.putpixel((1, 1), (10, 20, 30))
    monkeypatch.setattr(protocol, 'MAX_IMAGE_BYTES', 1)
    packed = pack_result(final, rgb, alpha, runtime.version, analysis, translated)
    assert len(packed['output_bytes']) > protocol.MAX_IMAGE_BYTES
    monkeypatch.setattr(protocol, 'MAX_RESULT_BYTES', len(packed['output_bytes']) - 1)
    with pytest.raises(NodeFailure, match='CLASSIC_RENDER_FAILED'):
        pack_result(final, rgb, alpha, runtime.version, analysis, translated)


def test_hidden_rgb_changes_do_not_expand_the_visible_bbox():
    runtime, data, metadata, analysis, translated = fixture(0)
    rgb, alpha = runtime.decode(data, metadata)
    alpha.putpixel((10, 10), 90)
    final = Image.fromarray(rgb)
    final.putpixel((0, 0), (10, 20, 30))
    final.putpixel((10, 10), (40, 50, 60))
    packed = pack_result(final, rgb, alpha, runtime.version, analysis, translated)
    assert packed['result']['bbox'] == {'x': 10, 'y': 10, 'width': 1, 'height': 1}


@pytest.mark.parametrize('change', ['normalization', 'orientation', 'icc'])
def test_decode_rejects_noncanonical_inputs(change):
    runtime, data, metadata, *_ = fixture()
    if change == 'normalization':
        metadata['normalization_version'] = 2
    else:
        image = Image.open(BytesIO(data))
        options = {'icc_profile': b'unconverted-profile'} if change == 'icc' else {'exif': Image.Exif()}
        if change == 'orientation':
            options['exif'][274] = 6
        stream = BytesIO()
        image.save(stream, 'PNG', **options)
        data = stream.getvalue()
        metadata.update(byte_size=len(data), sha256=hashlib.sha256(data).hexdigest())
    with pytest.raises(NodeFailure, match='INPUT_INVALID'):
        runtime.decode(data, metadata)
