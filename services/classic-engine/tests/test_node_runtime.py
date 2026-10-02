"""Lossless sparse RGB replacement pixels and canonical input validation."""
import hashlib
from io import BytesIO
import json
import struct
import zlib
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image
from PIL import ImageDraw

from classic_node.protocol import NodeFailure, digest, pack_result, png64
from classic_node.pipeline import Pipeline
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
    from manhua_engine.timing import collect
    with collect() as timings:
        packed = runtime.render(rgb, cleaned, analysis, translated, 'en', opacity)
    assert {'render_areas', 'render_layout', 'render_diff'} <= timings.keys()
    assert all(value >= 0 for value in timings.values())
    result, output = packed['result'], packed['output_bytes']
    assert 'image' not in packed and result['normalization_version'] == 1
    assert (result['width'], result['height']) == (80, 64)
    if alpha == 0:
        assert result['representation'] == 'original' and result['bbox'] is None
        assert output is None and result['output'] is None
        return
    assert result['representation'] == 'overlay-v1'
    assert 'render_encode' in timings and 'timings' not in result
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
    monkeypatch.setattr(protocol, 'MAX_MASK_BYTES', 1)
    packed = pack_result(final, rgb, alpha, runtime.version, analysis, translated)
    assert len(packed['output_bytes']) > protocol.MAX_MASK_BYTES
    monkeypatch.setattr(protocol, 'MAX_RESULT_BYTES', len(packed['output_bytes']) - 1)
    with pytest.raises(NodeFailure, match='CLASSIC_OUTPUT_TOO_LARGE'):
        pack_result(final, rgb, alpha, runtime.version, analysis, translated)


@pytest.mark.parametrize('changed', [False, True])
def test_all_removed_text_still_completes_with_cleaned_pixels(monkeypatch, changed):
    import classic_node.runtime as module
    runtime, data, metadata, analysis, translated = fixture()
    translated['translations']['0'] = '\U0010FFFF'
    rgb, alpha = runtime.decode(data, metadata)
    cleaned = rgb.copy()
    if changed:
        cleaned[1, 1] = (10, 20, 30)
    monkeypatch.setattr(module, 'lettering_areas', lambda *args: [None])
    result = runtime.render(rgb, cleaned, analysis, translated, 'en', alpha)
    assert result['result']['representation'] == ('overlay-v1' if changed else 'original')


def test_removed_segment_does_not_block_following_text(monkeypatch):
    import classic_node.runtime as module
    runtime, data, metadata, analysis, translated = fixture()
    analysis['regions'][0]['dir'] = 'h'
    analysis['regions'].append({'bbox': [0, 0, 80, 64], 'dir': 'h'})
    analysis['segments'].append({'id': '1'})
    translated.update(analysis_hash=digest(analysis), translations={'0': '\U0010FFFF', '1': 'Hello'})
    rgb, alpha = runtime.decode(data, metadata)
    monkeypatch.setattr(module, 'lettering_areas', lambda *args: [None, None])
    result = runtime.render(rgb, rgb.copy(), analysis, translated, 'en', alpha)
    assert result['result']['representation'] == 'overlay-v1'


def test_render_checkpoint_mismatch_has_specific_error():
    runtime, data, metadata, analysis, translated = fixture()
    translated['language'] = 'ja'
    rgb, alpha = runtime.decode(data, metadata)
    with pytest.raises(NodeFailure, match='CLASSIC_RENDER_MISMATCH'):
        runtime.render(rgb, rgb, analysis, translated, 'en', alpha)


def test_output_encoding_error_is_not_a_local_interruption(monkeypatch):
    runtime, data, metadata, analysis, translated = fixture()
    rgb, alpha = runtime.decode(data, metadata)
    final = Image.fromarray(rgb)
    final.putpixel((1, 1), (10, 20, 30))
    def fail(*args, **kwargs):
        raise OSError('encoder failed')
    monkeypatch.setattr(Image.Image, 'save', fail)
    with pytest.raises(NodeFailure, match='CLASSIC_OUTPUT_ENCODE_FAILED'):
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


@pytest.mark.parametrize('size', [(800, 12000), (5000, 5000)])
def test_decode_uses_center_metadata_without_independent_pixel_or_edge_limit(size):
    runtime, _, metadata, *_ = fixture()
    stream = BytesIO()
    Image.new('RGB', size, 'white').save(stream, 'PNG')
    data = stream.getvalue()
    metadata.update(width=size[0], height=size[1], byte_size=len(data), sha256=hashlib.sha256(data).hexdigest())
    rgb, alpha = runtime.decode(data, metadata)
    assert rgb.shape == (size[1], size[0], 3) and alpha is None
    metadata['height'] += 1
    with pytest.raises(NodeFailure, match='INPUT_INVALID'):
        runtime.decode(data, metadata)


