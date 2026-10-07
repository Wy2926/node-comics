"""Teacher-forced color inference contracts; tiny CPU tensors, no model assets."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from classic_node.timing import collect
from mtu_engine.colors import _CpuColorModel

torch = pytest.importorskip('torch')


class _Embedding(torch.nn.Embedding):
    def __init__(self, owner):
        super().__init__(6, 4)
        self.owner = owner
        with torch.no_grad():
            self.weight.copy_(torch.arange(24).reshape(6, 4))

    def forward(self, indices):
        self.owner.stage('embedding')
        self.owner.tokens.append(indices.clone())
        return super().forward(indices)


class _Decoders:
    def __init__(self, owner):
        self.owner = owner
        self.calls = []

    def __len__(self):
        return 2

    def __call__(self, embedding, cache, memory, mask, step):
        self.owner.stage('decoder')
        self.calls.append((cache.clone(), memory.clone(), mask.clone(), step))
        # Return a new cache to verify that the next step retains the decoder's
        # returned state, not merely the original allocation.
        updated = cache.clone()
        state = embedding[:, 0] + memory[:, 0] + 100 * step
        updated[:, 0, step] = embedding[:, 0]
        updated[:, -1, step] = state
        return state, updated


class _TinyModel:
    dictionary = ['<PAD>', '<S>', '</S>', 'A', 'B', '<SP>']

    def __init__(self):
        self.stages, self.tokens, self.images, self.encoder_inputs = [], [], [], []
        self.image_refs = []
        self.hook = None
        self.embd = _Embedding(self)
        self.decoders = _Decoders(self)
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
        return (base + torch.arange(4).reshape(1, 4, 1, 1)).expand(-1, -1, 1, 8)

    def encoders(self, memory, mask):
        self.stage('encoder')
        self.encoder_inputs.append((memory.clone(), mask.clone()))
        return memory + .25

    def color_pred1(self, features):
        self.stage('color_features')
        return features + 10

    def color_pred_fg(self, features):
        self.stage('fg')
        return features[..., :3]

    def color_pred_bg(self, features):
        self.stage('bg')
        return features[..., :3] + 1000

    def color_pred_fg_ind(self, features):
        self.stage('fg_flags')
        return features[..., :2] + 2000

    def color_pred_bg_ind(self, features):
        self.stage('bg_flags')
        return features[..., :2] + 3000

    def pred(self, *args, **kwargs):
        pytest.fail('Teacher forcing must not predict characters')

    pred1 = pred

    def infer_beam_batch_tensor(self, *args, **kwargs):
        pytest.fail('Known text must not run beam recognition')


def _image(count=2):
    return torch.arange(1, count + 1, dtype=torch.float32).reshape(-1, 1, 1, 1).expand(-1, 3, 48, 32)


def test_known_text_uses_shifted_tokens_masks_bounded_cache_and_native_color_heads(monkeypatch):
    model = _TinyModel()
    tokens = [[3, 5, 4], [4]]  # The caller has already mapped the space to <SP>.
    image = _image().clone().requires_grad_()
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
    assert [value[:, 0].tolist() for value in model.tokens] == [[1, 1], [3, 0], [5, 0]]
    memory, mask = model.encoder_inputs[0]
    assert memory.shape == (2, 8, 4)
    assert mask.dtype == torch.bool
    assert mask.tolist() == [[False] * 4 + [True] * 4, [False] * 7 + [True]]
    assert [step for _, _, _, step in model.decoders.calls] == [0, 1, 2]
    for cache, encoded, decoder_mask, step in model.decoders.calls:
        assert cache.shape == (2, 3, 3, 4)
        torch.testing.assert_close(encoded, memory + .25)
        assert torch.equal(decoder_mask, mask)
        if step == 0:
            assert not torch.count_nonzero(cache)
        else:
            assert torch.count_nonzero(cache[:, -1, :step]) > 0
        assert not torch.count_nonzero(cache[:, :, step:])
    for row, indices in enumerate(tokens):
        assert result[row][0] is indices and result[row][1] is None
        shifted = [1] + indices[:-1]
        expected = torch.stack([torch.arange(4) + 4 * token + memory[row, 0] + .25 + 100 * step + 10
                                for step, token in enumerate(shifted)])
        for actual, target in zip(result[row][2:],
                (expected[:, :3], expected[:, :3] + 1000, expected[:, :2] + 2000, expected[:, :2] + 3000),
                strict=True):
            assert actual.device.type == 'cpu' and not actual.requires_grad
            torch.testing.assert_close(actual, target)
    assert tokens == [[3, 5, 4], [4]]
    assert transfers.count('cpu') == transfers.count('detach') >= 4
    assert set(timings) == {'ocr_lock_wait'} and timings['ocr_lock_wait'] >= 0
    assert not model.proxy._lock.locked()


@pytest.mark.parametrize('failure_stage', ['backbone', 'decoder', 'transfer'])
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
