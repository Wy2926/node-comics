from conftest import quota_usage
from conftest import run_job, claim_job
from datetime import timedelta
from io import BytesIO
from PIL import Image
from sqlalchemy import func, select
from conftest import create, login_plus as login, upload, submit_asset, png_variant


def submit_pages(client, auth, asset_ids, key="batch-1", max_pages=None):
    from app.db import session_factory
    from app.models import Asset
    with session_factory()() as db:
        items = [{"client_item_id": str(index), "asset_id": asset.id, "image_sha256": asset.sha256,
                  "byte_size": asset.byte_size, "content_type": asset.mime}
                 for index, asset in enumerate(db.get(Asset, aid) for aid in asset_ids)]
    return client.post("/v1/translation-submissions", headers={**auth, "Idempotency-Key": key},
        json={"mode": "redraw", "target_language": "zh-Hans", "max_quota_pages": len(items) if max_pages is None else max_pages, "items": items})


def test_auth_private_assets_and_admin_boundaries(client, png):
    alice, bob = login(client), login(client, "bob")
    asset = upload(client, alice, png)
    assert client.get(f"/v1/images/{asset}/content").status_code == 401
    assert client.get(f"/v1/images/{asset}/access", headers=bob).status_code == 404
    assert client.delete(f"/v1/images/{asset}", headers=bob).status_code == 404
    assert client.get("/v1/admin/providers", headers=alice).status_code == 403
    assert client.get(f"/v1/images/{asset}/content", headers=alice).content == png
    assert {mode['id'] for mode in client.get('/v1/capabilities').json()['modes']} == {'classic', 'redraw'}


def test_idempotency_binds_input_and_parameters(client, png):
    from app.db import session_factory
    from app.models import Job, Ledger
    from app.queue_models import JobStage
    auth = login(client)
    asset = upload(client, auth, png)
    first = create(client, auth, asset)
    second = create(client, auth, asset)
    assert first.status_code == second.status_code == 202
    assert first.json()["id"] == second.json()["id"]
    assert create(client, auth, asset, language="en").status_code == 409
    assert quota_usage(client, auth)["reserved"] == 1
    with session_factory()() as db:
        for model in (Job, Ledger, JobStage):
            assert db.scalar(select(func.count()).select_from(model)) == 1


def test_duplicate_worker_settles_once_and_cache_is_free(client, png, monkeypatch):
    from app.adapters.images import TranslationOutput
    from conftest import run_job as process_job
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
    usage = quota_usage(client, auth)
    assert (usage["used"], usage["reserved"], usage["available"]) == (1, 0, 299)
    cached = submit_asset(client, auth, asset, key="cached").json()
    assert cached["quota_pages"] == 0 and cached["items"][0]["reused"]
    assert cached["items"][0]["job"]["output_asset_id"] == job["output_asset_id"]
    rerun = submit_asset(client, auth, asset, key="explicit-rerun", regenerate=True, rerun_job_id=job_id)
    assert rerun.status_code == 202 and not rerun.json()["items"][0]["reused"]
    assert rerun.json()["items"][0]["job"]["version"] > job["version"]
    assert quota_usage(client, auth)["reserved"] == 1


def test_known_failure_releases_and_unknown_never_replays(client, png, monkeypatch):
    import app.workers as workers
    from app.errors import ProcessingError
    from conftest import run_job as process_job
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
    assert quota_usage(client, auth)["reserved"] == 1
    assert submit_asset(client, auth, asset, key="retry", regenerate=True, rerun_job_id=job_id).status_code == 409
    def rejected(*args):
        raise ProcessingError("PROVIDER_REJECTED", "请求被拒绝")
    monkeypatch.setattr(workers, "redraw", rejected)
    next_id = create(client, auth, upload(client, auth, png_variant(png, 3)), key="known-failure").json()["id"]
    process_job(next_id)
    usage = quota_usage(client, auth)
    assert usage["used"] == 0 and usage["reserved"] == 1


