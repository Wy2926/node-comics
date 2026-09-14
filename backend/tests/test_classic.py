from conftest import run_job, claim_job
from datetime import timedelta
from io import BytesIO
import base64
import json
import pytest
from PIL import Image
from sqlalchemy import func, select
from conftest import login, upload, create
from app import classic
from app.adapters.text import TextError, TextResponse, parse_translations
from app.config import settings
from app.db import session_factory
from app.models import Asset, Attempt, ClassicState, Job, Ledger, TextCall, now, uid
from conftest import run_job as process_job, claim_job as claim


SEGMENTS = [{'id': 'b001', 'source': 'Hello!'}]


def encoded(image):
    buffer = BytesIO()
    image.save(buffer, 'PNG')
    return base64.b64encode(buffer.getvalue()).decode()


@pytest.fixture
def configured(client, monkeypatch, png):
    monkeypatch.setenv('CLASSIC_ENABLED', 'true')
    settings.cache_clear()
    calls = {'text': 0, 'analyze': 0, 'render': 0}

    def engine(stage, data, config, **kwargs):
        calls[stage] += 1
        image = Image.open(BytesIO(data)).convert('RGB')
        mask = Image.new('L', image.size, 0)
        mask.putpixel((10, 10), 255)
        common = {'width': image.width, 'height': image.height, 'version': config['engine']['version']}
        if stage == 'analyze':
            return {**common, 'segments': SEGMENTS, 'regions': [{}], 'mask': encoded(mask)}
        result = image.copy()
        result.putpixel((10, 10), (0, 0, 0))
        return {**common, 'image': encoded(result), 'cleaned': encoded(image), 'mask': encoded(mask), 'glyph_mask': encoded(mask), 'timings': {'render': 0.1}}

    def text(*args):
        calls['text'] += 1
        return TextResponse('{"translations":[{"id":"b001","text":"你好！"}]}', {'input_tokens': 100, 'output_tokens': 20}, 'request-test')

    monkeypatch.setattr(classic, 'engine_request', engine)
    monkeypatch.setattr(classic, 'call_text', text)
    auth = login(client)
    asset = upload(client, auth, png)
    return client, auth, asset, calls


def submit(configured, key='classic-1', language='zh-Hans'):
    client, auth, asset, _ = configured
    response = client.post('/v1/translations/classic', headers={**auth, 'Idempotency-Key': key}, data={'asset_id': asset, 'target_language': language})
    assert response.status_code == 202, response.text
    return response.json()['id']


def status(configured, job_id):
    return configured[0].post('/v1/jobs/status', headers=configured[1], json={'ids': [job_id]}).json()['items'][0]


@pytest.mark.parametrize('content', [
    '{}', '{"translations":[]}', '{"translations":[{"id":"wrong","text":"好"}]}',
    '{"translations":[{"id":"b001","text":""}]}', '{"translations":[{"id":"b001","text":2}]}',
    '{"translations":[{"id":"b001","text":"好"},{"id":"b001","text":"好"}]}',
    '{"translations":[{"id":"b001","text":"好"}],"note":"injected"}', 'not json',
])
def test_rejects_incomplete_or_ambiguous_contract(content):
    with pytest.raises(TextError):
        parse_translations(content, SEGMENTS)


def test_parses_fenced_json_locally():
    assert parse_translations('```json\n{"translations":[{"id":"b001","text":"你好"}]}\n```', SEGMENTS) == {'b001': '你好'}


def test_idempotency_cache_mode_language_and_settlement(configured):
    client, auth, asset, calls = configured
    job_id = submit(configured)
    assert submit(configured) == job_id
    process_job(job_id)
    process_job(job_id)
    assert status(configured, job_id)['status'] == 'succeeded'
    assert calls == {'text': 1, 'analyze': 1, 'render': 1}
    cached_id = submit(configured, 'classic-cache')
    assert status(configured, cached_id)['cache_hit']
    assert not status(configured, submit(configured, 'english', 'en'))['cache_hit']
    assert not create(client, auth, asset).json()['cache_hit']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.job_id == job_id, Ledger.kind == 'settle')) == 1
        call = db.scalar(select(TextCall).where(TextCall.job_id == job_id))
        assert (call.accounted_micros, call.cost_state) == (1100, 'estimated')


def test_no_text_never_calls_llm_or_charges(configured, monkeypatch):
    def empty(stage, data, config, **kwargs):
        return {'width': 320, 'height': 480, 'segments': [], 'regions': [], 'mask': None}
    monkeypatch.setattr(classic, 'engine_request', empty)
    job = submit(configured)
    process_job(job)
    result = status(configured, job)
    assert (result['status'], result['settlement']) == ('no_text', 'released')
    assert configured[3]['text'] == 0


