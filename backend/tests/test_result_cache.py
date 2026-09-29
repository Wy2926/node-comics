from admission_test_utils import window_count
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


def test_same_owner_cache_aliases_do_not_duplicate_work_or_billing(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Asset, Job, Ledger
    from app.translation_requests import TranslationRequest
    from app.queue_models import JobStage
    auth, original = completed(client, png, monkeypatch)
    for index in range(8):
        result = request_result(client, auth, png, f'alias-{index}')
        assert result.status_code == 200 and result.json()['state'] == 'succeeded'
        assert request_record(client, auth, result.json()['id']).job_id == original['id']
        assert client.get(result.json()['result']['artifact']['path'], headers=auth).status_code == 200
    with session_factory()() as db:
        counts = {model.__name__: db.scalar(select(func.count()).select_from(model))
            for model in (Job, JobStage, Asset, Ledger, TranslationRequest)}
        assert window_count('image') == 1
        assert counts == {'Job':1, 'JobStage':1,
                          'Asset':3, 'Ledger':2, 'TranslationRequest':9}


def test_cross_account_cache_never_grants_result_or_skips_input(client, png, monkeypatch):
    alice, original = completed(client, png, monkeypatch)
    bob = login(client, 'bob')
    response = request_result(client, bob, png)
    assert response.status_code == 202 and response.json()['state'] == 'needs_input'
    assert response.json()['result'] is None
    assert client.get('/v1/translations/' + response.json()['id'], headers=alice).status_code == 404
    assert request_record(client, bob, response.json()['id']).job_id != original['id']


def test_completed_snapshot_has_stable_result_without_scheduler_lock(client, png, monkeypatch):
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
    assert first.json()['result']['artifact']['path'] and second.json()['result']['artifact']['path']
    assert not any('scheduler_mutex' in sql and sql.startswith('update') for sql in statements)
