from threading import Lock
from types import SimpleNamespace
import json

import numpy as np
import pytest

from manhua_engine.inpainting import Lama, CHECKSUM, ARCHITECTURE
from manhua_engine.quality import repair_page, repair_region


def test_checkpoint_is_verified_before_deserialization(tmp_path, monkeypatch):
    root = tmp_path / 'lama-onnx'
    root.mkdir()
    path = root / 'lama-large-512.onnx'
    path.write_bytes(b'wrong checkpoint')
    (root / 'build.json').write_text(json.dumps({'architecture': ARCHITECTURE,
        'checkpoint_sha256': CHECKSUM, 'precision': 'fp32', 'file': path.name, 'sha256': '0'*64}))
    def forbidden(*args, **kwargs):
        raise AssertionError('Unverified checkpoint was deserialized')
    monkeypatch.setattr('manhua_engine.inpainting.ort.InferenceSession', forbidden)
    with pytest.raises(ValueError, match='checksum'):
        Lama(tmp_path)


def test_lama_uses_unit_rgb_binary_mask_and_rejects_nonfinite_outputs():
    net = Lama.__new__(Lama)
    net.lock = Lock()
    image = np.full((16, 24, 3), 255, np.uint8)
    mask = np.zeros((16, 24), np.uint8)
    mask[4:8, 8:12] = 255
    def model(outputs, inputs):
        rgb, binary = inputs['image'], inputs['mask']
        assert rgb.shape == (1, 3, 512, 512) and rgb.dtype == np.float32
        assert rgb.min() == rgb.max() == 1
        assert set(np.unique(binary)) == {0, 1}
        return [rgb * .5]
    net.session = SimpleNamespace(run=model)
    assert np.all(net.predict(image, mask) == 127.5)
    net.session.run = lambda outputs, inputs: [inputs['image'] * float('nan')]
    with pytest.raises(ValueError, match='output'):
        net.predict(image, mask)


def test_gpu_never_silently_uses_cpu(tmp_path, monkeypatch):
    monkeypatch.setattr('manhua_engine.inpainting.model_identity', lambda _: {})
    monkeypatch.setattr('manhua_engine.inpainting.ort.get_available_providers', lambda: ['CPUExecutionProvider'])
    with pytest.raises(RuntimeError, match='no automatic CPU fallback'):
        Lama(tmp_path, gpu=0)


def test_reflected_text_is_masked_in_fixed_size_padding():
    net = Lama.__new__(Lama)
    net.lock = Lock()
    image = np.full((17, 29, 3), 255, np.uint8)
    mask = np.zeros((17, 29), np.uint8)
    image[3:11, 7:19] = 0
    mask[3:11, 7:19] = 255
    def model(outputs, inputs):
        dark = inputs['image'][:, :1] == 0
        assert dark.sum() > 8 * 12  # Reflected copies exist outside the crop.
        assert np.all(inputs['mask'][dark] == 1)
        return [np.ones_like(inputs['image'])]
    net.session = SimpleNamespace(run=model)
    assert np.all(net.predict(image, mask) == 255)


@pytest.mark.parametrize('shape', [(1, 1), (31, 47), (900, 600)])
def test_lama_crop_keeps_unmasked_pixels_even_at_edges(shape):
    h, w = shape
    image = np.full((h, w, 3), 100, np.uint8)
    mask = np.zeros((h, w), np.uint8)
    mask[:max(1, h // 2), :max(1, w // 2)] = 255
    class Net:
        def predict(self, rgb, mask):
            assert all(n % 8 == 0 and n <= 256 for n in mask.shape)
            return np.full_like(rgb, 200, dtype=np.float32)
    result = repair_region(Net(), image, mask, 256)
    assert np.array_equal(result[mask == 0], image[mask == 0])
    assert np.all(np.abs(result[mask > 0].astype(int) - 200) <= 1)


def test_empty_mask_does_not_run_model():
    class Net:
        def predict(self, *args):
            raise AssertionError('Blank page must skip inference')
    image = np.full((20, 30, 3), 100, np.uint8)
    result, windows = repair_page(Net(), image, np.zeros((20, 30), np.uint8))
    assert windows == 0 and np.array_equal(result, image)


@pytest.mark.parametrize('position',[(0,0),(65,80),(151,181)])
def test_model_gets_context_margin_but_output_preserves_every_unmasked_pixel(position):
    image=np.random.default_rng(7).integers(0,256,(160,190,3),dtype=np.uint8)
    mask=np.zeros(image.shape[:2],np.uint8)
    y,x=position
    mask[y:y+9,x:x+9]=255
    calls=[]
    class Net:
        input_size=512
        def predict(self,rgb,inference_mask):
            # Expanded inference mask contains more pixels than the write mask,
            # including boundary cases; the model may modify the entire crop.
            calls.append(int((inference_mask>0).sum()))
            return np.full_like(rgb,213,dtype=np.float32)
    result,windows=repair_page(Net(),image,mask)
    assert windows==1 and calls[0]>int((mask>0).sum())
    assert np.array_equal(result[mask==0],image[mask==0])
    assert np.all(result[mask>0]==213)
