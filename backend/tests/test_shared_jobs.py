"""Distinct request UUIDs share real work without a second reservation or hidden retry."""
from datetime import timedelta
import pytest
from sqlalchemy import func, select
from conftest import create, login_plus as login, png_variant, run_job, upload, submit_asset, quota_usage, request_record, request_id
from app.config import settings
from app.db import session_factory
from app.entitlement_models import QuotaPeriod
from app.models import Asset, Job, Ledger, Provider, now
from app.translation_requests import TranslationRequest, ImageAdmission
from test_cluster_submissions import snapshot


@pytest.mark.parametrize('status,state', [('queued','queued'),('running','running'),
    ('outcome_unknown','needs_attention'),('unknown_released','needs_attention'),('failed','failed'),('cancelled','failed')])
def test_existing_intent_is_reused_before_quota_and_never_implicitly_retried(client, png, status, state):
    auth = login(client)
    asset = upload(client, auth, png)
    first = create(client, auth, asset, key='device-one').json()
    with session_factory()() as db:
        job = db.get(Job, first['id'])
        job.status = status
        if status == 'cancelled':
            job.cancel_requested = True
            job.discard_output = True
        period = db.get(QuotaPeriod, job.quota_period_id)
        period.granted = period.used + period.reserved
        db.commit()
    reused = submit_asset(client, auth, asset, key='device-two')
    assert reused.status_code == (202 if state in {'queued','running','needs_attention'} else 200), reused.text
    assert reused.json()['state'] == state
    assert request_record(client, auth, reused.json()['id']).job_id == first['id']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Ledger)) == 1
        assert db.scalar(select(func.count()).select_from(TranslationRequest)) == 2


@pytest.mark.parametrize('terminal', ['succeeded', 'failed', 'cancelled'])
def test_accepted_uuid_keeps_terminal_result_and_frozen_config(client, png, terminal, monkeypatch):
    auth = login(client)
    source = upload(client, auth, png)
    original = create(client, auth, source, key='original').json()
    assert create(client, auth, source, key='alias').json()['id'] == original['id']
    if terminal == 'succeeded':
        from app.adapters.images import TranslationOutput
        import app.workers as workers
        monkeypatch.setattr(workers, 'redraw', lambda *args: TranslationOutput(png))
        run_job(original['id'])
    else:
        from app.workers import finish_job
        from app.scheduler import lock_scheduler
        with session_factory()() as db:
            lock_scheduler(db)
            finish_job(db, db.get(Job, original['id']), terminal)
            db.commit()
    with session_factory()() as db:
        provider = db.get(Provider, 'default')
        provider.config = {**provider.config, 'model': 'changed-model'}
        db.commit()
    repeat = create(client, auth, source, key='alias')
    assert repeat.status_code == 200 and repeat.json()['id'] == original['id']
    assert repeat.json()['status'] == terminal
    assert create(client, auth, source, key='alias', language='en').status_code == 409
    assert create(client, auth, upload(client, auth, png_variant(png, 9)), key='alias').status_code == 409
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(TranslationRequest)) == 2


def test_snapshot_restores_aliases_and_cancellation_without_cursor(client, png):
    alice, bob = login(client), login(client, 'bob')
    source = upload(client, alice, png)
    accepted = [submit_asset(client, alice, source, key=f'device-{i}').json() for i in range(6)]
    keys = [row['id'] for row in accepted]
    jobs = {request_record(client, alice, row['id']).job_id for row in accepted}
    assert len(jobs) == 1
    job_id = jobs.pop()
    assert snapshot(client, bob, keys).json() == {'items': [], 'missing_ids': keys}
    assert client.post('/v1/translations/' + keys[0] + '/cancel', headers=bob).status_code == 404
    for _ in range(2):
        assert client.post('/v1/translations/' + keys[0] + '/cancel', headers=alice).json()['state'] == 'failed'
    assert all(item['state'] == 'failed' for item in snapshot(client, alice, keys).json()['items'])
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TranslationRequest)) == 6
        assert sorted(db.scalars(select(Ledger.kind))) == ['release', 'reserve']


def test_success_cache_remains_free_with_zero_spare_quota(client, png, monkeypatch):
    from app.adapters.images import TranslationOutput
    import app.workers as workers
    monkeypatch.setattr(workers, 'redraw', lambda *args: TranslationOutput(png))
    auth = login(client)
    source = upload(client, auth, png)
    first = create(client, auth, source).json()
    run_job(first['id'])
    with session_factory()() as db:
        period = db.get(QuotaPeriod, first['quota_period_id'])
        period.granted = period.used + period.reserved
        db.commit()
    cached = submit_asset(client, auth, source, key='free-cache')
    assert cached.status_code == 200 and cached.json()['state'] == 'succeeded'
    assert cached.json()['result']['download_url']
    assert request_record(client, auth, cached.json()['id']).job_id == first['id']