def test_detected_but_invalid_ocr_does_not_become_no_text(configured, monkeypatch):
    monkeypatch.setattr(classic, 'engine_request', lambda *a, **k: {'width': 320, 'height': 480, 'segments': SEGMENTS, 'regions': []})
    job = submit(configured)
    process_job(job)
    assert status(configured, job)['error']['code'] == 'CLASSIC_OCR_INVALID'
    assert configured[3]['text'] == 0


def test_json_repair_usage_is_recorded_for_each_call(configured, monkeypatch):
    original = classic.call_text
    n = 0
    def broken_once(*args):
        nonlocal n
        n += 1
        if n == 1:
            return TextResponse('invalid', {'input_tokens': 100, 'output_tokens': 5}, 'invalid-json-call')
        return original(*args)
    monkeypatch.setattr(classic, 'call_text', broken_once)
    job = submit(configured)
    process_job(job)
    assert status(configured, job)['status'] == 'succeeded'
    with session_factory()() as db:
        calls = db.scalars(select(TextCall).where(TextCall.job_id == job).order_by(TextCall.sequence)).all()
        assert len(calls) == 2
        assert calls[0].error_code == 'TEXT_INVALID_RESPONSE'
        assert calls[0].accounted_micros == 650
        assert all(call.usage for call in calls)


def test_unknown_timeout_retains_reservation_and_blocks_budget_overrun(configured, monkeypatch):
    n = 0
    def timeout(*args):
        nonlocal n
        n += 1
        raise TextError('TEXT_TRANSPORT_FAILED', 'timeout', retryable=True)
    monkeypatch.setattr(classic, 'call_text', timeout)
    job = submit(configured)
    process_job(job)
    assert status(configured, job)['error']['code'] == 'TEXT_BUDGET_EXCEEDED'
    assert n == 1
    with session_factory()() as db:
        call = db.scalar(select(TextCall).where(TextCall.job_id == job))
        assert call.accounted_micros == call.reserved_micros > 0
        assert call.cost_state == 'unknown'


def test_auth_error_not_retried(configured, monkeypatch):
    def rejected(*args):
        raise TextError('TEXT_AUTH_FAILED', 'invalid credentials')
    monkeypatch.setattr(classic, 'call_text', rejected)
    job = submit(configured)
    process_job(job)
    assert status(configured, job)['error']['code'] == 'TEXT_AUTH_FAILED'
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall).where(TextCall.job_id == job)) == 1


def test_render_failure_recovers_without_repeating_successful_text(configured, monkeypatch):
    original = classic.engine_request
    n = 0
    def flaky(stage, *args, **kwargs):
        nonlocal n
        if stage == 'render':
            n += 1
            if n == 1:
                raise classic.ProcessingError('CLASSIC_RENDER_FAILED', 'render failed')
        return original(stage, *args, **kwargs)
    monkeypatch.setattr(classic, 'engine_request', flaky)
    job = submit(configured)
    process_job(job)
    assert status(configured, job)['status'] == 'queued'
    process_job(job)
    assert status(configured, job)['status'] == 'succeeded'
    assert configured[3]['text'] == 1 and configured[3]['analyze'] == 1


def test_lease_recovery_preserves_text_checkpoint(configured):
    from app.dispatcher import recover
    job = submit(configured)
    attempt_id = claim(job)
    with session_factory()() as db:
        db.add(ClassicState(job_id=job, analysis={'width': 320, 'height': 480, 'segments': SEGMENTS, 'regions': [{}], 'mask': 'unused'}, translations={'b001': '你好'}))
        db.get(Attempt, attempt_id).lease_expires_at = now() - timedelta(seconds=1)
        db.commit()
        recover(db)
        db.commit()
    process_job(job)
    assert status(configured, job)['status'] == 'succeeded'
    assert configured[3]['text'] == 0 and configured[3]['analyze'] == 0


def test_cancel_during_text_records_usage_but_does_not_render(configured, monkeypatch):
    original = classic.call_text
    job = submit(configured)
    def cancel(*args):
        configured[0].post(f'/v1/jobs/{job}/cancel', headers=configured[1])
        return original(*args)
    monkeypatch.setattr(classic, 'call_text', cancel)
    process_job(job)
    assert status(configured, job)['status'] == 'cancelled'
    assert configured[3]['render'] == 0
    with session_factory()() as db:
        assert db.scalar(select(TextCall).where(TextCall.job_id == job)).usage


def test_private_stage_access_and_parent_deletion(configured):
    client, auth, asset, calls = configured
    job = submit(configured)
    process_job(job)
    detail = client.get(f'/v1/jobs/{job}/classic', headers=auth)
    assert detail.json()['translations'] == {'b001': '你好！'}
    artifact = detail.json()['artifacts']['mask']
    other = login(client, 'bob')
    assert client.get(f'/v1/jobs/{job}/classic', headers=other).status_code == 404
    assert client.get(f'/v1/images/{artifact}/content', headers=other).status_code == 404
    client.delete(f'/v1/images/{asset}', headers=auth)
    assert client.get(f'/v1/jobs/{job}/classic', headers=auth).status_code == 410
    assert client.get(f'/v1/images/{artifact}/content', headers=auth).status_code == 410
    with session_factory()() as db:
        assert db.get(ClassicState, job) is None
        assert db.scalar(select(TextCall).where(TextCall.job_id == job)) is not None


