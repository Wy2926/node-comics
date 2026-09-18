"""Public durable submissions through bounded upload and scheduled validation."""
from datetime import timedelta
import hashlib
import pytest
from sqlalchemy import func, select
from conftest import login, login_plus
from storage_fakes import MemoryS3


@pytest.fixture
def cluster(client, monkeypatch):
    from app.config import settings
    from app.storage import S3Store
    import app.storage as storage
    cfg = settings()
    cfg.classic_enabled = True
    cfg.result_storage_backend = "r2"
    cfg.r2_endpoint_url = "https://" + "a" * 32 + ".r2.cloudflarestorage.com"
    sdk = MemoryS3()
    store = S3Store(sdk, "test-bucket", "isolated/")
    monkeypatch.setattr(storage, "r2_store", lambda *args: store)
    return client, sdk


def descriptor(data, item_id="page-0", **extra):
    return {"client_item_id": item_id, "image_sha256": hashlib.sha256(data).hexdigest(),
            "byte_size": len(data), "content_type": "image/png", **extra}


def manifest(count, prefix="page"):
    # Admission reserves descriptors before any image is sent. Distinct opaque
    # hashes suffice for this capacity test; decoder tests upload actual PNGs.
    return [descriptor(f"{prefix}:{index}".encode(), f"{prefix}-{index}") for index in range(count)]


def submit(client, auth, items, *, key="submission-1", mode="classic", max_pages=None, **extra):
    return client.post("/v1/translation-submissions", headers={**auth, "Idempotency-Key": key},
        json={"mode": mode, "target_language": "zh-Hans", "max_quota_pages": len(items) if max_pages is None else max_pages,
              "items": items, **extra})


def validate_next():
    from app.db import session_factory
    from app.queue_models import ComputeNode
    from app.scheduler import claim_stage
    from app.workers import run_control_stage
    with session_factory()() as db:
        if not db.get(ComputeNode, "test-validator"):
            db.add(ComputeNode(id="test-validator", name="test-validator", capabilities=["validate_upload"],
                capacity=2, resource_id="test-validator", engine_version="control", device="cpu"))
            db.commit()
        lease = claim_stage(db, "test-validator", ["validate_upload"])
        db.commit()
        assert lease is not None
    run_control_stage(lease.id)
    return lease.id


def queue_for(client, auth, mode="classic"):
    response = client.get("/v1/me/queues", headers=auth)
    assert response.status_code == 200, response.text
    return next(q for q in response.json()["items"] if q["mode"] == mode)


def grant_redraw(client, auth, pages):
    from app.models import now
    user_id = client.get("/v1/me", headers=auth).json()["user"]["id"]
    response = client.post(f"/v1/admin/users/{user_id}/quota-grants",
        headers={**login(client, "admin"), "Idempotency-Key": f"grant-{user_id}"},
        json={"mode": "redraw", "pages": pages, "expires_at": (now() + timedelta(days=2)).isoformat() + "Z", "note": "isolated grant"})
    assert response.status_code == 201, response.text


def upload_and_enqueue(client, auth, item, data):
    receipt = item["upload"]
    response = client.put(receipt["url"], headers={**auth, **receipt["headers"]}, content=data)
    assert response.status_code == 200, response.text
    response = client.post(f"/v1/uploads/{receipt['id']}/complete", headers=auth)
    assert response.status_code == 200, response.text
    return response.json()


def test_http_submission_upload_validation_recovers_without_client(cluster, png):
    from app.db import session_factory
    from app.models import Asset, Job
    from app.queue_models import ExecutionLease, JobStage
    client, sdk = cluster
    auth = login(client)
    response = submit(client, auth, [descriptor(png)])
    assert response.status_code == 202, response.text
    first = response.json()["items"][0]
    assert first["job"]["status"] == "awaiting_upload" and first["job"]["input_asset_id"] is None
    accepted = upload_and_enqueue(client, auth, first, png)
    assert accepted["status"] == "validating_upload"
    assert not any(method == "GET" for method, _ in sdk.calls)
    lease_id = validate_next()
    # No further reader request is needed for the server to make the page ready.
    result = client.get(f"/v1/jobs/{accepted['id']}", headers=auth)
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "queued", result.text
    with session_factory()() as db:
        job = db.get(Job, accepted["id"])
        source = db.get(Asset, job.input_asset_id)
        assert source.storage_backend == "r2" and source.active_references == 1
        assert db.get(ExecutionLease, lease_id).completed_at is not None
        assert {s.name: s.status for s in db.scalars(select(JobStage).where(JobStage.job_id == job.id))} == {
            "validate_upload": "succeeded", "analyze": "ready", "text": "waiting", "inpaint": "waiting", "render": "waiting"}
    repeated = client.post(f"/v1/uploads/{first['upload']['id']}/complete", headers=auth)
    assert repeated.status_code == 200 and repeated.json()["id"] == accepted["id"]
    assert queue_for(client, auth)["in_flight"] == 1


