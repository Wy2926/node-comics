from datetime import timedelta
from io import BytesIO
from PIL import Image
from sqlalchemy import func, select
from conftest import create, login, upload, quote


def test_auth_private_assets_and_admin_boundaries(client, png):
    alice, bob = login(client), login(client, "bob")
    asset = upload(client, alice, png)
    assert client.get(f"/v1/images/{asset}/content").status_code == 401
    assert client.get(f"/v1/images/{asset}/access", headers=bob).status_code == 404
    assert client.delete(f"/v1/images/{asset}", headers=bob).status_code == 404
    assert client.get("/v1/admin/providers", headers=alice).status_code == 403
    assert client.get(f"/v1/images/{asset}/content", headers=alice).content == png
    assert client.get("/v1/capabilities").json()["modes"][0]["id"] == "redraw"


def test_idempotency_binds_input_and_parameters(client, png):
    from app.db import session_factory
    from app.models import Job, Ledger, Outbox
    auth = login(client)
    asset = upload(client, auth, png)
    first = create(client, auth, asset)
    second = create(client, auth, asset)
    assert first.status_code == second.status_code == 202
    assert first.json()["id"] == second.json()["id"]
    assert create(client, auth, asset, language="en").status_code == 409
    assert client.get("/v1/me/usage", headers=auth).json()["reserved"] == 8
    with session_factory()() as db:
        for model in (Job, Ledger, Outbox):
            assert db.scalar(select(func.count()).select_from(model)) == 1


def test_duplicate_worker_settles_once_and_cache_is_free(client, png, monkeypatch):
    from app.adapters.images import TranslationOutput
    from app.workers import process_job
    import app.workers as workers
    calls = []
    def fake_adapter(*args):
        calls.append(1)
        return TranslationOutput(png, request_id="req-test", usage={"total_tokens": 45})
    monkeypatch.setattr(workers, "redraw", fake_adapter)
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    process_job(job_id)
    process_job(job_id)
    assert len(calls) == 1
    job = client.get(f"/v1/jobs/{job_id}", headers=auth).json()
    assert job["status"] == "succeeded"
    assert client.get(f"/v1/images/{job['output_asset_id']}/content", headers=auth).content == png
    usage = client.get("/v1/me/usage", headers=auth).json()
    assert (usage["balance"], usage["reserved"], usage["available"]) == (92, 0, 92)
    cached = create(client, auth, asset, key="cached").json()
    assert cached["status"] == "succeeded" and cached["cache_hit"] and cached["cost"] == 0
    assert cached["output_asset_id"] == job["output_asset_id"]
    confirmed_quote = quote(client, auth, asset)
    rerun = client.post(f"/v1/jobs/{job_id}/rerun", headers={**auth, "Idempotency-Key": "explicit-rerun"}, json={"quote_id": confirmed_quote["id"], "max_credits": confirmed_quote["total_cost"]})
    assert rerun.status_code == 202 and not rerun.json()["cache_hit"]
    assert rerun.json()["version"] > job["version"]
    assert client.get("/v1/me/usage", headers=auth).json()["reserved"] == 8


def test_known_failure_releases_and_unknown_never_replays(client, png, monkeypatch):
    import app.workers as workers
    from app.errors import ProcessingError
    from app.workers import process_job
    auth = login(client)
    asset = upload(client, auth, png)
    calls = []
    def unknown(*args):
        calls.append(1)
        raise ProcessingError("UPSTREAM_OUTCOME_UNKNOWN", "待核实", unknown=True)
    monkeypatch.setattr(workers, "redraw", unknown)
    job_id = create(client, auth, asset).json()["id"]
    process_job(job_id)
    process_job(job_id)
    assert calls == [1]
    assert client.get(f"/v1/jobs/{job_id}", headers=auth).json()["status"] == "outcome_unknown"
    assert client.get("/v1/me/usage", headers=auth).json()["reserved"] == 8
    confirmed_quote = quote(client, auth, asset)
    assert client.post(f"/v1/jobs/{job_id}/rerun", headers={**auth, "Idempotency-Key": "retry"}, json={"quote_id": confirmed_quote["id"], "max_credits": confirmed_quote["total_cost"]}).status_code == 409
    def rejected(*args):
        raise ProcessingError("PROVIDER_REJECTED", "请求被拒绝")
    monkeypatch.setattr(workers, "redraw", rejected)
    next_id = create(client, auth, asset, key="known-failure").json()["id"]
    process_job(next_id)
    usage = client.get("/v1/me/usage", headers=auth).json()
    assert usage["balance"] == 100 and usage["reserved"] == 8


def test_cancel_queued_is_idempotent_and_no_upstream_call(client, png, monkeypatch):
    from app.workers import process_job
    import app.workers as workers
    monkeypatch.setattr(workers, "redraw", lambda *args: (_ for _ in ()).throw(AssertionError("must not call")))
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    for _ in range(2):
        result = client.post(f"/v1/jobs/{job_id}/cancel", headers=auth)
        assert result.json()["status"] == "cancelled"
    process_job(job_id)
    usage = client.get("/v1/me/usage", headers=auth).json()
    assert usage["balance"] == 100 and usage["reserved"] == 0
    assert sum(item["kind"] == "release" for item in usage["items"]) == 1