def test_no_text_result_is_reusable_without_asset_or_new_work(client, png):
    from app.workers import finish_job
    from app.scheduler import lock_scheduler
    from app.queue_models import JobStage
    settings().classic_enabled = True
    auth = login(client)
    source = upload(client, auth, png)
    first = create(client, auth, source, mode='classic').json()
    with session_factory()() as db:
        lock_scheduler(db)
        finish_job(db, db.get(Job, first['id']), 'no_text')
        db.commit()
    reused = submit_asset(client, auth, source, key='other-device', mode='classic')
    assert reused.status_code == 200 and reused.json()['state'] == 'succeeded'
    assert reused.json()['result']['kind'] == 'no_text'
    assert not reused.json()['result'].get('download_url')
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(JobStage)) == 2


def test_active_pin_keeps_expired_original_available_for_reuse(client, png):
    auth = login(client)
    source = upload(client, auth, png)
    first = create(client, auth, source).json()
    with session_factory()() as db:
        db.get(Asset, source).expires_at = now() - timedelta(days=1)
        db.commit()
    assert create(client, auth, source, key='other-device').json()['id'] == first['id']


def test_unknown_redraw_cannot_automatically_restart_even_after_config_change(client, png):
    auth = login(client)
    source = upload(client, auth, png)
    original = submit_asset(client, auth, source, key='original').json()
    record = request_record(client, auth, original['id'])
    with session_factory()() as db:
        job = db.get(Job, record.job_id)
        job.status, job.unknown_since = 'outcome_unknown', now()
        provider = db.get(Provider, 'default')
        provider.config = {**provider.config, 'model': 'changed-model'}
        db.commit()
    auto = submit_asset(client, auth, source, key='other-device')
    assert auto.status_code == 202 and auto.json()['state'] == 'needs_attention'
    assert request_record(client, auth, auto.json()['id']).job_id == record.job_id
    retry = client.put('/v1/translations/' + request_id('retry'), headers=auth, json={'retry_of': original['id']})
    assert retry.status_code == 409
    regenerate = client.put('/v1/translations/' + request_id('regenerate'), headers=auth,
        json={'regenerate_of': original['id']})
    assert regenerate.status_code == 409 and regenerate.json()['error']['code'] == 'UNKNOWN_COST_ACK_REQUIRED'
    accepted = client.put('/v1/translations/' + request_id('regenerate'), headers=auth,
        json={'regenerate_of': original['id'], 'acknowledge_unknown_cost': True})
    assert accepted.status_code == 202
    assert request_record(client, auth, accepted.json()['id']).job_id != record.job_id


def test_explicit_retry_only_accepts_failed_intent_and_new_uuid(client, png):
    from app.workers import finish_job
    from app.scheduler import lock_scheduler
    auth = login(client)
    original = submit_asset(client, auth, upload(client, auth, png)).json()
    route = '/v1/translations/' + request_id('retry')
    assert client.put(route, headers=auth, json={'retry_of': original['id']}).status_code == 409
    record = request_record(client, auth, original['id'])
    with session_factory()() as db:
        lock_scheduler(db)
        finish_job(db, db.get(Job, record.job_id), 'failed')
        db.commit()
    accepted = client.put(route, headers=auth, json={'retry_of': original['id']})
    assert accepted.status_code == 202
    assert request_record(client, auth, accepted.json()['id']).job_id != record.job_id
    assert client.put(route, headers=auth, json={'retry_of': original['id']}).json()['id'] == accepted.json()['id']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 2
        assert db.scalar(select(func.count()).select_from(ImageAdmission)) == 2


def test_failed_retranslation_does_not_hide_previous_result(client, png, monkeypatch):
    from app.adapters.images import TranslationOutput
    from app.errors import ProcessingError
    import app.workers as workers
    auth = login(client)
    source = upload(client, auth, png)
    monkeypatch.setattr(workers, 'redraw', lambda *args: TranslationOutput(png))
    original = create(client, auth, source, key='delivered').json()
    run_job(original['id'])
    replacement = create(client, auth, source, key='explicit-new', regenerate=True, rerun_job_id=original['id']).json()
    def rejected(*args):
        raise ProcessingError('PROVIDER_REJECTED', 'isolated rejection')
    monkeypatch.setattr(workers, 'redraw', rejected)
    run_job(replacement['id'])
    before = quota_usage(client, auth)
    restored = submit_asset(client, auth, source, key='new-device')
    assert restored.status_code == 200 and restored.json()['state'] == 'succeeded'
    assert request_record(client, auth, restored.json()['id']).job_id == original['id']
    assert quota_usage(client, auth) == before


def test_cancel_in_flight_cannot_start_duplicate_work_under_fresh_uuid(client, png):
    from conftest import claim_job
    auth = login(client)
    source = upload(client, auth, png)
    original = submit_asset(client, auth, source).json()
    job_id = request_record(client, auth, original['id']).job_id
    assert claim_job(job_id)
    response = client.post('/v1/translations/'+original['id']+'/cancel',headers=auth)
    assert response.status_code == 200
    with session_factory()() as db:
        job = db.get(Job,job_id)
        assert job.status == 'running' and job.cancel_requested and job.discard_output
    duplicate = submit_asset(client,auth,source,key='new-window-during-cancellation')
    assert duplicate.status_code == 202
    assert request_record(client,auth,duplicate.json()['id']).job_id == job_id
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(ImageAdmission)) == 1
