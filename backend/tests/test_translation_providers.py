"""DB-only routing, credentials, snapshots and supplier scheduling; no paid calls."""
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
import httpx
import pytest
from sqlalchemy import delete, event, select
from sqlalchemy.exc import IntegrityError
from app import classic, workers
from app.adapters import openai_text
from app.adapters.text import TextError, TextResponse, TranslationConfig, call_text
from app.classic_config import snapshot
from app.config import Settings, settings
from app.db import engine, session_factory
from app.models import ClassicState, Job, TextCall, now
from app.providers import configuration, digest
from app.queue_models import ComputeNode, ExecutionLease, JobStage
from app.scheduler import claim_stage, lock_scheduler
from app.translation_models import TranslationProvider, TranslationProviderRevision
from app.translation_providers import ProviderWrite, write_provider
from conftest import control_node, login
from test_classic import SEGMENTS, text_database, text_case
from test_cluster_scheduler import add_job, scheduler_case

PATH = '/v1/admin/translation-providers'


def body(name='OpenAI A', **config):
    return {'name': name, 'channel': 'openai', 'enabled': True,
            'config': {'base_url': 'https://text.example/v1', 'model': 'contract-text-model', **config},
            'api_key': 'isolated-new-key'}


@pytest.fixture
def admin_case(client):
    settings().classic_enabled = True
    with session_factory()() as db:
        db.execute(delete(TranslationProviderRevision))
        db.execute(delete(TranslationProvider))
        db.commit()
    return client, login(client, 'admin')


def create(case, payload=None):
    client, auth = case
    response = client.post(PATH, headers=auth, json=payload or body())
    assert response.status_code == 201, response.text
    assert 'isolated-new-key' not in response.text and 'api_key' not in response.json()
    return response.json()


def test_old_environment_cannot_enable_or_seed_translation(admin_case, monkeypatch):
    client, auth = admin_case
    for key, value in {'TEXT_API_KEY': 'ignored-key', 'TEXT_BASE_URL': 'https://ignored.example/v1',
                       'TEXT_MODEL': 'ignored', 'TEXT_PROTOCOL': 'openai_chat',
                       'CLUSTER_TEXT_REQUESTS_PER_MINUTE': '1'}.items():
        monkeypatch.setenv(key, value)
    settings.cache_clear()
    settings().classic_enabled = True
    assert not any(name.startswith('text_') for name in Settings.model_fields)
    assert 'cluster_text_requests_per_minute' not in Settings.model_fields
    assert client.get(PATH, headers=auth).json()['items'] == []
    assert not next(x for x in client.get('/v1/capabilities').json()['modes'] if x['id'] == 'classic')['enabled']
    with session_factory()() as db, pytest.raises(Exception) as error:
        configuration(db, 'classic', 'en')
    assert error.value.status_code == 503


def test_admin_only_and_secret_validation(admin_case):
    client, auth = admin_case
    assert client.get(PATH).status_code == 401
    reader = login(client)
    assert client.post(PATH, headers=reader, json=body()).status_code == 403
    for payload in [body(channel='unknown'), {**body(), 'channel': 'unknown'},
                    {**body(), 'api_key': ''}, {**body(), 'api_key': 'private\nsecret'},
                    body(protocol='openai_chat'), body(timeout_seconds=0), body(max_attempts=4),
                    body(base_url='https://user:private@text.example/v1'), body(user_agent='bad\r\nheader'),
                    body(requests_per_minute=True), {k: v for k, v in body().items() if k != 'api_key'}]:
        response = client.post(PATH, headers=auth, json=payload)
        assert response.status_code == 422, response.text
        assert 'private' not in response.text and 'isolated-new-key' not in response.text
    assert client.get(PATH, headers=auth).json()['items'] == []


def test_multiple_suppliers_default_routing_and_secret_free_snapshots(admin_case):
    client, auth = admin_case
    first, second = create(admin_case), create(admin_case, body('OpenAI B', protocol='responses'))
    assert first['is_default'] and not second['is_default']
    with session_factory()() as db:
        before = configuration(db, 'classic', 'en')
    assert before['text']['provider_id'] == first['id']
    response = client.post(PATH + '/' + second['id'] + '/default', headers=auth)
    assert response.status_code == 200 and response.json()['is_default']
    with session_factory()() as db:
        after = configuration(db, 'classic', 'en')
        explicit = configuration(db, 'classic', 'en', first['id'])
    assert after['text']['provider_id'] == second['id']
    assert after['version'] != before['version'] and explicit == before
    assert 'isolated-new-key' not in json.dumps(after) and 'api_key' not in after['text']
    assert client.get(PATH, headers=auth).json()['channels'][0]['id'] == 'openai'
    assert sum(p['is_default'] for p in client.get(PATH, headers=auth).json()['items']) == 1
    assert client.patch(PATH + '/' + second['id'], headers=auth, json={'enabled': False}).status_code == 200
    assert client.post(PATH + '/' + second['id'] + '/default', headers=auth).status_code == 409
    with session_factory()() as db:
        from app.classic_config import enabled
        assert not enabled(db)  # No silent fallback to a different supplier.


