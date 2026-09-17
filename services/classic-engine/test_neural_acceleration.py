from types import SimpleNamespace

import pytest
import torch
from torch import nn
from manga_translator.ocr.model_48px import XposMultiheadAttention
from neural_acceleration import NeuralAcceleration, ProjectionCache


class ToyOCR(nn.Module):
    def __init__(self):
        super().__init__()
        self.attention = XposMultiheadAttention(80, 2, encoder_decoder_attention=True)

    def infer_beam_batch_tensor(self, query, memory, fail=False):
        first = self.attention(query, memory, memory)[0]
        second = self.attention(query, memory, memory, q_offset=1)[0]
        if fail:
            raise ValueError('batch failed')
        return [(first, second)]


@pytest.mark.parametrize('device', ['cpu', 'cuda:0'])
def test_projection_cache_exact_attention_invalidation_and_bounds(device):
    if device.startswith('cuda') and not torch.cuda.is_available():
        pytest.skip('CUDA unavailable')
    torch.manual_seed(13)
    network = ToyOCR().eval().to(device)
    module = network.attention
    original = module.forward
    q = torch.randn(2, 1, 80, device=device)
    memory = torch.randn(2, 37, 80, device=device)
    cache = ProjectionCache(network)
    cache.active = True
    with torch.no_grad():
        for offset in [0, 1, 3, 7]:
            padding = torch.arange(37, device=device).expand(2, -1) > 20
            for mask in [padding, torch.ones_like(padding), None]:
                expected = original(q, memory, memory, key_padding_mask=mask, q_offset=offset)[0]
                actual = module(q, memory, memory, key_padding_mask=mask, q_offset=offset)[0]
                torch.testing.assert_close(actual, expected, rtol=0, atol=0, equal_nan=True)
        assert cache.misses == 1 and cache.hits == 11
        memory.add_(.1)
        assert torch.equal(module(q, memory, memory)[0], original(q, memory, memory)[0])
        assert cache.misses == 2
        compact = memory[:1].clone()
        assert torch.equal(module(q[:1], compact, compact)[0], original(q[:1], compact, compact)[0])
        assert cache.misses == 3
        explicit = torch.zeros(1, 37, device=device)
        assert torch.equal(module(q, memory, memory, attn_mask=explicit)[0], original(q, memory, memory, attn_mask=explicit)[0])
        # Returned attention weights and explicit masks use the pinned code.
        torch.testing.assert_close(module(q, memory, memory, need_weights=True),
                                   original(q, memory, memory, need_weights=True), rtol=0, atol=0)
    cache.close()
    assert module.forward == original and cache.size == 0
    bounded = ProjectionCache(network, max_bytes=1)
    with torch.no_grad():
        rows = network.infer_beam_batch_tensor(q, memory)
    assert not bounded.entries and bounded.peak_bytes == 0 and rows[0][0].device.type == 'cpu'
    bounded.close()


def test_batch_success_failure_and_training_do_not_retain_page_data():
    model = ToyOCR().eval()
    original = model.infer_beam_batch_tensor
    cache = ProjectionCache(model)
    q, memory = torch.randn(2, 1, 80), torch.randn(2, 13, 80)
    with torch.no_grad():
        model.infer_beam_batch_tensor(q, memory)
        assert not cache.active and not cache.entries and cache.size == 0 and cache.hits == 1
        with pytest.raises(ValueError, match='batch failed'):
            model.infer_beam_batch_tensor(q, memory, fail=True)
        assert not cache.active and not cache.entries and cache.size == 0
        misses = cache.misses
        model.infer_beam_batch_tensor(q, memory)
        assert cache.misses == misses + 1  # same tensor in new batch is not a hit
    q.requires_grad_(True)
    model.infer_beam_batch_tensor(q, memory)[0][0].sum().backward()
    assert torch.isfinite(q.grad).all()
    cache.close()
    assert model.infer_beam_batch_tensor == original


class ToyGenerator(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv = nn.Conv2d(3, 3, 3, padding=1)

    def forward(self, image, mask, rel_pos=None, direct=None):
        return self.conv(image * (1 - mask)).sigmoid()


def test_graph_dynamic_shapes_execution_and_close():
    generator = ToyGenerator().eval()
    ocr = ToyOCR().eval()
    models = {'inpainter': SimpleNamespace(model=SimpleNamespace(generator=generator, mpe=None)),
              'ocr': SimpleNamespace(model=ocr)}
    original = generator.forward
    runtime = NeuralAcceleration(models)
    with torch.no_grad():
        for height, width in [(64, 96), (144, 72), (256, 256)]:
            image = torch.rand(1, 3, height, width)
            mask = torch.zeros(1, 1, height, width)
            torch.testing.assert_close(generator(image, mask), original(image, mask))
        with pytest.raises(ValueError, match='FP32'):
            generator(image.double(), mask.double())
    assert runtime.describe()['lama_graph_calls'] == 3
    runtime.close()
    assert generator.forward == original and runtime.graph is None


def test_graph_rejects_unvalidated_optional_mpe():
    generator = ToyGenerator().eval()
    original = generator.forward
    with pytest.raises(ValueError, match='MPE'):
        NeuralAcceleration({'inpainter': SimpleNamespace(model=SimpleNamespace(generator=generator, mpe=object())),
                            'ocr': SimpleNamespace(model=ToyOCR().eval())})
    assert generator.forward == original