@pytest.mark.parametrize("plus,limit", [(False, 3), (True, 10)])
def test_account_capacity_is_shared_across_modes_and_devices(cluster, plus, limit):
    from app.db import session_factory
    from app.models import Job, Ledger
    from app.queue_models import Submission
    client, _ = cluster
    from app.config import settings
    # Older deployments may still provide 10/500; they cannot expand current product limits.
    settings().free_queue_capacity = 10
    settings().plus_queue_capacity = 500
    auth = (login_plus if plus else login)(client)
    if not plus:
        grant_redraw(client, auth, 20)
    rejected = submit(client, auth, manifest(limit + 1), key="oversized")
    assert rejected.status_code == 409 and rejected.json()["error"]["code"] == "QUEUE_FULL"
    first = submit(client, auth, manifest(limit - 1), key="first")
    assert first.status_code == 202, first.text
    second = submit(client, auth, manifest(1, "redraw"), mode="redraw", key="second")
    assert second.status_code == 202, second.text
    for mode in ("classic", "redraw"):
        assert queue_for(client, auth, mode)["available_slots"] == 0
        rejected = submit(client, auth, manifest(1, "extra"), key="other-device-" + mode, mode=mode)
        assert rejected.status_code == 409 and rejected.json()["error"]["code"] == "QUEUE_FULL"
    replay = submit(client, auth, manifest(limit - 1), key="first")
    assert replay.json()["id"] == first.json()["id"]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == limit
        assert db.scalar(select(func.count()).select_from(Submission)) == 2
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == "reserve")) == (1 if plus else limit)
    cancelled = client.post(f"/v1/translation-submissions/{second.json()['id']}/cancel", headers=auth)
    assert cancelled.status_code == 200
    assert queue_for(client, auth)["available_slots"] == 1
    assert submit(client, auth, manifest(1, "replacement"), key="replacement").status_code == 202


def test_replay_and_duplicate_content_only_reserve_once(cluster, png):
    from app.db import session_factory
    from app.models import Job, Ledger
    client, _ = cluster
    auth = login(client)
    items = [descriptor(png, "first"), descriptor(png, "same-content")]
    first = submit(client, auth, items)
    assert first.status_code == 202, first.text
    again = submit(client, auth, items)
    assert again.status_code == 202 and again.json()["id"] == first.json()["id"]
    assert first.json()["quota_pages"] == 1
    assert [item["reused"] for item in first.json()["items"]] == [False, True]
    other = submit(client, auth, [descriptor(png)], key="another-batch", max_pages=0)
    assert other.status_code == 202 and other.json()["quota_pages"] == 0
    assert other.json()["items"][0]["job"]["id"] == first.json()["items"][0]["job"]["id"]
    changed = submit(client, auth, [descriptor(b"changed")])
    assert changed.status_code == 409 and changed.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Ledger)) == 1


def test_quota_confirmation_bound_rolls_back_every_page(cluster):
    client, _ = cluster
    auth = login(client)
    response = submit(client, auth, manifest(2), max_pages=1)
    assert response.status_code == 409 and response.json()["error"]["code"] == "QUOTA_BOUND_EXCEEDED"
    assert queue_for(client, auth)["in_flight"] == 0
    assert client.get("/v1/translation-submissions", headers=auth).json()["total"] == 0
    rights = client.get("/v1/me/entitlements", headers=auth).json()
    assert rights["modes"]["classic"]["quota"]["reserved"] == 0


