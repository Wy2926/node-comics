from conftest import quota_usage
"""Reader projections are private, cost-neutral and not limited by visible pagination."""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from conftest import create, login_plus as login, submit_asset, run_job, upload, png_variant
from test_file_pages import FILE_HASH, bind, complete


def rerun(client, auth, job, asset=None, key="rerun-latest"):
    response = submit_asset(client, auth, asset or job['input_asset_id'], key=key, regenerate=True, rerun_job_id=job['id'])
    assert response.status_code == 202, response.text
    return response.json()['items'][0]['job']


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
    route = f"/v1/jobs/{original['id']}/feedback"
    payload = {"issues": ["meaning", "meaning"], "comment": "  右下角的对白  ", "output_asset_id": original["output_asset_id"]}
    assert client.post(route, headers={**other, "Idempotency-Key": "feedback"}, json=payload).status_code == 404
    assert client.post(route, headers={**auth, "Idempotency-Key": "empty"}, json={}).status_code == 422
    assert client.post(route, headers={**auth, "Idempotency-Key": "wrong"}, json={**payload, "output_asset_id": original["input_asset_id"]}).status_code == 409
    first = client.post(route, headers={**auth, "Idempotency-Key": "feedback"}, json=payload)
    assert first.status_code == 201, first.text
    assert first.json()["job_id"] == original["id"] != newer["id"]
    assert first.json()["issues"] == ["meaning"]
    assert first.json()["comment"] == "右下角的对白"
    assert client.post(route, headers={**auth, "Idempotency-Key": "feedback"}, json=payload).json() == first.json()
    assert client.post(route, headers={**auth, "Idempotency-Key": "feedback"}, json={**payload, "comment": "changed"}).status_code == 409
    assert quota_usage(client, auth) == before
    assert client.get("/v1/me/feedback", headers=other).json()["total"] == 0
    assert client.get("/v1/admin/feedback", headers=auth).status_code == 403
    feedback_id = first.json()["id"]
    assert client.patch(f"/v1/admin/feedback/{feedback_id}", headers=admin, json={"status": "reviewing"}).json()["status"] == "reviewing"
    assert client.get("/v1/me/feedback", headers=auth).json()["items"][0]["status"] == "reviewing"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Feedback)) == 1


def test_latest_effect_survives_pending_and_failure_but_never_expired_fallback(client, png, monkeypatch):
    from app.db import session_factory
    from app.jobs import settle
    from app.models import Asset, Job, Provider, now
    auth = login(client)
    asset = bind(client, auth, png).json()["id"]
    first = complete(client, auth, asset, png, monkeypatch)
    second = rerun(client, auth, first)
    def projected():
        response = client.post("/v1/file-pages/match", headers=auth, json={"pages": [{"file_hash": FILE_HASH, "page_index": 0}], "mode": "redraw", "target_language": "zh-Hans", "include_display": True})
        assert response.status_code == 200, response.text
        return response.json()["items"][0]
    assert {j["id"] for j in projected()["display_jobs"]} == {first["id"], second["id"]}
    latest_route = f"/v1/jobs/{first['id']}/latest-result"
    assert client.get(latest_route, headers=auth).json()["result"]["id"] == first["id"]
    run_job(second["id"])
    third = rerun(client, auth, second, key="failed-third")
    with session_factory()() as db:
        job = db.get(Job, third["id"]);job.status = "failed";job.completed_at = now()
        settle(db, job, success=False)
        output = db.get(Asset, db.get(Job, second["id"]).output_asset_id);output.deleted_at = now()
        db.commit()
    result = client.get(latest_route, headers=auth).json()
    assert result["latest"]["id"] == third["id"]
    assert result["result"]["id"] == second["id"]
    assert result["result"]["output_asset_id"] is None
    assert result["result"]["result_expired"]
    display = projected()["display_jobs"]
    assert {j["id"] for j in display} == {second["id"], third["id"]}
    # Even disabled suppliers and expired source assets retain readable metadata.
    with session_factory()() as db:
        db.get(Asset, asset).expires_at = now() - timedelta(days=1)
        for provider in db.scalars(select(Provider)): provider.enabled = False
        db.commit()
    assert projected()["asset"] is None
    assert {j["id"] for j in projected()["display_jobs"]} == {second["id"], third["id"]}
    other = login(client, "bob")
    assert client.get(latest_route, headers=other).status_code == 404


def test_rerun_after_original_reimport_checks_same_bytes_and_receipt(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Asset, now
    auth = login(client)
    old_asset = bind(client, auth, png).json()["id"]
    first = complete(client, auth, old_asset, png, monkeypatch)
    with session_factory()() as db:
        db.get(Asset, old_asset).expires_at = now() - timedelta(days=1);db.commit()
    new_asset = bind(client, auth, png).json()["id"]
    assert old_asset != new_asset
    created = submit_asset(client, auth, new_asset, key='restore-rerun', regenerate=True, rerun_job_id=first['id'])
    assert created.status_code == 202, created.text
    assert created.json()['items'][0]['job']['input_asset_id'] == new_asset
    before = quota_usage(client, auth)
    assert submit_asset(client, auth, new_asset, key='restore-rerun', regenerate=True, rerun_job_id=first['id']).json()['items'][0]['job']['id'] == created.json()['items'][0]['job']['id']
    assert quota_usage(client, auth) == before
    wrong_asset = upload(client, auth, png_variant(png, 23))
    assert submit_asset(client,auth,wrong_asset,key='wrong-page',regenerate=True,rerun_job_id=first['id']).json()['items'][0]['code'] == 'RERUN_SOURCE_MISMATCH'


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