def test_cancel_queued_is_idempotent_and_no_upstream_call(client, png, monkeypatch):
    from conftest import run_job as process_job
    import app.workers as workers
    monkeypatch.setattr(workers, "redraw", lambda *args: (_ for _ in ()).throw(AssertionError("must not call")))
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    for _ in range(2):
        result = client.post(f"/v1/jobs/{job_id}/cancel", headers=auth)
        assert result.json()["status"] == "cancelled"
    process_job(job_id)
    usage = quota_usage(client, auth)
    assert usage["used"] == 0 and usage["reserved"] == 0
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
    run_job(job_id)
    job = client.get(f"/v1/jobs/{job_id}", headers=auth).json()
    assert job["status"] == "cancelled" and job["output_asset_id"] is None
    assert quota_usage(client, auth)["used"] == 0
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
    run_job(job_id)
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


def test_cross_user_jobs_are_private_and_completed_images_are_shared(client, png, monkeypatch):
    import app.workers as workers
    from app.adapters.images import TranslationOutput
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(png))
    alice, bob = login(client), login(client, "bob")
    alice_asset = upload(client, alice, png)
    job_id = create(client, alice, alice_asset).json()["id"]
    run_job(job_id)
    assert client.get(f"/v1/jobs/{job_id}", headers=bob).status_code == 404
    assert client.post("/v1/jobs/status", headers=bob, json={"ids": [job_id]}).json() == {"items": []}
    assert create(client, bob, alice_asset).status_code == 404
    bob_job = create(client, bob, upload(client, bob, png)).json()
    assert bob_job["cache_hit"] and bob_job["quota_pages"] == 0
    assert bob_job["id"] != job_id and bob_job["status"] == "succeeded"


def test_batch_budget_atomicity_and_cancel(client, png):
    auth = login(client)
    assets = [upload(client, auth, png_variant(png, index)) for index in range(3)]
    assert submit_pages(client, auth, assets, max_pages=2).status_code == 409
    assert quota_usage(client, auth)["reserved"] == 0
    response = submit_pages(client, auth, assets, max_pages=3)
    assert response.status_code == 202, response.text
    batch = response.json()
    assert [item["job"]["input_asset_id"] for item in batch["items"]] == assets
    repeated = submit_pages(client, auth, assets, max_pages=3).json()
    assert repeated["id"] == batch["id"]
    assert quota_usage(client, auth)["reserved"] == 3
    assert client.post(f"/v1/translation-submissions/{batch['id']}/cancel", headers=auth).json()["status"] == "cancelled"
    assert quota_usage(client, auth)["reserved"] == 0


def test_batch_bad_asset_rolls_back_all_jobs_and_reservations(client, png):
    from app.db import session_factory
    from app.models import Asset, now
    auth = login(client)
    assets = [upload(client, auth, png) for _ in range(2)]
    with session_factory()() as db:
        db.get(Asset, assets[1]).deleted_at = now()
        db.commit()
    response = submit_pages(client, auth, assets, key="bad-batch", max_pages=2)
    assert response.status_code == 410
    assert client.get("/v1/jobs", headers=auth).json()["total"] == 0
    assert quota_usage(client, auth)["reserved"] == 0


def test_unknown_reservation_deadline_and_late_reconciliation_no_debit(client, png, monkeypatch):
    import app.workers as workers
    from app.db import session_factory
    from app.models import Job, now
    from app.dispatcher import recover_once
    from app.errors import ProcessingError
    def timeout(*args):
        raise ProcessingError("UPSTREAM_OUTCOME_UNKNOWN", "待核实", unknown=True)
    monkeypatch.setattr(workers, "redraw", timeout)
    auth, admin = login(client), login(client, "admin")
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    run_job(job_id)
    with session_factory()() as db:
        db.get(Job, job_id).unknown_since = now() - timedelta(hours=2)
        db.commit()
    recover_once()
    recover_once()
    assert quota_usage(client, auth)["reserved"] == 0
    output = upload(client, auth, png)
    response = client.post(f"/v1/admin/jobs/{job_id}/reconcile", headers=admin, json={"resolution": "succeeded", "output_asset_id": output, "note": "已向供应商核实"})
    assert response.status_code == 200
    assert response.json()["status"] == "succeeded" and response.json()["settlement"] == "released"
    assert quota_usage(client, auth)["used"] == 0


