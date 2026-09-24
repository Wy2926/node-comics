from conftest import inspect_job
"""Sharing creates caller-owned authorizations, never synthetic computation jobs."""
from datetime import timedelta
from sqlalchemy import event, func, select
from conftest import create, login_plus as login, login as free_login, png_variant, run_job, submit_asset, upload, request_record
from test_cluster_submissions import descriptor, submit


def request_result(client, auth, png, key='cache'):
    return submit(client, auth, descriptor(png), key=key, mode='redraw')


def completed(client, png, monkeypatch):
    from app import workers
    from app.adapters.images import TranslationOutput
    monkeypatch.setattr(workers, 'redraw', lambda *args: TranslationOutput(png_variant(png, 1)))
    auth = login(client)
    job = create(client, auth, upload(client, auth, png)).json()
    run_job(job['id'])
    return auth, inspect_job(job['id'])


def test_cache_grants_do_not_create_jobs_stages_billing_or_duplicate_assets(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Asset, Job, Ledger
    from app.translation_requests import ImageAdmission, TranslationRequest
    from app.results import ResultAccess, TranslationResult
    from app.queue_models import JobStage
    _, original = completed(client, png, monkeypatch)
    for index in range(8):
        auth = free_login(client, f'reader-{index}')
        first = request_result(client, auth, png)
        assert first.status_code == 200 and first.json()['state'] == 'succeeded'
        translated = first.json()
        assert translated['result']['download_url'] and translated['result']['asset_id'] != original['output_asset_id']
        for key in ['cache', 'another-request']:
            reused = request_result(client, auth, png, key).json()
            assert reused['result']['asset_id'] == translated['result']['asset_id']
        assert client.get('/v1/me/usage', headers=auth).json()['items'] == []
    with session_factory()() as db:
        counts = {model.__name__: db.scalar(select(func.count()).select_from(model))
                  for model in (Job, JobStage, TranslationResult, ResultAccess, Asset, ImageAdmission, Ledger, TranslationRequest)}
        assert counts == {'Job': 1, 'JobStage': 1, 'TranslationResult': 1, 'ResultAccess': 8,
                          'Asset': 18, 'ImageAdmission': 1, 'Ledger': 2, 'TranslationRequest': 17}


def test_shared_result_supports_file_mapping_feedback_and_regeneration(client, png, monkeypatch):
    _, original = completed(client, png, monkeypatch)
    bob, stranger = login(client, 'bob'), login(client, 'stranger')
    first = request_result(client, bob, png).json()
    path = '/v1/translations/' + first['id']
    assert client.get(path, headers=stranger).status_code == 404
    assert client.get('/v1/images/' + first['result']['asset_id'] + '/access', headers=stranger).status_code == 404
    mapped = client.put('/v1/file-pages/bind', headers=bob,
        json={'translation_id': first['id'], 'file_hash': 'a'*64, 'page_index': 0})
    assert mapped.status_code == 200, mapped.text
    matched = client.post('/v1/file-pages/match', headers=bob,
        json={'pages':[{'file_hash':'a'*64,'page_index':0}], 'mode':'redraw','target_language':'zh-Hans'}).json()
    assert matched['items'][0]['asset'] is not None
    record = request_record(client, bob, first['id'])
    assert record.job_id is None and record.access_id
    feedback = client.post(path + '/feedback', headers={**bob,'Idempotency-Key':'feedback'},
        json={'issues':['meaning'], 'output_asset_id':first['result']['asset_id']})
    assert feedback.status_code == 201, feedback.text
    from conftest import request_id
    rerun = client.put('/v1/translations/' + request_id('rerun'), headers=bob, json={'regenerate_of':first['id']})
    assert rerun.status_code == 202
    assert request_record(client, bob, rerun.json()['id']).job_id
    assert client.get(path, headers=bob).json()['state'] == 'succeeded'


def test_deleted_shared_grant_cannot_revive_accepted_request(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Job
    from app.results import ResultAccess
    alice, original = completed(client, png, monkeypatch)
    bob = login(client, 'bob')
    cached = request_result(client, bob, png).json()
    path = '/v1/translations/' + cached['id']
    assert client.delete('/v1/images/' + original['input_asset_id'], headers=alice).status_code == 200
    assert request_result(client, login(client,'charlie'), png).json()['state'] == 'succeeded'
    etag = client.get(path, headers=bob).headers['ETag']
    assert client.delete('/v1/images/' + cached['result']['asset_id'], headers=bob).status_code == 200
    revoked = client.get(path, headers={**bob, 'If-None-Match':etag})
    assert revoked.status_code == 200 and revoked.json()['state'] == 'failed' and revoked.json()['error']['code'] == 'TRANSLATION_UNAVAILABLE'
    assert request_result(client, bob, png).status_code == 410
    renewed = request_result(client, bob, png, 'renew').json()
    assert renewed['state'] == 'succeeded' and renewed['result']['asset_id'] != cached['result']['asset_id']
    assert request_result(client, bob, png).status_code == 410
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1


def test_completed_snapshot_refreshes_signature_without_probe_or_scheduler_lock(client, png, monkeypatch):
    from app.db import engine
    from app import assets
    auth, _ = completed(client, png, monkeypatch)
    from conftest import request_id
    path = '/v1/translations/' + request_id('operation-1')
    statements = []
    def capture(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement.lower())
    event.listen(engine(), 'before_cursor_execute', capture)
    try:
        first = client.get(path, headers=auth)
        second = client.get(path, headers=auth)
        conditional = client.get(path, headers={**auth,'If-None-Match':first.headers['ETag']})
    finally:
        event.remove(engine(), 'before_cursor_execute', capture)
    assert first.status_code == second.status_code == 200 and conditional.status_code == 304
    assert first.headers['ETag'] == second.headers['ETag']
    assert first.json()['result']['download_url'] and second.json()['result']['download_url']
    assert not any('scheduler_mutex' in sql and sql.startswith('update') for sql in statements)
