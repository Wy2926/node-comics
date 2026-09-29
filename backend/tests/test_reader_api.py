from conftest import quota_usage
"""Reader projections are private, cost-neutral and not limited by visible pagination."""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from conftest import create, login_plus as login, submit_asset, run_job, upload, png_variant, request_for_job, request_id
from conftest import complete


def rerun(client, auth, job, asset=None, key="rerun-latest"):
    response = create(client, auth, asset or job['input_asset_id'], key=key, regenerate=True, rerun_job_id=job['id'])
    assert response.status_code == 202, response.text
    return response.json()


def test_feedback_exact_result_private_idempotent_and_free(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Ledger
    from app.reader_api import Feedback
    auth = login(client)
    other = login(client, "other")
    admin = login(client, "admin")
    original = complete(client, auth, upload(client, auth, png), png, monkeypatch)
    newer = rerun(client, auth, original)
    before = quota_usage(client, auth)
    route = f"/v1/translations/{request_for_job(client, auth, original['id'])}/feedback"
    payload = {"issues": ["meaning", "meaning"], "comment": "  右下角的对白  ", "output_asset_id": original["output_asset_id"]}
    assert client.post(route, headers={**other, "Idempotency-Key": "feedback"}, json=payload).status_code == 404
    assert client.post(route, headers={**auth, "Idempotency-Key": "empty"}, json={}).status_code == 422
    assert client.post(route, headers={**auth, "Idempotency-Key": "wrong"}, json={**payload, "output_asset_id": original["input_asset_id"]}).status_code == 409
    first = client.post(route, headers={**auth, "Idempotency-Key": "feedback"}, json=payload)
    assert first.status_code == 201, first.text
    assert first.json()["translation_id"] == request_for_job(client, auth, original["id"])
    assert first.json()["translation_id"] != request_for_job(client, auth, newer["id"])
    assert first.json()["issues"] == ["meaning"]
    assert first.json()["comment"] == "右下角的对白"
    assert client.post(route, headers={**auth, "Idempotency-Key": "feedback"}, json=payload).json() == first.json()
    assert client.post(route, headers={**auth, "Idempotency-Key": "feedback"}, json={**payload, "comment": "changed"}).status_code == 409
    assert quota_usage(client, auth) == before
    assert client.get("/v1/me/feedback", headers=other).json()["total"] == 0
    assert client.get("/v1/admin/feedback", headers=auth).status_code == 403
    feedback_id = first.json()["id"]
    assert client.patch(f"/v1/admin/feedback/{feedback_id}", headers={**admin, "Idempotency-Key": "review"},
        json={"status": "reviewing", "expected_status": "received", "expected_updated_at": first.json()["updated_at"], "note": "checked exact output"}).json()["status"] == "reviewing"
    assert client.get("/v1/me/feedback", headers=auth).json()["items"][0]["status"] == "reviewing"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Feedback)) == 1


def test_history_keeps_each_uuid_and_never_restores_revoked_results(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Asset, Job, now
    auth = login(client)
    first = complete(client, auth, upload(client, auth, png), png, monkeypatch)
    second = rerun(client, auth, first)
    run_job(second['id'])
    first_id = request_for_job(client, auth, first['id'])
    second_id = request_for_job(client, auth, second['id'])
    with session_factory()() as db:
        db.get(Asset, db.get(Job, second['id']).output_asset_id).deleted_at = now()
        db.commit()
    history = client.get('/v1/translations', headers=auth).json()
    assert history['total'] == 2
    newest = next(item for item in history['items'] if item['id'] == second_id)
    assert newest['state'] == 'failed' and newest['result'] is None
    assert client.get('/v1/translations/' + first_id, headers=login(client, 'other')).status_code == 404


def test_revoked_source_cannot_be_regenerated_or_resurrected(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Asset, now
    auth = login(client)
    old_asset = upload(client, auth, png)
    first = complete(client, auth, old_asset, png, monkeypatch)
    first_id = request_for_job(client, auth, first['id'])
    with session_factory()() as db:
        db.get(Asset, old_asset).expires_at = now() - timedelta(days=1)
        db.commit()
    new_asset = upload(client, auth, png)
    assert old_asset != new_asset
    assert client.delete('/v1/translations/' + first_id, headers=auth).status_code == 200
    response = client.put('/v1/translations/' + request_id('restore-rerun'), headers=auth,
        json={'regenerate_of': first_id})
    assert response.status_code == 410
    assert response.json()['error']['code'] == 'TRANSLATION_UNAVAILABLE'
    assert client.get('/v1/translations/' + first_id, headers=auth).json()['error']['code'] == 'TRANSLATION_UNAVAILABLE'


def test_summary_full_interval_local_day_and_no_reserve_double_count(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Job, Ledger, User, now
    auth = login(client)
    done = complete(client, auth, upload(client, auth, png), png, monkeypatch)
    zone = ZoneInfo("Asia/Shanghai")
    today = datetime.now(timezone.utc).astimezone(zone).replace(hour=0, minute=0, second=0, microsecond=0)
    start = today.astimezone(timezone.utc).replace(tzinfo=None)
    with session_factory()() as db:
        owner = db.get(Job, done["id"]).owner_id
        for row in db.scalars(select(Ledger).where(Ledger.owner_id == owner)):row.created_at = start - timedelta(seconds=1)
        for i in range(45):
            db.add(Ledger(owner_id=owner,job_id=done["id"],transaction_key=f"fixture-{i}",quota_kind="redraw_monthly",kind="settle",amount=2,created_at=start+timedelta(minutes=i)))
        for kind in ("reserve","release","grant"):
            db.add(Ledger(owner_id=owner,transaction_key=f"fixture-{kind}",quota_kind="redraw_monthly",kind=kind,amount=900,created_at=now()))
        db.add(Ledger(owner_id=owner,transaction_key="outside-day",quota_kind="redraw_monthly",kind="settle",amount=300,created_at=start+timedelta(days=1)))
        db.commit()
    response = client.get("/v1/me/usage/summary?days=1&timezone=Asia%2FShanghai", headers=auth)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["quota_used"]["redraw"] == 90
    assert data["by_mode"]["redraw"] == 1
    assert len(data["days"]) == 1 and data["days"][0]["redraw"] == 1
    assert data["delivered"] == 1
    assert len(client.get("/v1/me/usage?limit=20", headers=auth).json()["items"]) == 20
    assert client.get("/v1/me/usage/summary?timezone=bad-zone", headers=auth).status_code == 422
    assert client.get("/v1/me/usage/summary?days=0", headers=auth).status_code == 422
    assert client.get("/v1/me/usage/summary", headers=login(client,"empty")).json()["delivered"] == 0