@pytest.mark.parametrize("phase", ["awaiting_upload", "validating_upload", "queued"])
def test_cancel_at_each_preexecution_phase_releases_capacity_and_quota(cluster, png, phase):
    from app.db import session_factory
    from app.models import Asset, Job
    client, _ = cluster
    auth = login(client)
    response = submit(client, auth, [descriptor(png)])
    item = response.json()["items"][0]
    if phase in {"validating_upload", "queued"}:
        upload_and_enqueue(client, auth, item, png)
    if phase == "queued":
        validate_next()
    cancel_url = f"/v1/translation-submissions/{response.json()['id']}/cancel"
    cancelled = client.post(cancel_url, headers=auth)
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["items"][0]["job"]["status"] == "cancelled"
    assert client.post(cancel_url, headers=auth).status_code == 200
    assert queue_for(client, auth)["in_flight"] == 0
    assert client.get("/v1/me/entitlements", headers=auth).json()["modes"]["classic"]["quota"]["reserved"] == 0
    with session_factory()() as db:
        job = db.get(Job, item["job"]["id"])
        assert not job.input_pinned
        if job.input_asset_id:
            assert db.get(Asset, job.input_asset_id).active_references == 0


def test_upload_submissions_and_cancellation_are_owner_scoped(cluster, png):
    client, sdk = cluster
    alice, bob = login(client), login(client, "bob")
    response = submit(client, alice, [descriptor(png)])
    receipt = response.json()["items"][0]["upload"]
    before = list(sdk.calls)
    attempts = [
        client.put(receipt["url"], headers=bob, content=png),
        client.post(f"/v1/uploads/{receipt['id']}/complete", headers=bob),
        client.get(f"/v1/translation-submissions/{response.json()['id']}", headers=bob),
        client.post(f"/v1/translation-submissions/{response.json()['id']}/cancel", headers=bob)]
    assert all(result.status_code == 404 for result in attempts)
    assert sdk.calls == before
    assert client.put(receipt["url"], content=png).status_code == 401


def test_expired_upload_cannot_escape_expiry_by_completing_late(cluster, png):
    from app.db import session_factory
    from app.models import now
    from app.upload_models import UploadReservation
    client, _ = cluster
    auth = login(client)
    item = submit(client, auth, [descriptor(png)]).json()["items"][0]
    receipt = item["upload"]
    assert client.put(receipt["url"], headers=auth, content=png).status_code == 200
    with session_factory()() as db:
        db.get(UploadReservation, receipt["id"]).expires_at = now() - timedelta(seconds=1)
        db.commit()
    late = client.post(f"/v1/uploads/{receipt['id']}/complete", headers=auth)
    assert late.status_code == 410 and late.json()["error"]["code"] == "UPLOAD_EXPIRED"
    assert queue_for(client, auth)["in_flight"] == 0
    assert client.get("/v1/me/entitlements", headers=auth).json()["modes"]["classic"]["quota"]["reserved"] == 0


@pytest.mark.parametrize("failure", ["actual_size", "hash", "decode"])
def test_invalid_upload_fails_only_its_page_and_releases_reservation(cluster, png, failure):
    client, _ = cluster
    auth = login(client)
    data = b"invalid-image" if failure == "decode" else png
    item = submit(client, auth, [descriptor(data)]).json()["items"][0]
    sent = data + b"extra" if failure == "actual_size" else (b"x" * len(data) if failure == "hash" else data)
    response = client.put(item["upload"]["url"], headers=auth, content=sent)
    if failure == "decode":
        assert response.status_code == 200
        assert client.post(f"/v1/uploads/{item['upload']['id']}/complete", headers=auth).status_code == 200
        validate_next()
    else:
        assert response.status_code in {413, 422}
    job = client.get(f"/v1/jobs/{item['job']['id']}", headers=auth).json()
    assert job["status"] == "failed", job
    assert queue_for(client, auth)["in_flight"] == 0


def test_all_reused_file_page_identities_bind_after_validation(cluster, png):
    from app.db import session_factory
    from app.file_pages import FilePage
    client, _ = cluster
    auth = login(client)
    first = submit(client, auth, [descriptor(png, file_hash="a" * 64, page_index=1)]).json()
    second = submit(client, auth, [descriptor(png, file_hash="b" * 64, page_index=7)], key="other-file").json()
    assert first["items"][0]["job"]["id"] == second["items"][0]["job"]["id"]
    upload_and_enqueue(client, auth, first["items"][0], png)
    validate_next()
    user_id = client.get("/v1/me", headers=auth).json()["user"]["id"]
    with session_factory()() as db:
        one, two = db.get(FilePage, (user_id, "a" * 64, 1)), db.get(FilePage, (user_id, "b" * 64, 7))
        assert one and two and one.asset_id == two.asset_id
    for file_hash, page_index in [("a" * 64, 1), ("b" * 64, 7)]:
        result = client.post("/v1/file-pages/match", headers=auth, json={"mode": "classic", "target_language": "zh-Hans",
            "pages": [{"file_hash": file_hash, "page_index": page_index}]})
        assert result.status_code == 200 and result.json()["items"][0]["asset"] is not None, result.text
    conflict = submit(client, auth, [descriptor(b"different", file_hash="a" * 64, page_index=1)], key="conflicting-file")
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "FILE_PAGE_CONFLICT"