def test_tiles_partition_final_glyph_pixels_across_boundaries_without_relayout():
    rgb = np.full((20000, 64, 3), 240, dtype=np.uint8)
    final = Image.fromarray(rgb)
    drawing = ImageDraw.Draw(final)
    drawing.point((0, 0), fill=(10, 20, 30))
    drawing.text((4, 4092), 'Boundary', fill=(0, 0, 0))
    drawing.point((63, 19999), fill=(40, 50, 60))
    analysis = {'input_hash': 'a' * 64}
    translated = {'analysis_hash': 'b' * 64, 'revision': 'c' * 64}
    with pytest.raises(NodeFailure, match='CLASSIC_OUTPUT_TOO_LARGE'):
        pack_result(final, rgb, None, 'test', analysis, translated)
    packed = pack_result(final, rgb, None, 'test', analysis, translated, allow_tiles=True)
    data = packed['output_bytes']
    assert packed['result']['representation'] == 'overlay-tiles-v1' and data[:8] == b'NCOT0001'
    length = struct.unpack('<I', data[8:12])[0]
    manifest = json.loads(data[12:12 + length])
    restored, offset = rgb.copy(), 12 + length
    for tile in manifest['tiles']:
        body = data[offset:offset + tile['byte_size']]
        offset += tile['byte_size']
        assert hashlib.sha256(body).hexdigest() == tile['sha256']
        assert tile['width'] <= 2048 and tile['height'] <= 4096
        patch = np.asarray(Image.open(BytesIO(body)).convert('RGBA'))
        x, y, w, h = (tile[key] for key in ('x', 'y', 'width', 'height'))
        mask = patch[..., 3] == 255
        restored[y:y + h, x:x + w][mask] = patch[..., :3][mask]
    assert offset == len(data) and np.array_equal(restored, np.asarray(final))
    assert any(tile['y'] < 4096 for tile in manifest['tiles']) and any(4096 <= tile['y'] < 4200 for tile in manifest['tiles'])


def test_tile_capability_preserves_existing_single_webp_bytes():
    runtime, data, _, analysis, translated = fixture()
    rgb = np.array(Image.open(BytesIO(data)))
    final = Image.fromarray(rgb)
    final.putpixel((10, 10), (0, 0, 0))
    ordinary = pack_result(final, rgb, None, runtime.version, analysis, translated)
    assert pack_result(final, rgb, None, runtime.version, analysis, translated, allow_tiles=True) == ordinary


def corrupt_png_pixels(data):
    """Keep a valid PNG container/header/CRC, with invalid compressed pixel data."""
    result = data[:8]
    at = 8
    while at < len(data):
        length = struct.unpack('>I', data[at:at + 4])[0]
        kind, payload = data[at + 4:at + 8], data[at + 8:at + 8 + length]
        if kind == b'IDAT':
            payload = b'not-a-deflate-stream'
        result += struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))
        at += length + 12
    return result


def test_corrupt_input_pixels_fail_before_analysis_or_text_submission():
    runtime, data, metadata, *_ = fixture()
    data = corrupt_png_pixels(data)
    metadata.update(byte_size=len(data), sha256=hashlib.sha256(data).hexdigest())
    runtime.analyze = lambda *_: pytest.fail('corrupt input reached OCR')
    pipeline = Pipeline.__new__(Pipeline)
    pipeline.agent = SimpleNamespace(runtime=runtime)
    page = SimpleNamespace(data=data, metadata=metadata, analysis=None)
    with pytest.raises(NodeFailure, match='^INPUT_INVALID$'):
        pipeline.prepare(page)


def test_input_decode_memory_failure_has_a_terminal_resource_code(monkeypatch):
    runtime, data, metadata, *_ = fixture()
    def exhaust(*_args, **_kwargs):
        raise MemoryError()
    monkeypatch.setattr(Image, 'open', exhaust)
    with pytest.raises(NodeFailure, match='^INPUT_MEMORY_EXCEEDED$'):
        runtime.decode(data, metadata)


@pytest.mark.parametrize('failure', ['corrupt', 'empty', 'wrong-size'])
def test_restored_checkpoint_pixels_are_checked_before_text_can_resume(failure):
    runtime, data, metadata, analysis, *_ = fixture()
    mask = Image.new('L', (1, 1) if failure == 'wrong-size' else (80, 64), 0 if failure == 'empty' else 255)
    encoded = png64(mask)
    if failure == 'corrupt':
        import base64
        encoded = base64.b64encode(corrupt_png_pixels(base64.b64decode(encoded))).decode()
    analysis['mask'] = encoded
    runtime.analyze = lambda *_: pytest.fail('restored analysis must not be regenerated')
    pipeline = Pipeline.__new__(Pipeline)
    pipeline.agent = SimpleNamespace(runtime=runtime)
    page = SimpleNamespace(data=data, metadata=metadata, analysis=analysis)
    with pytest.raises(NodeFailure, match='^CLASSIC_OCR_INVALID$'):
        pipeline.prepare(page)


@pytest.mark.parametrize('failure', ['corrupt', 'transparent', 'soft-alpha', 'wrong-size'])
@pytest.mark.parametrize('tiles', [False, True])
def test_encoded_overlay_pixels_are_verified_on_node_before_freezing(monkeypatch, failure, tiles):
    original = np.zeros((17000 if tiles else 16, 2, 3), dtype=np.uint8)
    final = Image.fromarray(original)
    final.putpixel((0, 0), (10, 20, 30))
    final.putpixel((1, original.shape[0] - 1), (40, 50, 60))
    real_save = Image.Image.save
    def broken_encoder(image, stream, *args, **kwargs):
        if failure == 'corrupt':
            stream.write(b'not-webp')
            return
        size = (image.width + 1, image.height) if failure == 'wrong-size' else image.size
        alpha = 0 if failure == 'transparent' else 64 if failure == 'soft-alpha' else 255
        with Image.new('RGBA', size, (10, 20, 30, alpha)) as broken:
            real_save(broken, stream, *args, **kwargs)
    monkeypatch.setattr(Image.Image, 'save', broken_encoder)
    with pytest.raises(NodeFailure, match='^CLASSIC_OUTPUT_ENCODE_FAILED$'):
        pack_result(final, original, None, 'test', {'input_hash': 'a' * 64},
                    {'analysis_hash': 'b' * 64, 'revision': 'c' * 64}, allow_tiles=tiles)
