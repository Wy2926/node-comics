"""Parallel color inference contracts; tiny CPU tensors, no model assets."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from classic_node.timing import collect
from mtu_engine.colors import _CpuColorModel, _ParallelCrossAttention

torch = pytest.importorskip('torch')


class _Embedding(torch.nn.Embedding):
    def __init__(self, owner):
        super().__init__(6, 8)
        self.owner = owner

    def forward(self, indices):
        self.owner.stage('embedding')
        self.owner.tokens.append(indices.clone())
        return super().forward(indices)


class _Xpos(torch.nn.Module):
    """Tiny native-style XPOS; offset-dependent centering is the regression."""
    def __init__(self, head_dim, scale_base):
        super().__init__()
        self.scale_base = scale_base
        self.register_buffer('scale', (torch.arange(0, head_dim, 2) + .4 * head_dim) / (1.4 * head_dim))

    def forward(self, values, offset=0, downscale=False):
        length = values.shape[1]
        total = length + offset
        first = -total // 2
        powers = torch.arange(first, first + total).to(self.scale) / self.scale_base
        scale = self.scale ** powers[:, None]
        frequency = 1 / (10000 ** (torch.arange(len(self.scale)) / len(self.scale)))
        phase = torch.arange(total, dtype=torch.float32)[:, None] * frequency
        sin, cos = phase.sin().to(values)[-length:], phase.cos().to(values)[-length:]
        scale = scale[-length:]
        if downscale:
            scale = 1 / scale
        sin, cos = ((value * scale).repeat_interleave(2, dim=-1) for value in (sin, cos))
        rotated = torch.stack((-values[..., 1::2], values[..., ::2]), dim=-1).flatten(-2)
        return values * cos + rotated * sin


class _Attention(torch.nn.Module):
    """Original bmm/softmax attention semantics, without the production view."""
    def __init__(self, owner, name):
        super().__init__()
        self.owner, self.name = owner, name
        self.embed_dim, self.num_heads, self.head_dim = 8, 2, 4
        self.scaling = self.head_dim ** -.5
        self.q_proj = torch.nn.Linear(8, 8)
        self.k_proj = torch.nn.Linear(8, 8)
        self.v_proj = torch.nn.Linear(8, 8)
        self.out_proj = torch.nn.Linear(8, 8)
        self.xpos = _Xpos(self.head_dim, self.embed_dim)

    def forward(self, query, key, value, key_padding_mask=None, attn_mask=None,
                need_weights=False, is_causal=False, k_offset=0, q_offset=0):
        self.owner.stage(self.name)
        assert not is_causal
        batch, length, _ = query.shape
        source = key.shape[1]

        def heads(tensor):
            return tensor.reshape(batch, -1, self.num_heads, self.head_dim).transpose(1, 2).reshape(
                batch * self.num_heads, -1, self.head_dim)

        q = heads(self.q_proj(query) * self.scaling)
        k, v = heads(self.k_proj(key)), heads(self.v_proj(value))
        q = self.xpos(q, offset=q_offset)
        k = self.xpos(k, offset=k_offset, downscale=True)
        scores = torch.bmm(q, k.transpose(1, 2))
        if attn_mask is not None:
            scores = torch.nan_to_num(scores) + attn_mask.unsqueeze(0)
        if key_padding_mask is not None:
            scores = scores.reshape(batch, self.num_heads, length, source).masked_fill(
                key_padding_mask[:, None, None, :], -torch.inf).reshape(-1, length, source)
        weights = scores.softmax(dim=-1, dtype=torch.float32).to(scores)
        output = torch.bmm(weights, v).transpose(0, 1).reshape(length, batch, self.embed_dim).transpose(0, 1)
        return self.out_proj(output), None


class _Layer(torch.nn.Module):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner
        self.norm1, self.norm2, self.norm3 = [torch.nn.LayerNorm(8) for _ in range(3)]
        self.self_attn = _Attention(owner, 'self_attention')
        self.multihead_attn = _Attention(owner, 'cross_attention')
        self.ff = torch.nn.Sequential(torch.nn.Linear(8, 16), torch.nn.GELU(), torch.nn.Linear(16, 8))

    def _ff_block(self, values):
        self.owner.stage('ff')
        return self.ff(values)


class _Decoders(torch.nn.ModuleList):
    def forward(self, *args, **kwargs):
        pytest.fail('Parallel colors must not call the incremental decoder/cache interface')


class _TinyModel:
    dictionary = ['<PAD>', '<S>', '</S>', 'A', 'B', '<SP>']

    def __init__(self):
        self.stages, self.tokens, self.images, self.encoder_inputs = [], [], [], []
        self.image_refs = []
        self.hook = None
        with torch.random.fork_rng(devices=[]):
            torch.manual_seed(317)
            self.embd = _Embedding(self)
            self.decoders = _Decoders([_Layer(self), _Layer(self)]).eval()
            self.features = torch.nn.Sequential(torch.nn.Linear(8, 8), torch.nn.ReLU())
            self.heads = [torch.nn.Linear(8, size) for size in (3, 3, 2, 2)]
        self.proxy = _CpuColorModel(self)

    def stage(self, name):
        assert self.proxy._lock.locked(), name
        assert not torch.is_grad_enabled(), name
        self.stages.append(name)
        if self.hook is not None:
            self.hook(name)

    def backbone(self, image):
        self.stage('backbone')
        self.image_refs.append(image)
        self.images.append(image.clone())
        base = image[:, 0, 0, 0].reshape(-1, 1, 1, 1)
        return base + torch.arange(64, dtype=torch.float32).reshape(1, 8, 1, 8) / 64

    def encoders(self, memory, mask):
        self.stage('encoder')
        self.encoder_inputs.append((memory.clone(), mask.clone()))
        return memory + .25

    def color_pred1(self, features):
        self.stage('color_features')
        return self.features(features)

    def color_pred_fg(self, features):
        self.stage('fg')
        return self.heads[0](features)

    def color_pred_bg(self, features):
        self.stage('bg')
        return self.heads[1](features)

    def color_pred_fg_ind(self, features):
        self.stage('fg_flags')
        return self.heads[2](features)

    def color_pred_bg_ind(self, features):
        self.stage('bg_flags')
        return self.heads[3](features)

    def pred(self, *args, **kwargs):
        pytest.fail('Teacher forcing must not predict characters')

    pred1 = pred

    def infer_beam_batch_tensor(self, *args, **kwargs):
        pytest.fail('Known text must not run beam recognition')


def _image(count=2):
    return torch.arange(1, count + 1, dtype=torch.float32).reshape(-1, 1, 1, 1).expand(-1, 3, 48, 32)


def _incremental_colors(model, image, widths, tokens):
    """Test-only former semantics, independent of the parallel implementation."""
    with torch.no_grad():
        memory = model.backbone(image).squeeze(2).transpose(1, 2)
        mask = torch.zeros(len(tokens), memory.shape[1], dtype=torch.bool, device=image.device)
        for row, width in enumerate(widths):
            mask[row, (width + 3) // 4 + 2:] = True
        memory = model.encoders(memory, mask)
        length = max(map(len, tokens))
        shifted = torch.tensor([[1, *row[:-1], *([0] * (length - len(row)))] for row in tokens],
                               dtype=torch.long, device=image.device)
        prefixes = [None] * len(model.decoders)
        states = []
        for step in range(length):
            decoded = model.embd(shifted[:, step:step + 1])
            for index, layer in enumerate(model.decoders):
                prefix = decoded if prefixes[index] is None else torch.cat((prefixes[index], decoded), dim=1)
                prefixes[index] = prefix
                decoded = decoded + layer.self_attn(layer.norm1(decoded), layer.norm1(prefix),
                    layer.norm1(prefix), q_offset=step)[0]
                decoded = decoded + layer.multihead_attn(layer.norm2(decoded), memory, memory,
                    key_padding_mask=mask, q_offset=step)[0]
                decoded = decoded + layer._ff_block(layer.norm3(decoded))
            states.append(decoded)
        features = model.color_pred1(torch.cat(states, dim=1))
        heads = [head(features) for head in (model.color_pred_fg, model.color_pred_bg,
                                           model.color_pred_fg_ind, model.color_pred_bg_ind)]
        return [(row, None, *(head[i, :len(row)].detach().cpu() for head in heads))
                for i, row in enumerate(tokens)]


def _assert_colors_match(actual, expected):
    for row, baseline in zip(actual, expected, strict=True):
        assert row[:2] == baseline[:2]
        for value, reference in zip(row[2:], baseline[2:], strict=True):
            torch.testing.assert_close(value, reference, rtol=2e-5, atol=2e-6)
        for value, reference in zip(row[4:], baseline[4:], strict=True):
            assert torch.equal(value[:, 1] > value[:, 0], reference[:, 1] > reference[:, 0])


def test_known_text_uses_one_embedding_causal_layers_and_native_color_heads(monkeypatch):
    model = _TinyModel()
    tokens = [[3, 5, 4], [4]]  # The caller has already mapped the space to <SP>.
    image = _image().clone().requires_grad_()
    with model.proxy._lock:
        expected = _incremental_colors(model, image, [5, 20], tokens)
    model.stages.clear()
    model.tokens.clear()
    model.encoder_inputs.clear()
    model.image_refs.clear()
    transfers = []
    detach, cpu = torch.Tensor.detach, torch.Tensor.cpu

    def checked_detach(value, *args, **kwargs):
        assert model.proxy._lock.locked()
        transfers.append('detach')
        return detach(value, *args, **kwargs)

    def checked_cpu(value, *args, **kwargs):
        assert model.proxy._lock.locked()
        assert not value.requires_grad
        transfers.append('cpu')
        return cpu(value, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(torch.Tensor, 'detach', checked_detach)
        patch.setattr(torch.Tensor, 'cpu', checked_cpu)
        with collect() as timings:
            result = model.proxy.infer_with_text(image, [5, 20], text_indices=tokens,
                                                beams_k=5, max_seq_length=255)

    assert torch.is_grad_enabled() and image.requires_grad
    assert model.stages.count('backbone') == model.stages.count('encoder') == 1
    assert model.image_refs[0] is image  # The all-known batch needs no row-selection copy.
    assert len(model.tokens) == 1 and model.tokens[0].tolist() == [[1, 3, 5], [1, 0, 0]]
    memory, mask = model.encoder_inputs[0]
    assert memory.shape == (2, 8, 8)
    assert mask.dtype == torch.bool
    assert mask.tolist() == [[False] * 4 + [True] * 4, [False] * 7 + [True]]
    assert model.stages.count('self_attention') == model.stages.count('cross_attention') == 2
    assert model.stages.count('ff') == 2
    for row, indices in enumerate(tokens):
        assert result[row][0] is indices and result[row][1] is None
        for actual, channels in zip(result[row][2:], (3, 3, 2, 2), strict=True):
            assert actual.device.type == 'cpu' and not actual.requires_grad
            assert actual.shape == (len(indices), channels)
    _assert_colors_match(result, expected)
    assert tokens == [[3, 5, 4], [4]]
    assert transfers.count('cpu') == transfers.count('detach') >= 4
    assert set(timings) == {'ocr_lock_wait'} and timings['ocr_lock_wait'] >= 0
    assert not model.proxy._lock.locked()


@pytest.mark.parametrize('length', [1, 2, 3, 4, 7, 8])
def test_parallel_cross_attention_preserves_each_prefix_xpos_center_and_memory_mask(length):
    model = _TinyModel()
    attention = model.decoders[0].multihead_attn
    original_xpos = attention.xpos
    before = {key: value.clone() for key, value in attention.state_dict().items()}
    query = torch.linspace(-2, 2, 2 * length * 8).reshape(2, length, 8)
    memory = torch.linspace(-1, 3, 2 * 7 * 8).reshape(2, 7, 8)
    mask = torch.tensor([[False] * 3 + [True] * 4, [False] * 6 + [True]])
    with model.proxy._lock, torch.no_grad():
        expected = torch.cat([attention(query[:, step:step + 1], memory, memory,
            key_padding_mask=mask, q_offset=step)[0] for step in range(length)], dim=1)
        view = _ParallelCrossAttention(attention)
        actual = view(query, memory, memory, key_padding_mask=mask)[0]
        naive = attention(query, memory, memory, key_padding_mask=mask)[0]
        padded_memory = memory.masked_fill(mask[..., None], 1000)
        with_padding = view(query, padded_memory, padded_memory, key_padding_mask=mask)[0]
    torch.testing.assert_close(actual, expected, rtol=2e-5, atol=2e-6)
    if length >= 3:
        assert not torch.allclose(naive, expected, rtol=2e-5, atol=2e-6)
    torch.testing.assert_close(with_padding, actual, rtol=0, atol=0)
    assert attention.xpos is original_xpos and 'forward' not in attention.__dict__
    assert all(torch.equal(value, before[key]) for key, value in attention.state_dict().items())


@pytest.mark.parametrize('lengths', [(1,), (2, 1), (3, 1, 2), (8, 3), (1, 2, 3, 5, 8, 17)])
def test_parallel_layers_match_test_only_incremental_four_head_baseline(lengths):
    model = _TinyModel()
    tokens = [[3 + index % 3 for index in range(length)] for length in lengths]
    image, widths = _image(len(tokens)), [5 + 3 * row for row in range(len(tokens))]
    with model.proxy._lock:
        expected = _incremental_colors(model, image, widths, tokens)
    result = model.proxy.infer_with_text(image, widths, text_indices=tokens)
    _assert_colors_match(result, expected)


def test_future_tokens_and_longer_batch_padding_cannot_change_valid_prefix_colors():
    model = _TinyModel()
    tokens = [3, 4, 5]
    short = model.proxy.infer_with_text(_image(1), [5], text_indices=[tokens])
    extended = model.proxy.infer_with_text(_image(1), [5], text_indices=[tokens + [4, 5, 3, 4, 5]])
    batched = model.proxy.infer_with_text(_image(2), [5, 20], text_indices=[tokens, [4] * 8])
    _assert_colors_match(batched[:1], short)
    prefix = [(tokens, None, *(value[:len(tokens)] for value in extended[0][2:]))]
    _assert_colors_match(prefix, short)


def test_six_line_255_character_limit_remains_one_pass_per_layer():
    model = _TinyModel()
    tokens = [[3] * 255, [4], [5], [3], [4], [5]]
    result = model.proxy.infer_with_text(_image(6), [5] * 6, text_indices=tokens)
    assert len(model.tokens) == 1 and model.tokens[0].shape == (6, 255)
    assert model.stages.count('self_attention') == model.stages.count('cross_attention') == 2
    assert [row[2].shape for row in result] == [(255, 3), *([(1, 3)] * 5)]
    assert all(torch.isfinite(value).all() for row in result for value in row[2:])


@pytest.mark.parametrize('failure_stage', ['backbone', 'cross_attention', 'transfer'])
def test_teacher_failure_releases_lock_and_preserves_wait_diagnostic(monkeypatch, failure_stage):
    model = _TinyModel()
    failure = RuntimeError('fixture teacher failure')

    def fail(name):
        if name == failure_stage:
            raise failure

    model.hook = fail
    with monkeypatch.context() as patch:
        if failure_stage == 'transfer':
            def failed_cpu(value, *args, **kwargs):
                assert model.proxy._lock.locked()
                raise failure
            patch.setattr(torch.Tensor, 'cpu', failed_cpu)
        with collect() as timings, pytest.raises(RuntimeError) as caught:
            model.proxy.infer_with_text(_image(1), [5], text_indices=[[3]])
        assert caught.value is failure
    assert set(timings) == {'ocr_lock_wait'} and not model.proxy._lock.locked()
    model.hook = None
    assert model.proxy.infer_with_text(_image(1), [5], text_indices=[[4]])[0][0] == [4]


class _ObservedLock:
    def __init__(self, lock):
        self.lock, self.contended = lock, Event()

    def acquire(self):
        if self.lock.locked():
            self.contended.set()
        return self.lock.acquire()

    def release(self):
        self.lock.release()

    def locked(self):
        return self.lock.locked()


@pytest.mark.parametrize('held_path', ['teacher', 'beam'])
def test_teacher_and_legacy_beam_share_one_instance_lock(held_path):
    model = _TinyModel()
    entered, release, other_entered = Event(), Event(), Event()
    model.proxy._lock = lock = _ObservedLock(model.proxy._lock)

    def observe(path):
        assert lock.locked()
        if path == held_path:
            entered.set()
            assert release.wait(5)
        else:
            other_entered.set()

    model.hook = lambda stage: observe('teacher') if stage == 'backbone' else None

    def beam(*args, **kwargs):
        observe('beam')
        return [([4], .9, torch.zeros(1, 3))]

    model.infer_beam_batch_tensor = beam

    def run(path):
        with collect() as timings:
            if path == 'teacher':
                result = model.proxy.infer_with_text(_image(1), [5], text_indices=[[3]])
            else:
                result = model.proxy.infer_beam_batch_tensor(_image(1), [5])
        return result, timings

    with ThreadPoolExecutor(2) as workers:
        first = workers.submit(run, held_path)
        try:
            assert entered.wait(5)
            second = workers.submit(run, 'beam' if held_path == 'teacher' else 'teacher')
            assert lock.contended.wait(5)
            assert not other_entered.is_set() and not second.done()
        finally:
            release.set()
        for job in (first, second):
            result, timings = job.result(timeout=5)
            assert result and set(timings) == {'ocr_lock_wait'}
    assert other_entered.is_set() and not lock.locked()


@pytest.mark.parametrize(('widths', 'tokens', 'limit'), [
    ([5, 20], [[3]], 255), ([5], [[3], [4]], 255),
    ([5, 20], [[], [4]], 255), ([5, 20], [[3, 4], [4]], 1),
])
def test_invalid_teacher_batch_fails_before_model_execution(widths, tokens, limit):
    model = _TinyModel()
    with pytest.raises(ValueError):
        model.proxy.infer_with_text(_image(), widths, text_indices=tokens, max_seq_length=limit)
    assert not model.stages and not model.proxy._lock.locked()


def test_mixed_unknown_rows_keep_original_canvas_and_restore_result_order():
    model = _TinyModel()
    image, tokens = _image(3), [None, [3, 5], None]
    calls = []
    beam_results = [([4], .8, torch.full((1, 3), 7.)), ([3, 4], .7, torch.full((2, 3), 9.))]

    def beam(pixels, widths, **options):
        assert model.proxy._lock.locked()
        calls.append((pixels.clone(), widths, options))
        return beam_results

    model.infer_beam_batch_tensor = beam
    result = model.proxy.infer_with_text(image, [5, 20, 9], text_indices=tokens)
    assert len(calls) == 1
    pixels, widths, options = calls[0]
    assert torch.equal(pixels, image[[0, 2]]) and pixels.shape[-1] == 32
    assert widths == [5, 9] and options == {'beams_k': 5, 'max_seq_length': 255}
    assert len(model.images) == 1 and torch.equal(model.images[0], image[[1]])
    assert result[1][0] is tokens[1] and result[1][1] is None
    for position, baseline in zip((0, 2), beam_results, strict=True):
        assert result[position][:2] == baseline[:2]
        assert torch.equal(result[position][2], baseline[2])
    assert tokens == [None, [3, 5], None]


def test_unknown_only_batch_keeps_native_model_path_without_row_selection():
    model = _TinyModel()
    image = _image()
    calls = []

    def beam(pixels, widths, **options):
        assert model.proxy._lock.locked()
        calls.append((pixels, widths))
        return [([3], .8), ([4], .9)]

    model.infer_beam_batch_tensor = beam
    result = model.proxy.infer_with_text(image, [5, 20], text_indices=[None, None])
    assert result == [([3], .8), ([4], .9)]
    assert len(calls) == 1 and calls[0][0] is image and calls[0][1] == [5, 20]
    assert not model.stages and not model.proxy._lock.locked()