def test_reading_upload_reservation_blocks_other_sessions_and_survives_reuse(cluster):
    client, _ = cluster
    auth = login(client)
    first = submit(client, auth, manifest(3)).json()
    priority = client.post("/v1/me/queues/classic/priority", headers=auth, json={"session_id": "reader-A", "sequence": 1,
        "expected_version": 0, "realtime_job_ids": [], "reserve_next_upload": True})
    assert priority.status_code == 200, priority.text
    assert client.post(f"/v1/jobs/{first['items'][-1]['job']['id']}/cancel", headers=auth).status_code == 200
    queue = queue_for(client, auth)
    assert queue["upload_reserved"] and queue["available_slots"] == 0
    blocked = submit(client, auth, manifest(1, "reader-new"), key="wrong-session", reading_session_id="reader-B")
    assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "READING_UPLOAD_RESERVED"
    reused = submit(client, auth, manifest(1), key="reused-reader", reading_session_id="reader-A", max_pages=0)
    assert reused.status_code == 202
    assert queue_for(client, auth)["upload_reserved"]
    accepted = submit(client, auth, manifest(1, "reader-new"), key="reader-page", reading_session_id="reader-A")
    assert accepted.status_code == 202, accepted.text
    assert not queue_for(client, auth)["upload_reserved"]
    assert queue_for(client, auth)["in_flight"] == 3


def test_idempotent_receipt_survives_provider_configuration_change(cluster, png):
    from app.config import settings
    client, _ = cluster
    auth = login(client)
    request = [descriptor(png)]
    first = submit(client, auth, request)
    assert first.status_code == 202
    settings().classic_enabled = False
    settings().classic_engine_version = "changed-after-admission"
    repeat = submit(client, auth, request)
    assert repeat.status_code == 202 and repeat.json() == first.json()
    assert queue_for(client, auth)["in_flight"] == 1


def test_simultaneous_devices_cannot_partially_admit_a_batch_over_capacity(cluster):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    client, _ = cluster
    auth = login(client)
    barrier = Barrier(3)
    def admission(index):
        barrier.wait()
        return submit(client, auth, manifest(2, f"device-{index}"), key=f"concurrent-{index}")
    with ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(admission, range(3)))
    assert sorted(result.status_code for result in results) == [202, 409, 409]
    for result in results:
        if result.status_code == 409:
            assert result.json()["error"]["available_slots"] == 1
    assert queue_for(client, auth)["in_flight"] == 2
    assert client.get("/v1/translation-submissions", headers=auth).json()["total"] == 1
    assert client.get("/v1/me/entitlements", headers=auth).json()["modes"]["classic"]["quota"]["reserved"] == 2


def test_concurrent_idempotent_replay_creates_one_receipt_and_reservation(cluster, png):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    client, _ = cluster
    auth = login(client)
    barrier = Barrier(4)
    def admission(_):
        barrier.wait()
        return submit(client, auth, [descriptor(png)])
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(admission, range(4)))
    assert all(result.status_code == 202 for result in results)
    assert len({result.json()["id"] for result in results}) == 1
    assert queue_for(client, auth)["in_flight"] == 1
    assert client.get("/v1/me/entitlements", headers=auth).json()["modes"]["classic"]["quota"]["reserved"] == 1


def test_pending_file_page_identity_cannot_be_bound_to_conflicting_bytes(cluster, png):
    client, _ = cluster
    auth = login(client)
    items = [descriptor(png, file_hash="c" * 64, page_index=3)]
    accepted = submit(client, auth, items)
    assert accepted.status_code == 202
    conflicting = submit(client, auth, [descriptor(b"other", file_hash="c" * 64, page_index=3)], key="conflict")
    assert conflicting.status_code == 409 and conflicting.json()["error"]["code"] == "FILE_PAGE_CONFLICT"
    assert queue_for(client, auth)["in_flight"] == 1
    duplicate_conflict = submit(client, auth, [descriptor(png, "a", file_hash="d" * 64, page_index=1),
        descriptor(b"other", "b", file_hash="d" * 64, page_index=1)], key="same-request-conflict")
    assert duplicate_conflict.status_code == 409
    assert queue_for(client, auth)["in_flight"] == 1
