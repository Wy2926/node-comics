"""Shared versions stay constant-sized; only real generation creates a job."""
from datetime import timedelta
from hashlib import sha256
from sqlalchemy import event, func, select
from conftest import create, login_plus as login, png_variant, run_job, submit_asset, upload


def request_result(client, auth, png, key='cache', **fields):
    return client.post('/v1/translation-plans', headers=auth, json={'trigger': 'manual', 'items': [{
        'page_key': 'page', 'operation_key': key, 'mode': 'redraw', 'target_language': 'zh-Hans',
        'image': {'client_item_id': 'page', 'image_sha256': sha256(png).hexdigest(),
            'byte_size': len(png), 'content_type': 'image/png', **fields}}]})


def completed(client, png, monkeypatch):
    from app import workers
    from app.adapters.images import TranslationOutput
    monkeypatch.setattr(workers, 'redraw', lambda *args: TranslationOutput(png_variant(png, 1)))
    auth = login(client)
    job = create(client, auth, upload(client, auth, png)).json()
    run_job(job['id'])
    return auth, client.get('/v1/jobs/' + job['id'], headers=auth).json()


def test_cache_grants_do_not_create_jobs_stages_billing_or_duplicate_assets(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Asset, Job, Ledger
    from app.plan_models import ImageAdmission, TranslationOperation
    from app.results import ResultAccess, TranslationResult
    from app.queue_models import JobStage
    _, original = completed(client, png, monkeypatch)
    for index in range(8):
        auth = login(client, f'reader-{index}')
        first = request_result(client, auth, png).json()['items'][0]['job']
        assert first['cache_hit'] and first['settlement'] == 'free'
        assert first['id'] != original['id'] and first['quota_pages'] == 0
        for key in ['cache', 'another-operation']:
            assert request_result(client, auth, png, key).json()['items'][0]['job']['id'] == first['id']
        assert client.get('/v1/jobs', headers=auth).json()['total'] == 0
    with session_factory()() as db:
        counts = {model.__name__: db.scalar(select(func.count()).select_from(model))
                  for model in (Job, JobStage, TranslationResult, ResultAccess, Asset, ImageAdmission, Ledger, TranslationOperation)}
        assert counts == {'Job': 1, 'JobStage': 1, 'TranslationResult': 1, 'ResultAccess': 8,
                          'Asset': 18, 'ImageAdmission': 1, 'Ledger': 2, 'TranslationOperation': 17}


def test_cache_access_supports_restore_file_match_feedback_and_rerun(client, png, monkeypatch):
    _, original = completed(client, png, monkeypatch)
    bob, stranger = login(client, 'bob'), login(client, 'stranger')
    first = request_result(client, bob, png, file_hash='a' * 64, page_index=0).json()['items'][0]['job']
    entry_id = first['id']
    assert client.get('/v1/jobs/' + entry_id, headers=stranger).status_code == 404
    assert client.get('/v1/images/' + first['output_asset_id'] + '/access', headers=stranger).status_code == 404
    assert client.get('/v1/images/' + first['output_asset_id'] + '/access', headers=bob).status_code == 200
    matched = client.post('/v1/file-pages/match', headers=bob, json={'pages': [{'file_hash': 'a' * 64,
        'page_index': 0}], 'mode': 'redraw', 'target_language': 'zh-Hans', 'include_display': True}).json()
    assert matched['items'][0]['jobs'][0]['id'] == entry_id
    assert client.post('/v1/jobs/status', headers=bob, json={'ids': [entry_id, original['id']]}).json()['items'][0]['id'] == entry_id
    assert client.get('/v1/me/translation-changes?cursor=0', headers=bob).json()['items'][0]['id'] == entry_id
    feedback = client.post('/v1/jobs/' + entry_id + '/feedback', headers={**bob, 'Idempotency-Key': 'feedback'},
        json={'issues': ['meaning'], 'output_asset_id': first['output_asset_id']})
    assert feedback.status_code == 201 and feedback.json()['job_id'] == entry_id
    rerun = submit_asset(client, bob, first['input_asset_id'], key='rerun', regenerate=True,
        rerun_job_id=entry_id).json()['items'][0]['job']
    assert not rerun['cache_hit'] and rerun['version'] > first['version']
    assert client.get('/v1/jobs', headers=bob).json()['total'] == 1
    run_job(rerun['id'])
    latest = client.get('/v1/jobs/' + entry_id + '/latest-result', headers=bob).json()
    assert latest['result']['id'] == rerun['id']


def test_latest_generated_version_is_not_changed_by_old_grant_timestamps(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import now
    from app.results import ResultAccess, TranslationResult
    alice, original = completed(client, png, monkeypatch)
    bob = login(client, 'bob')
    old = request_result(client, bob, png).json()['items'][0]['job']
    newer = submit_asset(client, alice, original['input_asset_id'], key='new-version', regenerate=True,
        rerun_job_id=original['id']).json()['items'][0]['job']
    run_job(newer['id'])
    with session_factory()() as db:
        db.get(ResultAccess, old['id']).created_at = now() + timedelta(days=1)
        generated = db.get(TranslationResult, newer['id']).generated_at
        db.commit()
    charlie = login(client, 'charlie')
    chosen = request_result(client, charlie, png).json()['items'][0]['job']
    with session_factory()() as db:
        assert db.get(ResultAccess, chosen['id']).result_id == newer['id']
        assert db.get(TranslationResult, newer['id']).generated_at == generated
    assert request_result(client, bob, png, 'keep-own-version').json()['items'][0]['job']['id'] == old['id']


def test_deleted_producer_does_not_revoke_other_grants_and_regrant_is_unique(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Job
    from app.results import ResultAccess
    alice, original = completed(client, png, monkeypatch)
    bob = login(client, 'bob')
    cached = request_result(client, bob, png).json()['items'][0]['job']
    assert client.delete('/v1/images/' + original['input_asset_id'], headers=alice).status_code == 200
    charlie = login(client, 'charlie')
    third = request_result(client, charlie, png).json()['items'][0]['job']
    assert third['cache_hit']
    assert client.delete('/v1/images/' + cached['output_asset_id'], headers=bob).status_code == 200
    assert not client.get('/v1/jobs/' + cached['id'], headers=bob).json()['result_available']
    renewed = request_result(client, bob, png, 'renew').json()['items'][0]['job']
    assert renewed['id'] == cached['id'] and renewed['result_available']
    assert renewed['output_asset_id'] != cached['output_asset_id']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ResultAccess)) == 2
        assert db.scalar(select(func.count()).select_from(Job)) == 1


def test_shared_discovery_runs_before_scheduler_lock_and_rechecks_deleted_hint(client, png, monkeypatch):
    from app import plan_api
    from app.db import engine, session_factory
    from app.models import Asset, now
    alice, original = completed(client, png, monkeypatch)
    bob = login(client, 'bob')
    statements = []
    def capture(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement.lower())
    event.listen(engine(), 'before_cursor_execute', capture)
    try:
        assert request_result(client, bob, png).json()['items'][0]['job']['cache_hit']
    finally:
        event.remove(engine(), 'before_cursor_execute', capture)
    discovery = [i for i, sql in enumerate(statements) if 'producer_live' in sql]
    locking = [i for i, sql in enumerate(statements) if sql.startswith('update scheduler_mutex')]
    assert len(discovery) == 1 and discovery[0] < locking[0]
    # Simulate deletion between preflight and lock acquisition in a fresh account.
    discover = plan_api.shared_candidate
    def deleted_after_discovery(db, key):
        hint = discover(db, key)
        with session_factory()() as writer:
            for asset in writer.scalars(select(Asset).where(Asset.kind == 'redraw')):
                asset.deleted_at = now()
            writer.commit()
        return hint
    monkeypatch.setattr(plan_api, 'shared_candidate', deleted_after_discovery)
    charlie = login(client, 'charlie')
    response = request_result(client, charlie, png).json()['items'][0]
    assert response['disposition'] == 'accepted' and not response['job']['cache_hit']