def test_late_result_accounts_cost_without_overwriting_new_attempt(configured):
    job = submit(configured)
    attempt_id = claim(job)
    with session_factory()() as db:
        db.add(ClassicState(job_id=job))
        db.commit()
    call_id, _, _ = classic.reserve_call(job, attempt_id, 0, SEGMENTS, 'zh-Hans')
    with session_factory()() as db:
        db.get(Job, job).attempt_id = uid()
        db.commit()
    classic.complete_call(call_id, response=TextResponse('unused', {'input_tokens': 10, 'output_tokens': 10}, 'late'), translations={'b001': 'late'})
    with session_factory()() as db:
        assert db.get(ClassicState, job).translations == {}
        assert db.get(TextCall, call_id).accounted_micros == 350


def test_outside_mask_changes_rejected(configured, monkeypatch):
    original = classic.engine_request
    def corrupt(stage, *args, **kwargs):
        result = original(stage, *args, **kwargs)
        if stage == 'render':
            image = Image.open(BytesIO(base64.b64decode(result['image'])))
            image.putpixel((0, 0), (255, 0, 0))
            result['image'] = encoded(image)
        return result
    monkeypatch.setattr(classic, 'engine_request', corrupt)
    job = submit(configured)
    process_job(job)
    assert status(configured, job)['error']['code'] == 'CLASSIC_RENDER_INVALID'


def test_partial_ocr_output_is_labeled_free_and_cached_without_losing_warning(configured, monkeypatch):
    original = classic.engine_request
    def partial(stage, *args, **kwargs):
        result = original(stage, *args, **kwargs)
        if stage == 'analyze':
            result['quality_flags'] = ['unrecognized_regions']
            result['unrecognized_regions'] = [[[0, 0], [2, 0], [2, 2], [0, 2]]]
        return result
    monkeypatch.setattr(classic, 'engine_request', partial)
    job = submit(configured)
    process_job(job)
    result = status(configured, job)
    assert result['status'] == 'succeeded' and result['result_available']
    assert result['settlement'] == 'released'
    assert result['quality_flags'] == ['unrecognized_regions']
    cached = status(configured, submit(configured, 'partial-cache'))
    assert cached['cache_hit'] and cached['quality_flags'] == ['unrecognized_regions']


def test_source_expiry_erases_checkpoint_and_revokes_stage_access(configured):
    from app.dispatcher import cleanup
    job = submit(configured)
    process_job(job)
    with session_factory()() as db:
        db.get(Asset, configured[2]).expires_at = now() - timedelta(seconds=1)
        db.commit()
        cleanup(db)
        db.commit()
        assert db.get(ClassicState, job) is None
    assert configured[0].get(f'/v1/jobs/{job}/classic', headers=configured[1]).status_code == 410


def test_each_group_keeps_its_own_usage_and_translation(configured, monkeypatch):
    monkeypatch.setenv('TEXT_GROUP_BYTES', '128')
    settings.cache_clear()
    segments = [{'id': f'b{n:03}', 'source': 'a' * 70} for n in range(1, 4)]
    original = classic.engine_request
    def engine(stage, *args, **kwargs):
        result = original(stage, *args, **kwargs)
        if stage == 'analyze':
            result['segments'], result['regions'] = segments, [{}, {}, {}]
        return result
    def text(group, language, profile):
        assert len(group) == 1
        return TextResponse(json.dumps({'translations': [{'id': group[0]['id'], 'text': '你好'}]}), {'input_tokens': 80, 'output_tokens': 20}, 'group-' + group[0]['id'])
    monkeypatch.setattr(classic, 'engine_request', engine)
    monkeypatch.setattr(classic, 'call_text', text)
    job = submit(configured)
    process_job(job)
    assert status(configured, job)['status'] == 'succeeded'
    with session_factory()() as db:
        calls = db.scalars(select(TextCall).where(TextCall.job_id == job)).all()
        assert len(calls) == 3 and {call.group_index for call in calls} == {0, 1, 2}
        assert sum(call.accounted_micros for call in calls) == 3000
        assert len(db.get(ClassicState, job).translations) == 3


def test_format_errors_stop_at_shared_attempt_limit(configured, monkeypatch):
    monkeypatch.setattr(classic, 'call_text', lambda *a: TextResponse('bad json', {'input_tokens': 1, 'output_tokens': 1}, None))
    job = submit(configured)
    process_job(job)
    assert status(configured, job)['status'] == 'failed'
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall).where(TextCall.job_id == job)) == 3