def test_running_cancel_or_delete_discards_output_without_charge(client, png, monkeypatch):
    import app.workers as workers
    from app.adapters.images import TranslationOutput
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    def cancel_during_provider(*args):
        response = client.delete(f"/v1/images/{asset}", headers=auth)
        assert response.status_code == 200
        return TranslationOutput(png)
    monkeypatch.setattr(workers, "redraw", cancel_during_provider)
    workers.process_job(job_id)
    job = client.get(f"/v1/jobs/{job_id}", headers=auth).json()
    assert job["status"] == "cancelled" and job["output_asset_id"] is None
    assert client.get("/v1/me/usage", headers=auth).json()["balance"] == 100
    assert client.get(f"/v1/images/{asset}/content", headers=auth).status_code == 410


def test_deleted_or_expired_output_not_a_cache_hit(client, png, monkeypatch):
    import app.workers as workers
    from app.adapters.images import TranslationOutput
    from app.db import session_factory
    from app.models import Asset, now
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(png))
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    workers.process_job(job_id)
    original = client.get(f"/v1/jobs/{job_id}", headers=auth).json()
    output_id = original["output_asset_id"]
    with session_factory()() as db:
        db.get(Asset, output_id).expires_at = now() - timedelta(seconds=1)
        db.commit()
    assert client.get(f"/v1/images/{output_id}/access", headers=auth).status_code == 410
    history = client.get(f"/v1/jobs/{job_id}", headers=auth).json()
    assert history["result_expired"] and history["output_asset_id"] is None
    new_job = create(client, auth, asset, key="expired-cache").json()
    assert not new_job["cache_hit"] and new_job["status"] == "queued"


def test_cross_user_jobs_and_cache_are_isolated(client, png, monkeypatch):
    import app.workers as workers
    from app.adapters.images import TranslationOutput
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(png))
    alice, bob = login(client), login(client, "bob")
    alice_asset = upload(client, alice, png)
    job_id = create(client, alice, alice_asset).json()["id"]
    workers.process_job(job_id)
    assert client.get(f"/v1/jobs/{job_id}", headers=bob).status_code == 404
    assert client.post("/v1/jobs/status", headers=bob, json={"ids": [job_id]}).json() == {"items": []}
    assert create(client, bob, alice_asset).status_code == 404
    bob_job = create(client, bob, upload(client, bob, png)).json()
    assert not bob_job["cache_hit"] and bob_job["cost"] == 8


def test_batch_budget_atomicity_and_cancel(client, png):
    auth = login(client)
    assets = [upload(client, auth, png) for _ in range(3)]
    quote = client.post("/v1/quotes", headers=auth, json={"asset_ids": assets, "mode": "redraw", "target_language": "zh-Hans"}).json()
    headers = {**auth, "Idempotency-Key": "batch-1"}
    assert quote["total_cost"] == 24
    assert client.post("/v1/translation-batches", headers=headers, json={"quote_id": quote["id"], "max_credits": 23}).status_code == 409
    assert client.get("/v1/me/usage", headers=auth).json()["reserved"] == 0
    response = client.post("/v1/translation-batches", headers=headers, json={"quote_id": quote["id"], "max_credits": 24})
    assert response.status_code == 202, response.text
    batch = response.json()
    assert [job["input_asset_id"] for job in batch["jobs"]] == assets
    repeated = client.post("/v1/translation-batches", headers=headers, json={"quote_id": quote["id"], "max_credits": 24}).json()
    assert repeated["id"] == batch["id"]
    assert client.get("/v1/me/usage", headers=auth).json()["reserved"] == 24
    assert client.post(f"/v1/translation-batches/{batch['id']}/cancel", headers=auth).json()["status"] == "cancelled"
    assert client.get("/v1/me/usage", headers=auth).json()["reserved"] == 0


def test_batch_bad_asset_rolls_back_all_jobs_and_reservations(client, png):
    from app.db import session_factory
    from app.models import Asset, now
    auth = login(client)
    assets = [upload(client, auth, png) for _ in range(2)]
    quote = client.post("/v1/quotes", headers=auth, json={"asset_ids": assets, "mode": "redraw", "target_language": "zh-Hans"}).json()
    with session_factory()() as db:
        db.get(Asset, assets[1]).deleted_at = now()
        db.commit()
    response = client.post("/v1/translation-batches", headers={**auth, "Idempotency-Key": "bad-batch"}, json={"quote_id": quote["id"], "max_credits": 16})
    assert response.status_code == 410
    assert client.get("/v1/jobs", headers=auth).json()["total"] == 0
    assert client.get("/v1/me/usage", headers=auth).json()["reserved"] == 0