def test_revision_changes_pin_old_endpoint_key_and_cache_identity(admin_case, monkeypatch):
    client, auth = admin_case
    first = create(admin_case)
    with session_factory()() as db:
        before = snapshot(db)
    updated = body('OpenAI renamed', base_url='https://other.example/v1', model='new-contract-model')
    updated['api_key'] = 'isolated-rotated-key'
    response = client.put(PATH + '/' + first['id'], headers=auth, json=updated)
    assert response.status_code == 200, response.text
    with session_factory()() as db:
        after = snapshot(db)
    assert digest(before) != digest(after)
    assert before['text']['revision_id'] != after['text']['revision_id']
    seen = []
    def handler(request):
        seen.append((str(request.url), request.headers['authorization'], json.loads(request.content)['model']))
        return httpx.Response(200, json={'choices': [{'message': {'content': '{}'}, 'finish_reason': 'stop'}]})
    monkeypatch.setattr(openai_text, 'CheckedTransport', lambda: httpx.MockTransport(handler))
    call_text([], 'en', before['text'])
    call_text([], 'en', after['text'])
    assert seen == [('https://text.example/v1/chat/completions', 'Bearer isolated-new-key', 'contract-text-model'),
                    ('https://other.example/v1/chat/completions', 'Bearer isolated-rotated-key', 'new-contract-model')]
    no_key = {k: v for k, v in updated.items() if k != 'api_key'}
    no_key['name'] = 'Metadata only'
    assert client.put(PATH + '/' + first['id'], headers=auth, json=no_key).json()['revision_id'] == after['text']['revision_id']
    with pytest.raises(TextError, match='TEXT_PROVIDER_REVISION_INVALID'):
        call_text([], 'en', {**before['text'], 'base_url': 'https://attacker.example/v1'})
    assert len(seen) == 2


def test_channel_registry_accepts_a_new_source_without_changing_worker(admin_case, monkeypatch):
    from app.translation_channels import CHANNELS, TranslationChannel
    seen = []
    def translate(segments, language, profile, api_key):
        seen.append((segments, language, profile['channel'], api_key))
        return TextResponse('translations[0]{id,text}:', {'input_tokens': 1, 'output_tokens': 1}, 'synthetic')
    monkeypatch.setitem(CHANNELS, 'synthetic', TranslationChannel('Test channel', TranslationConfig, (), translate))
    provider = create(admin_case, {'name': 'Second source', 'channel': 'synthetic',
                                  'config': {'model': 'test'}, 'api_key': 'isolated-new-key'})
    with session_factory()() as db:
        profile = snapshot(db, provider['id'])['text']
    assert call_text([], 'en', profile).request_id == 'synthetic'
    assert seen == [([], 'en', 'synthetic', 'isolated-new-key')]


def test_disabled_supplier_pauses_before_request_without_metering(text_case):
    job_id, lease_id = text_case
    with session_factory()() as db:
        provider_id = db.get(Job, job_id).config['text']['provider_id']
        db.get(ComputeNode, 'text-node').engine_version = 'control'
        db.get(TranslationProvider, provider_id).enabled = False
        db.commit()
    with pytest.raises(TextError, match='TEXT_PROVIDER_DISABLED') as exc:
        classic.reserve_call(job_id, lease_id, 0, SEGMENTS, 'zh-Hans')
    workers.fail_stage(lease_id, exc.value)
    with session_factory()() as db:
        lease = db.get(ExecutionLease, lease_id)
        assert lease.completed_at is not None
        assert db.get(JobStage, lease.stage_id).status == 'ready'
        assert db.get(Job, job_id).status == 'running'
        assert db.scalar(select(TextCall.id)) is None
        assert claim_stage(db, 'text-node') is None
        db.get(TranslationProvider, provider_id).enabled = True
        db.commit()
        assert claim_stage(db, 'text-node') is not None
        db.commit()


