"""Explicit regeneration inherits frozen intent and uses present membership limits."""
from datetime import timedelta
import pytest
from sqlalchemy import func, select
from conftest import create, login_plus as login, upload, submit_asset, quota_usage, request_id, request_record, run_job


def done(client, auth, png, monkeypatch):
    from app import workers
    from app.adapters.images import TranslationOutput
    monkeypatch.setattr(workers, 'redraw', lambda *args: TranslationOutput(png))
    original = submit_asset(client, auth, upload(client, auth, png)).json()
    run_job(request_record(client, auth, original['id']).job_id)
    return client.get('/v1/translations/' + original['id'], headers=auth).json()


def regenerate(client, auth, previous, key='new', **fields):
    return client.put('/v1/translations/' + request_id(key), headers=auth,
        json={'regenerate_of':previous['id'], **fields})


def test_regeneration_uses_current_quota_and_replay_preserves_acceptance(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Job, Ledger, Provider, User, now
    auth = login(client)
    original = done(client, auth, png, monkeypatch)
    first = regenerate(client, auth, original)
    assert first.status_code == 202 and first.json()['state'] == 'queued'
    original_job = request_record(client, auth, original['id']).job_id
    revised_job = request_record(client, auth, first.json()['id']).job_id
    with session_factory()() as db:
        assert db.get(Job,revised_job).version > db.get(Job,original_job).version
        db.get(User,db.get(Job,original_job).owner_id).plus_expires_at = now()-timedelta(seconds=1)
        db.get(Provider,'default').enabled = False
        db.commit()
    repeat = regenerate(client,auth,original)
    assert repeat.status_code == 202 and repeat.json()['id'] == first.json()['id']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 2
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind=='reserve')) == 2


def test_regeneration_checks_membership_before_creating_work(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import User, now
    auth = login(client)
    original = done(client, auth, png, monkeypatch)
    owner = client.get('/v1/me',headers=auth).json()['user']['id']
    with session_factory()() as db:
        db.get(User,owner).plus_expires_at = now()-timedelta(seconds=1)
        db.commit()
    response = regenerate(client,auth,original)
    assert response.status_code == 403 and response.json()['error']['code'] == 'PLUS_REQUIRED'
    assert client.get('/v1/translations/'+original['id'],headers=auth).json()['state']=='succeeded'


@pytest.mark.parametrize('extra', [
    {'mode':'classic'}, {'target_language':'en'}, {'image':{'sha256':'a'*64,'byte_size':1,'content_type':'image/png'}},
    {'retry_of':'11111111-1111-4111-8111-111111111111'}, {'max_quota_pages':0}, {'expected_kind':'redraw_grant'}])
def test_regeneration_rejects_mixed_intent_and_removed_controls(client,png,monkeypatch,extra):
    auth = login(client)
    original = done(client,auth,png,monkeypatch)
    response = regenerate(client,auth,original,**extra)
    assert response.status_code == 422
    assert quota_usage(client,auth)['reserved'] == 0


def test_regeneration_cannot_reference_another_account(client,png,monkeypatch):
    auth = login(client)
    original = done(client,auth,png,monkeypatch)
    response = regenerate(client,login(client,'bob'),original)
    assert response.status_code == 404