def test_unknown_reservation_deadline_and_late_reconciliation_no_debit(client, png, monkeypatch):
    import app.workers as workers
    from app.db import session_factory
    from app.models import Job, now
    from app.dispatcher import recover
    from app.errors import ProcessingError
    def timeout(*args):
        raise ProcessingError("UPSTREAM_OUTCOME_UNKNOWN", "待核实", unknown=True)
    monkeypatch.setattr(workers, "redraw", timeout)
    auth, admin = login(client), login(client, "admin")
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    workers.process_job(job_id)
    with session_factory()() as db:
        db.get(Job, job_id).unknown_since = now() - timedelta(hours=2)
        db.commit()
        recover(db)
        db.commit()
        recover(db)
        db.commit()
    assert client.get("/v1/me/usage", headers=auth).json()["reserved"] == 0
    output = upload(client, auth, png)
    response = client.post(f"/v1/admin/jobs/{job_id}/reconcile", headers=admin, json={"resolution": "succeeded", "output_asset_id": output, "note": "已向供应商核实"})
    assert response.status_code == 200
    assert response.json()["status"] == "succeeded" and response.json()["settlement"] == "released"
    assert client.get("/v1/me/usage", headers=auth).json()["balance"] == 100


def test_worker_lease_loss_after_intent_never_requeues(client, png):
    from app.db import session_factory
    from app.models import Attempt, Job, now
    from app.workers import claim
    from app.dispatcher import recover
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    attempt_id = claim(job_id)
    with session_factory()() as db:
        attempt = db.get(Attempt, attempt_id)
        attempt.call_started_at = now() - timedelta(hours=1)
        attempt.lease_expires_at = now() - timedelta(seconds=1)
        db.commit()
        recover(db)
        db.commit()
        assert db.get(Job, job_id).status == "outcome_unknown"
    assert claim(job_id) is None


def test_worker_lease_before_intent_is_safe_to_requeue(client, png):
    from app.db import session_factory
    from app.models import Attempt, Job, now
    from app.workers import claim
    from app.dispatcher import recover
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    attempt_id = claim(job_id)
    with session_factory()() as db:
        db.get(Attempt, attempt_id).lease_expires_at = now() - timedelta(seconds=1)
        db.commit()
        recover(db)
        db.commit()
        assert db.get(Job, job_id).status == "queued"
    assert claim(job_id) != attempt_id


def test_invalid_output_and_aspect_ratio_are_not_delivered(client, png, monkeypatch):
    import app.workers as workers
    from app.adapters.images import TranslationOutput
    auth = login(client)
    asset = upload(client, auth, png)
    buffer = BytesIO()
    Image.new("RGB", (800, 100)).save(buffer, "PNG")
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(buffer.getvalue()))
    job_id = create(client, auth, asset).json()["id"]
    workers.process_job(job_id)
    job = client.get(f"/v1/jobs/{job_id}", headers=auth).json()
    assert job["status"] == "failed" and job["error"]["code"] == "INVALID_PROVIDER_OUTPUT"
    assert client.get("/v1/me/usage", headers=auth).json()["available"] == 100


def test_insufficient_quota_creates_no_job(client, png):
    auth = login(client)
    asset = upload(client, auth, png)
    for i in range(12):
        assert create(client, auth, asset, key=f"job-{i}").status_code == 202
    assert create(client, auth, asset, key="no-credit").status_code == 409
    assert client.get("/v1/jobs", headers=auth).json()["total"] == 12
    assert client.get("/v1/me/usage", headers=auth).json()["reserved"] == 96


def test_admin_quota_adjustment_idempotent_and_private_provider_list(client):
    auth, admin = login(client), login(client, "admin")
    user_id = client.get("/v1/me", headers=auth).json()["user"]["id"]
    headers = {**admin, "Idempotency-Key": "grant-10"}
    for _ in range(2):
        assert client.post(f"/v1/admin/users/{user_id}/quota", headers=headers, json={"amount": 10}).json()["balance"] == 110
    assert client.post(f"/v1/admin/users/{user_id}/quota", headers=headers, json={"amount": 11}).status_code == 409
    providers = client.get("/v1/admin/providers", headers=admin)
    assert "isolated-test-provider-key" not in providers.text
    assert providers.json()["items"][0]["credential_configured"]


def test_upload_signature_limits_and_inputs(client, png):
    auth = login(client)
    assert client.post("/v1/images", headers=auth, files={"image": ("fake.png", b"not a PNG", "image/png")}).status_code == 422
    asset = upload(client, auth, png)
    assert create(client, auth, asset, language="unsupported").status_code == 422
    assert client.post("/v1/translations/redraw", headers=auth, data={"asset_id": asset, "target_language": "zh-Hans"}).status_code == 422
    assert client.post("/v1/translations/standard", headers={**auth, "Idempotency-Key": "wrong-mode"}, data={"asset_id": asset, "target_language": "zh-Hans"}).status_code == 422