def test_saturated_supplier_does_not_block_another_supplier(scheduler_case):
    first_config = scheduler_case
    with session_factory()() as db:
        lock_scheduler(db)
        first = db.get(TranslationProvider, first_config['text']['provider_id'])
        first.requests_per_minute = 1
        second = write_provider(db, ProviderWrite(**body('Second')))
        second_config = snapshot(db, second.id)
        node_id = control_node(db, 'text')
        db.commit()
    used = add_job(first_config, stage='text')
    with session_factory()() as db:
        lease = claim_stage(db, node_id)
        assert lease.job_id == used
        db.commit()
        job = db.get(Job, used)
        db.add(TextCall(job_id=used, attempt_id=job.attempt_id, execution_lease_id=lease.id,
                        provider_id=first.id, model=first_config['text']['model'], group_index=0,
                        sequence=1, reserved_micros=100, accounted_micros=100, completed_at=now()))
        lease_id = lease.id
        db.commit()
    workers.complete_stage(lease_id, {'translations': {}})
    blocked = add_job(first_config, stage='text')
    runnable = add_job(second_config, stage='text')
    with session_factory()() as db:
        lease = claim_stage(db, node_id)
        assert lease.job_id == runnable and lease.job_id != blocked
        db.commit()


def test_first_provider_creation_is_atomic_across_replicas(text_database):
    with session_factory()() as db:
        db.execute(delete(TranslationProviderRevision))
        db.execute(delete(TranslationProvider))
        db.commit()
    barrier = Barrier(2)
    def create_one(index):
        with session_factory()() as db:
            barrier.wait(timeout=5)
            lock_scheduler(db)
            provider = write_provider(db, ProviderWrite(**body('Replica ' + str(index))))
            db.commit()
            return provider.id
    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(create_one, range(2)))
    with session_factory()() as db:
        providers = db.scalars(select(TranslationProvider)).all()
        assert len(providers) == 2 and len(set(ids)) == 2
        assert sum(row.is_default for row in providers) == 1


def test_parallel_requests_obey_supplier_limit(text_case):
    with session_factory()() as db:
        provider = db.get(TranslationProvider, db.get(Job, text_case[0]).config['text']['provider_id'])
        provider.requests_per_minute = 1
        db.commit()
    barrier = Barrier(2)
    def reserve(group):
        barrier.wait(timeout=5)
        try:
            return classic.reserve_call(*text_case, group, SEGMENTS, 'en')[0]
        except TextError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(reserve, range(2)))
    assert outcomes.count('TEXT_RATE_LIMITED') == 1
    with session_factory()() as db:
        assert len(db.scalars(select(TextCall)).all()) == 1


def test_database_failure_never_logs_credential_parameters_or_driver_detail(admin_case, caplog):
    client, auth = admin_case
    assert engine().hide_parameters
    def fail_insert(connection, cursor, statement, parameters, context, many):
        if statement.startswith('INSERT INTO translation_provider_revisions'):
            raise IntegrityError(statement, parameters, RuntimeError('Failing row contains isolated-new-key'))
    event.listen(engine(), 'before_cursor_execute', fail_insert)
    try:
        response = client.post(PATH, headers=auth, json=body())
    finally:
        event.remove(engine(), 'before_cursor_execute', fail_insert)
    assert response.status_code == 503
    assert 'isolated-new-key' not in response.text + caplog.text
    assert 'IntegrityError' in caplog.text
    assert client.get(PATH, headers=auth).json()['items'] == []


def test_disable_after_reservation_does_not_spend_retry_or_rpm(text_case, monkeypatch):
    with session_factory()() as db:
        job = db.get(Job, text_case[0])
        provider_id = job.config['text']['provider_id']
        # A single allowed real request makes an accidental spent attempt visible.
        job.config = {**job.config, 'text': {**job.config['text'], 'max_attempts': 1}}
        db.get(TranslationProvider, provider_id).requests_per_minute = 1
        db.commit()
    original = classic.call_text
    def disabled_before_transport(*args):
        from app.translation_providers import require_enabled
        with session_factory()() as db:
            db.get(TranslationProvider, provider_id).enabled = False
            db.commit()
            require_enabled(db, args[2])
    monkeypatch.setattr(classic, 'call_text', disabled_before_transport)
    with pytest.raises(TextError, match='TEXT_PROVIDER_DISABLED'):
        classic.run_text_stage(*text_case)
    with session_factory()() as db:
        call = db.scalar(select(TextCall))
        assert call.accounted_micros == 0 and call.error_code == 'TEXT_PROVIDER_DISABLED'
        call.started_at = now() - timedelta(hours=1)  # Also must not start the page deadline.
        job = db.get(Job, text_case[0])
        assert classic.text_remaining(db, job) == job.config['provider']['timeout_seconds']
        call.started_at = now()  # Stay inside the RPM window to prove it is excluded.
        db.get(TranslationProvider, provider_id).enabled = True
        db.commit()
    monkeypatch.setattr(classic, 'call_text', original)
    assert classic.run_text_stage(*text_case) == {'translations': {'b001': '你好！'}}
    with session_factory()() as db:
        calls = db.scalars(select(TextCall).order_by(TextCall.sequence)).all()
        assert [c.sequence for c in calls] == [1, 2]
        assert calls[1].accounted_micros > 0


