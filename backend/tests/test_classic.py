"""Control-plane LLM metering and image checkpoints; no live upstream calls."""
import base64
from datetime import timedelta
from io import BytesIO
import pytest
from PIL import Image
from sqlalchemy import func, select

from app import classic
from app.adapters.llm import TextError, TextResponse
from app.adapters.text import parse_translations
from app.config import settings
from app.db import Base, engine, session_factory
from app.models import Asset, Attempt, ClassicState, Job, TextCall, User, now, uid
from app.queue_models import ComputeNode, ExecutionLease, JobStage, SchedulerMutex
from app import entitlement_models  # noqa: F401
from translation_fixtures import configure_text_provider

SEGMENTS = [{'id': 'b001', 'source': 'Hello!'}]


def encoded(image):
    buffer = BytesIO()
    image.save(buffer, 'PNG')
    return base64.b64encode(buffer.getvalue()).decode()


def analysis(segments=None):
    segments = segments or SEGMENTS
    mask = Image.new('L', (80, 64), 0)
    mask.putpixel((10, 10), 255)
    return {'width': 80, 'height': 64, 'segments': segments,
            'regions': [{'lines': [[[8, 8], [20, 8], [20, 20], [8, 20]]]} for _ in segments], 'mask': encoded(mask)}


@pytest.fixture
def text_database(tmp_path, monkeypatch):
    # This fixture can run without importing the HTTP app or other test modules.
    from app import translation_requests, system_settings  # noqa: F401
    monkeypatch.setenv('DATABASE_URL', 'sqlite:///' + (tmp_path / 'stages.db').as_posix())
    monkeypatch.setenv('DEV_AUTH', 'true')
    monkeypatch.setenv('CLASSIC_ENABLED', 'true')
    monkeypatch.setenv('STORAGE_PATH', str(tmp_path / 'images'))
    settings.cache_clear()
    if engine.cache_info().currsize:
        engine().dispose()
    engine.cache_clear()
    Base.metadata.create_all(engine())
    with session_factory()() as db:
        db.add(SchedulerMutex(id=1, revision=0))
        db.commit()
        configure_text_provider(db)
    yield
    engine().dispose()
    engine.cache_clear()
    settings.cache_clear()


@pytest.fixture
def text_case(text_database, monkeypatch):
    from app.classic_config import snapshot
    job_id, attempt_id, lease_id = uid(), uid(), uid()
    owner_id, asset_id, stage_id = uid(), uid(), uid()
    with session_factory()() as db:
        config = snapshot(db)
        provider_id = config['text']['provider_id']
        db.add(User(id=owner_id, subject='isolated-stage-user', name='reader'))
        db.flush()
        db.add(Asset(id=asset_id, owner_id=owner_id, sha256='a' * 64, storage_key='isolated-original',
                     mime='image/png', width=80, height=64, byte_size=100,
                     expires_at=now() + timedelta(days=1)))
        db.add(ComputeNode(id='text-node', name='text pool', capabilities=['text'], capacity=4,
                           resource_id='isolated:text', engine_version='none', device='http'))
        db.flush()
        db.add(Job(id=job_id, owner_id=owner_id, input_asset_id=asset_id, mode='classic',
                   target_language='zh-Hans', status='running', attempt_id=attempt_id, quota_pages=1,
                   quota_kind='classic', config=config, operation='translate', request_hash='r' * 64,
                   idempotency_key=uid(), cache_key='c' * 64))
        db.flush()
        db.add(Attempt(id=attempt_id, job_id=job_id, provider_id=provider_id, lease_expires_at=now() + timedelta(minutes=5)))
        db.add(JobStage(id=stage_id, job_id=job_id, name='text', status='running', generation=1))
        db.add(ClassicState(job_id=job_id, analysis=analysis()))
        db.flush()
        db.add(ExecutionLease(id=lease_id, job_id=job_id, stage_id=stage_id, node_id='text-node', owner_id=owner_id,
                              generation=1, resource_pool='text:' + provider_id, mode='classic',
                              expires_at=now() + timedelta(minutes=5)))
        db.commit()
    from app.storage import get_store
    get_store().put('isolated-original', b'fixture', 'image/png', kind='original')
    def text(*args):
        return TextResponse('{"translations":{"b001":"你好！"}}',
                            {'input_tokens': 100, 'output_tokens': 20}, 'isolated-request')
    monkeypatch.setattr(classic, 'call_text', text)
    return job_id, lease_id


@pytest.mark.parametrize('content', ['{}', '{"translations":[]}', '{"translations":{"wrong":"好"}}',
    '{"translations":{"b001":2}}',
    '{"translations":{"b001":"好","b001":"好"}}',
    '{"translations":{"b001":"好"},"note":"injected"}', 'not json'])
def test_rejects_incomplete_or_ambiguous_contract(content):
    with pytest.raises(TextError):
        parse_translations(content, SEGMENTS)