def test_worker_lease_loss_after_intent_never_requeues(client, png):
    from app.db import session_factory
    from app.models import Attempt, Job, now
    from app.queue_models import ExecutionLease
    from conftest import claim_job as claim
    from app.dispatcher import recover_lease
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    lease_id = claim(job_id)
    with session_factory()() as db:
        attempt = db.get(Attempt, db.get(Job, job_id).attempt_id)
        attempt.call_started_at = now() - timedelta(hours=1)
        db.get(ExecutionLease, lease_id).expires_at = now() - timedelta(seconds=1)
        db.commit()
    recover_lease(lease_id)
    with session_factory()() as db:
        assert db.get(Job, job_id).status == "outcome_unknown"
    assert claim(job_id) is None


def test_worker_lease_before_intent_is_safe_to_requeue(client, png):
    from app.db import session_factory
    from app.models import Job, now
    from app.queue_models import ExecutionLease, JobStage
    from conftest import claim_job as claim
    from app.dispatcher import recover_lease
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    lease_id = claim(job_id)
    with session_factory()() as db:
        db.get(ExecutionLease, lease_id).expires_at = now() - timedelta(seconds=1)
        db.commit()
    recover_lease(lease_id)
    with session_factory()() as db:
        stage = db.get(JobStage, db.get(ExecutionLease, lease_id).stage_id)
        assert stage.status == "ready"
        stage.available_at = now()
        db.commit()
    assert claim(job_id) != lease_id


def test_invalid_output_and_aspect_ratio_are_not_delivered(client, png, monkeypatch):
    import app.workers as workers
    from app.adapters.images import TranslationOutput
    auth = login(client)
    asset = upload(client, auth, png)
    buffer = BytesIO()
    Image.new("RGB", (800, 100)).save(buffer, "PNG")
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(buffer.getvalue()))
    job_id = create(client, auth, asset).json()["id"]
    run_job(job_id)
    job = client.get(f"/v1/jobs/{job_id}", headers=auth).json()
    assert job["status"] == "failed" and job["error"]["code"] == "INVALID_PROVIDER_OUTPUT"
    assert quota_usage(client, auth)["available"] == 300


def test_insufficient_quota_creates_no_job(client, png):
    auth = login(client)
    from app.db import session_factory
    from app.models import User
    with session_factory()() as db:
        db.scalar(select(User).where(User.subject == "dev:alice")).plus_monthly_pages = 12
        db.commit()
    for i in range(12):
        asset = upload(client, auth, png_variant(png, i))
        assert create(client, auth, asset, key=f"job-{i}").status_code == 202
    asset = upload(client, auth, png_variant(png, 12))
    assert create(client, auth, asset, key="no-credit").status_code == 409
    assert client.get("/v1/jobs", headers=auth).json()["total"] == 12
    assert quota_usage(client, auth)["reserved"] == 12


def test_admin_quota_adjustment_idempotent_and_private_provider_list(client):
    auth, admin = login(client), login(client, "admin")
    user_id = client.get("/v1/me", headers=auth).json()["user"]["id"]
    headers = {**admin, "Idempotency-Key": "grant-10"}
    for _ in range(2):
        assert client.post(f"/v1/admin/users/{user_id}/quota-compensations", headers=headers, json={"kind": "redraw_monthly", "pages": 10, "note": "test"}).json()["entitlements"]["modes"]["redraw"]["quota"]["available"] == 310
    assert client.post(f"/v1/admin/users/{user_id}/quota-compensations", headers=headers, json={"kind": "redraw_monthly", "pages": 11, "note": "test"}).status_code == 409
    providers = client.get("/v1/admin/providers", headers=admin)
    assert "isolated-test-provider-key" not in providers.text
    assert providers.json()["items"][0]["credential_configured"]


def test_upload_signature_limits_and_inputs(client, png):
    auth = login(client)
    asset = upload(client, auth, png)
    assert create(client, auth, asset, language="unsupported").status_code == 422
    assert submit_asset(client, auth, asset, mode="standard").status_code == 422
    assert client.post("/v1/translation-submissions", headers=auth, json={}).status_code == 422
    assert client.post("/v1/images", headers=auth).status_code == 404