def test_mid_page_rate_wait_releases_shared_slot(text_case, monkeypatch):
    job_id, lease_id = text_case
    first_group = [{'id': 'b001', 'source': 'a' * 200}]
    with session_factory()() as db:
        job = db.get(Job, job_id)
        db.get(TranslationProvider, job.config['text']['provider_id']).requests_per_minute = 1
        job.config = {**job.config, 'text': {**job.config['text'], 'group_bytes': 256}}
        state = db.get(ClassicState, job_id)
        state.analysis = {**state.analysis, 'segments': first_group + [{'id': 'b002', 'source': 'b' * 200}]}
        db.get(ComputeNode, 'text-node').engine_version = 'control'
        db.get(ComputeNode, 'text-node').capacity = 1
        db.commit()
    monkeypatch.setattr(classic, 'wait_for_retry', lambda *args: pytest.fail('Rate waits must release the execution slot'))
    with pytest.raises(TextError, match='TEXT_RATE_LIMITED') as exc:
        classic.run_text_stage(job_id, lease_id)
    workers.fail_stage(lease_id, exc.value)
    with session_factory()() as db:
        lease = db.get(ExecutionLease, lease_id)
        assert lease.completed_at is not None
        stage = db.get(JobStage, lease.stage_id)
        assert stage.status == 'ready' and stage.available_at > now() + timedelta(seconds=50)
        assert db.get(ClassicState, job_id).translations == {'b001': '你好！'}
        assert len(db.scalars(select(TextCall)).all()) == 1


@pytest.mark.parametrize('attempts', [1, 3])
def test_upstream_429_yields_with_durable_attempt_budget(text_case, monkeypatch, attempts):
    original = classic.call_text
    with session_factory()() as db:
        job = db.get(Job, text_case[0])
        job.config = {**job.config, 'text': {**job.config['text'], 'max_attempts': attempts}}
        db.get(ComputeNode, 'text-node').engine_version = 'control'
        db.commit()
    def rate_limited(*args):
        raise TextError('TEXT_RATE_LIMITED', 'Upstream limit', retryable=True, retry_after=90)
    monkeypatch.setattr(classic, 'call_text', rate_limited)
    monkeypatch.setattr(classic, 'wait_for_retry', lambda *args: pytest.fail('429 must release the execution slot'))
    code = 'TEXT_RETRY_EXHAUSTED' if attempts == 1 else 'TEXT_RATE_LIMITED'
    with pytest.raises(TextError, match=code) as exc:
        classic.run_text_stage(*text_case)
    workers.fail_stage(text_case[1], exc.value)
    with session_factory()() as db:
        call = db.scalar(select(TextCall))
        assert call.error_code == 'TEXT_RATE_LIMITED' and call.accounted_micros > 0
        lease = db.get(ExecutionLease, text_case[1])
        stage = db.get(JobStage, lease.stage_id)
        assert lease.completed_at is not None
        if attempts == 1:
            assert stage.status == 'failed' and db.get(Job, text_case[0]).status == 'failed'
            return
        assert stage.available_at > now() + timedelta(seconds=89)
        assert stage.status == 'ready'
        stage.available_at = now()
        db.commit()
        resumed = claim_stage(db, 'text-node')
        assert resumed is not None
        db.commit()
    monkeypatch.setattr(classic, 'call_text', original)
    assert classic.run_text_stage(text_case[0], resumed.id) == {'translations': {'b001': '你好！'}}
    with session_factory()() as db:
        calls = db.scalars(select(TextCall).order_by(TextCall.sequence)).all()
        assert len(calls) == 2 and calls[1].sequence == 2