def test_text_stage_checkpoint_replay_never_repeats_paid_call(text_case):
    job, lease = text_case
    assert classic.run_text_stage(job, lease) == {'translations': {'b001': '你好！'}}
    assert classic.run_text_stage(job, lease) == {'translations': {'b001': '你好！'}}
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
        call = db.scalar(select(TextCall))
        assert (call.accounted_micros, call.cost_state) == (1100, 'estimated')


@pytest.mark.parametrize('values', [
    {'b001': ''}, {'b001': ' \n\t '}, {'b001': '', 'b002': 'translated'},
])
def test_empty_translation_checkpoint_replay_and_delivery_do_not_repeat_call(text_case, monkeypatch, values):
    import json
    from app.compute_v3 import translations_payload
    job_id, lease_id = text_case
    expected = {key: value.strip() for key, value in values.items()}
    segments = [{'id': key, 'source': 'Source'} for key in values]
    with session_factory()() as db:
        db.get(ClassicState, job_id).analysis = analysis(segments)
        db.commit()
    monkeypatch.setattr(classic, 'call_text', lambda *args: TextResponse(
        json.dumps({'translations': values}), {'input_tokens': 100, 'output_tokens': 5}, 'empty-translation'))
    assert classic.run_text_stage(job_id, lease_id) == {'translations': expected}
    assert classic.run_text_stage(job_id, lease_id) == {'translations': expected}
    with session_factory()() as db:
        calls = db.scalars(select(TextCall).where(TextCall.job_id == job_id)).all()
        assert len(calls) == 1
        assert calls[0].error_code is None and calls[0].accounted_micros == 650
        assert db.get(ClassicState, job_id).translations == expected
        stage = db.scalar(select(JobStage).where(JobStage.job_id == job_id, JobStage.name == 'text'))
        stage.status = 'succeeded'
        db.flush()
        payload = translations_payload(db, job_id)
        assert payload['translations'] == expected and payload['revision']


def test_larger_output_reserves_schema_cost_then_accounts_actual_usage(text_case):
    import json
    from app.adapters.text import messages, response_schema
    from app.classic_config import snapshot
    job_id, lease_id = text_case
    with session_factory()() as db:
        job = db.get(Job, job_id)
        provider = configure_text_provider(db, job.config['text']['provider_id'], max_output_tokens=32768)
        job.config = {**job.config, 'text': snapshot(db, provider.id)['text']}
        db.commit()
    call_id, _, _ = classic.reserve_call(job_id, lease_id, 0, SEGMENTS, 'zh-Hans')
    with session_factory()() as db:
        call = db.get(TextCall, call_id)
        sent_bytes = len(json.dumps({'messages': messages(SEGMENTS, 'zh-Hans'), 'response_format': {
            'type': 'json_schema', 'json_schema': response_schema(SEGMENTS)}}, ensure_ascii=False).encode())
        assert call.reserved_micros >= sent_bytes * 5 + 32768 * 30
        assert call.accounted_micros == call.reserved_micros and call.cost_state == 'unknown'
    classic.complete_call(call_id, lease_id, response=TextResponse(
        '{}', {'input_tokens': 100, 'output_tokens': 20}, 'actual-usage'))
    with session_factory()() as db:
        call = db.get(TextCall, call_id)
        assert call.accounted_micros == 1100 and call.cost_state == 'estimated'


def test_refusal_stops_after_one_call_and_preserves_metering(text_case, monkeypatch):
    def refuse(*args):
        raise TextError('TEXT_REFUSED', '文本服务拒绝生成内容',
                        usage={'input_tokens': 100, 'output_tokens': 5}, request_id='refused')
    monkeypatch.setattr(classic, 'call_text', refuse)
    with pytest.raises(TextError, match='TEXT_REFUSED'):
        classic.run_text_stage(*text_case)
    with session_factory()() as db:
        calls = db.scalars(select(TextCall)).all()
        assert len(calls) == 1
        assert calls[0].accounted_micros == 650 and calls[0].request_id == 'refused'
        assert db.get(ClassicState, text_case[0]).translations == {}


def test_format_repair_records_cost_for_every_subcall(text_case, monkeypatch):
    original = classic.call_text
    replies = iter([TextResponse('invalid', {'input_tokens': 100, 'output_tokens': 5}, 'invalid'), original()])
    monkeypatch.setattr(classic, 'call_text', lambda *args: next(replies))
    monkeypatch.setattr(classic, 'wait_for_retry', lambda *args: None)
    classic.run_text_stage(*text_case)
    with session_factory()() as db:
        calls = db.scalars(select(TextCall).order_by(TextCall.sequence)).all()
        assert len(calls) == 2
        assert calls[0].error_code == 'TEXT_INVALID_RESPONSE'
        assert calls[0].accounted_micros == 650
        assert all(call.usage for call in calls)


