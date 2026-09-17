"""Control-plane LLM metering and image checkpoints; no live upstream calls."""
import base64
from datetime import timedelta
from io import BytesIO
import json
import pytest
from PIL import Image
from sqlalchemy import func, select

from app import classic
from app.adapters.text import TextError, TextResponse, parse_translations
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
                     storage_backend='r2', mime='image/png', width=80, height=64, byte_size=100,
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
                              generation=1, resource_pool='text:' + provider_id, mode='classic', priority_class='preload',
                              weight=1, estimated_seconds=10, expires_at=now() + timedelta(minutes=5)))
        db.commit()
    def text(*args):
        return TextResponse('{"translations":[{"id":"b001","text":"你好！"}]}',
                            {'input_tokens': 100, 'output_tokens': 20}, 'isolated-request')
    monkeypatch.setattr(classic, 'call_text', text)
    return job_id, lease_id


@pytest.mark.parametrize('content', ['{}', '{"translations":[]}', '{"translations":[{"id":"wrong","text":"好"}]}',
    '{"translations":[{"id":"b001","text":""}]}', '{"translations":[{"id":"b001","text":2}]}',
    '{"translations":[{"id":"b001","text":"好"},{"id":"b001","text":"好"}]}',
    '{"translations":[{"id":"b001","text":"好"}],"note":"injected"}', 'not json'])
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


def test_json_repair_records_cost_for_every_subcall(text_case, monkeypatch):
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


def test_render_rejects_changes_outside_both_masks():
    original = Image.new('RGB', (80, 64), (255, 255, 255))
    final = original.copy()
    final.putpixel((0, 0), (0, 0, 0))
    mask = analysis()['mask']
    with pytest.raises(classic.ProcessingError, match='CLASSIC_RENDER_INVALID'):
        classic.validate_render(base64.b64decode(encoded(original)), {'image': encoded(final), 'mask': mask, 'glyph_mask': mask})


@pytest.mark.parametrize('alpha', [False, True])
def test_render_returns_metadata_for_final_bytes_and_preserves_alpha(alpha):
    from app.assets import inspect_image
    original = Image.new('RGBA' if alpha else 'RGB', (80, 64), (255, 255, 255, 90) if alpha else 'white')
    final = original.convert('RGB')
    final.putpixel((10, 10), (0, 0, 0))
    output, info = classic.validate_render(base64.b64decode(encoded(original)),
        {'image': encoded(final), 'mask': analysis()['mask'], 'glyph_mask': analysis()['mask']})
    assert info == inspect_image(output, output=True)
    with Image.open(BytesIO(output)) as result:
        assert result.getpixel((10, 10))[:3] == (0, 0, 0)
        if alpha:
            assert result.getchannel('A').getextrema() == (90, 90)