def test_invalid_json_never_saves_partial_translations_and_stops_at_attempt_limit(text_case, monkeypatch):
    monkeypatch.setattr(classic, 'call_text', lambda *args: TextResponse(
        '{"translations":{"b001":"first","b001":"second"}}',
        {'input_tokens': 100, 'output_tokens': 5}, 'duplicate-json-id'))
    monkeypatch.setattr(classic, 'wait_for_retry', lambda *args: None)
    with pytest.raises(TextError, match='TEXT_INVALID_RESPONSE'):
        classic.run_text_stage(*text_case)
    with session_factory()() as db:
        calls = db.scalars(select(TextCall)).all()
        assert len(calls) == 3
        assert all(call.error_code == 'TEXT_INVALID_RESPONSE' and call.accounted_micros == 650 for call in calls)
        assert db.get(ClassicState, text_case[0]).translations == {}
    with pytest.raises(TextError, match='TEXT_RETRY_EXHAUSTED'):
        classic.run_text_stage(*text_case)


def test_unknown_call_keeps_metering_without_cost_cap_and_stops_at_attempt_limit(text_case, monkeypatch):
    calls = []
    def timeout(*args):
        calls.append(1)
        raise TextError('TEXT_TRANSPORT_FAILED', 'isolated timeout', retryable=True)
    monkeypatch.setattr(classic, 'call_text', timeout)
    monkeypatch.setattr(classic, 'wait_for_retry', lambda *args: None)
    with pytest.raises(TextError, match='TEXT_TRANSPORT_FAILED'):
        classic.run_text_stage(*text_case)
    assert len(calls) == 3
    with session_factory()() as db:
        records = db.scalars(select(TextCall)).all()
        assert len(records) == 3
        assert sum(call.accounted_micros for call in records) > 50_000
        assert all(call.accounted_micros == call.reserved_micros > 0 and call.cost_state == 'unknown' for call in records)
    with pytest.raises(TextError, match='TEXT_RETRY_EXHAUSTED'):
        classic.reserve_call(*text_case, 0, SEGMENTS, 'zh-Hans')


def test_late_translation_accounts_usage_without_overwriting_new_generation(text_case):
    job, lease = text_case
    call, _, _ = classic.reserve_call(job, lease, 0, SEGMENTS, 'zh-Hans')
    with session_factory()() as db:
        db.get(JobStage, db.get(ExecutionLease, lease).stage_id).generation += 1
        db.commit()
    classic.complete_call(call, lease, response=TextResponse('unused', {'input_tokens': 10, 'output_tokens': 10}, 'late'),
                          translations={'b001': 'late'})
    with session_factory()() as db:
        assert db.get(ClassicState, job).translations == {}
        assert db.get(TextCall, call).accounted_micros == 350


def test_cancel_during_text_keeps_cost_and_discards_translation(text_case, monkeypatch):
    original = classic.call_text
    def cancel(*args):
        with session_factory()() as db:
            db.get(Job, text_case[0]).cancel_requested = True
            db.commit()
        return original(*args)
    monkeypatch.setattr(classic, 'call_text', cancel)
    with pytest.raises(classic.ProcessingError, match='LEASE_EXPIRED'):
        classic.run_text_stage(*text_case)
    with session_factory()() as db:
        assert db.get(ClassicState, text_case[0]).translations == {}
        assert db.scalar(select(TextCall)).usage


def test_ocr_wait_time_does_not_spend_text_deadline(text_case):
    with session_factory()() as db:
        db.get(ClassicState, text_case[0]).started_at = now() - timedelta(days=1)
        db.commit()
    classic.run_text_stage(*text_case)


def test_every_call_checks_shared_provider_rate_limit(text_case):
    with session_factory()() as db:
        provider_id = db.get(Job, text_case[0]).config['text']['provider_id']
        configure_text_provider(db, provider_id, requests_per_minute=1)
    classic.reserve_call(*text_case, 0, SEGMENTS, 'zh-Hans')
    with pytest.raises(TextError, match='TEXT_RATE_LIMITED'):
        classic.reserve_call(*text_case, 1, SEGMENTS, 'zh-Hans')
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1


def test_duplicate_execution_cannot_call_same_group_twice_on_one_lease(text_case):
    classic.reserve_call(*text_case, 0, SEGMENTS, 'zh-Hans')
    with pytest.raises(TextError, match='TEXT_CALL_IN_FLIGHT'):
        classic.reserve_call(*text_case, 0, SEGMENTS, 'zh-Hans')
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1


def test_strict_ocr_checkpoint_validation():
    classic.validate_analysis(analysis(), 80, 64)
    bad = analysis()
    bad['mask'] = encoded(Image.new('L', (81, 64), 255))
    with pytest.raises(classic.ProcessingError, match='CLASSIC_OCR_INVALID'):
        classic.validate_analysis(bad, 80, 64)
    bad = analysis()
    bad['regions'][0]['lines'][0][0][0] = float('nan')
    with pytest.raises(classic.ProcessingError, match='CLASSIC_OCR_INVALID'):
        classic.validate_analysis(bad, 80, 64)
