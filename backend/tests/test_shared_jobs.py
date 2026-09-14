"""Cross-device submissions share active work while preserving request identity."""
from datetime import timedelta

import pytest
from sqlalchemy import func, select
from conftest import create, login, png_variant, run_job, upload
from app.batch_items import BatchItem, JobRequest
from app.config import settings
from app.db import session_factory
from app.models import Asset, Batch, Job, Ledger, Outbox, User, now


def quoted(client, auth, assets):
    response = client.post("/v1/quotes", headers=auth, json={"asset_ids": assets, "mode": "redraw", "target_language": "zh-Hans"})
    assert response.status_code == 201, response.text
    return response.json()


def submit_batch(client, auth, quote, key):
    return client.post("/v1/translation-batches", headers={**auth, "Idempotency-Key": key},
                       json={"quote_id": quote["id"], "max_credits": quote["total_cost"]})


@pytest.mark.parametrize("status", ["queued", "running", "outcome_unknown"])
def test_active_work_reused_before_quota_and_active_limits(client, png, status):
    auth = login(client)
    first_asset, alias = upload(client, auth, png), upload(client, auth, png)
    first = create(client, auth, first_asset, key="device-one").json()
    settings().max_active_jobs = 1
    with session_factory()() as db:
        job = db.get(Job, first["id"])
        job.status = status
        user = db.get(User, job.owner_id)
        user.balance = user.reserved  # No spare quota remains.
        db.commit()
    response = create(client, auth, alias, key="device-two")
    assert response.status_code == 202, response.text
    assert response.json()["id"] == first["id"]
    assert response.json()["input_asset_id"] == first_asset
    assert response.json()["requested_asset_id"] == alias
    assert response.json()["status"] == status
    price = quoted(client, auth, [alias])
    batch = submit_batch(client, auth, price, "device-batch")
    assert batch.status_code == 202, batch.text
    assert batch.json()["total_cost"] == 0
    assert batch.json()["jobs"][0]["id"] == first["id"]
    with session_factory()() as db:
        for model in (Job, Ledger, Outbox):
            assert db.scalar(select(func.count()).select_from(model)) == 1
        assert db.scalar(select(func.count()).select_from(JobRequest)) == 3


@pytest.mark.parametrize("terminal", ["succeeded", "failed", "cancelled"])
def test_reused_request_key_survives_terminal_status_and_config_changes(client, png, terminal, monkeypatch):
    auth = login(client)
    asset = upload(client, auth, png)
    original = create(client, auth, asset, key="original").json()
    assert create(client, auth, asset, key="alias").json()["id"] == original["id"]
    if terminal == "succeeded":
        from app.adapters.images import TranslationOutput
        import app.workers as workers
        monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(png))
        run_job(original["id"])
    else:
        from app.jobs import settle
        with session_factory()() as db:
            job = db.get(Job, original["id"])
            job.status = terminal
            settle(db, job, success=False)
            db.commit()
    settings().redraw_cost = 80
    repeated = create(client, auth, asset, key="alias")
    assert repeated.status_code == 202 and repeated.json()["id"] == original["id"]
    assert repeated.json()["status"] == terminal
    assert create(client, auth, asset, key="alias", language="en").status_code == 409
    assert create(client, auth, upload(client, auth, png_variant(png, 9)), key="alias").status_code == 409
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(JobRequest)) == 2


def test_batch_aliases_keep_requested_page_order_and_share_cancellation(client, png):
    alice, bob = login(client), login(client, "bob")
    assets = [upload(client, alice, png) for _ in range(3)]
    first = submit_batch(client, alice, quoted(client, alice, assets), "batch-first").json()
    second_quote = quoted(client, alice, list(reversed(assets)))
    second = submit_batch(client, alice, second_quote, "batch-second").json()
    assert (first["total_cost"], second["total_cost"]) == (8, 0)
    assert len(first["jobs"]) == len(second["jobs"]) == 3
    assert len({job["id"] for job in first["jobs"] + second["jobs"]}) == 1
    for batch, expected in [(first, assets), (second, list(reversed(assets)))]:
        assert [job["requested_asset_id"] for job in batch["jobs"]] == expected
        assert [job["ordinal"] for job in batch["jobs"]] == [0, 1, 2]
        assert all(job["batch_id"] == batch["id"] and job["input_asset_id"] == assets[0] for job in batch["jobs"])
    page = client.get(f"/v1/translation-batches/{second['id']}?offset=1&limit=1", headers=alice).json()
    assert page["total"] == 3 and page["next_offset"] == 2
    assert page["items"][0]["requested_asset_id"] == assets[1] and page["items"][0]["ordinal"] == 1
    assert client.get(f"/v1/translation-batches/{second['id']}", headers=bob).status_code == 404
    assert client.post(f"/v1/translation-batches/{second['id']}/cancel", headers=bob).status_code == 404
    for _ in range(2):
        assert client.post(f"/v1/translation-batches/{second['id']}/cancel", headers=alice).json()["status"] == "cancelled"
    assert client.get(f"/v1/translation-batches/{first['id']}", headers=alice).json()["status"] == "cancelled"
    assert submit_batch(client, alice, second_quote, "batch-second").json()["id"] == second["id"]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BatchItem)) == 6
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert sorted(db.scalars(select(Ledger.kind))) == ["release", "reserve"]


def test_mixed_batch_only_reserves_new_work_and_rolls_back_insufficient_funds(client, png):
    auth = login(client)
    assets = [upload(client, auth, png_variant(png, index)) for index in range(3)]
    existing = create(client, auth, assets[0]).json()
    with session_factory()() as db:
        owner = db.get(Job, existing["id"]).owner_id
        db.get(User, owner).balance = 16  # Existing 8 plus only one additional page.
        db.commit()
    price = quoted(client, auth, assets)
    failed = submit_batch(client, auth, price, "insufficient")
    assert failed.status_code == 409 and failed.json()["error"]["code"] == "INSUFFICIENT_QUOTA"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Batch)) == 0
        assert db.scalar(select(func.count()).select_from(BatchItem)) == 0
        for model in (Job, JobRequest, Ledger, Outbox):
            assert db.scalar(select(func.count()).select_from(model)) == 1
        assert db.get(User, owner).reserved == 8
    accepted = submit_batch(client, auth, quoted(client, auth, assets[:2]), "mixed")
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["total_cost"] == 8
    assert accepted.json()["jobs"][0]["id"] == existing["id"]
    assert client.get("/v1/me/usage", headers=auth).json()["reserved"] == 16


def test_success_cache_is_free_even_with_full_active_limit_and_zero_spare_quota(client, png, monkeypatch):
    from app.adapters.images import TranslationOutput
    import app.workers as workers
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(png))
    auth = login(client)
    asset = upload(client, auth, png)
    first = create(client, auth, asset).json()
    run_job(first["id"])
    other = create(client, auth, upload(client, auth, png_variant(png, 1)), key="other").json()
    settings().max_active_jobs = 1
    with session_factory()() as db:
        user = db.get(User, db.get(Job, other["id"]).owner_id)
        user.balance = user.reserved
        db.commit()
    cached = submit_batch(client, auth, quoted(client, auth, [asset]), "free-cache")
    assert cached.status_code == 202, cached.text
    assert cached.json()["total_cost"] == 0 and cached.json()["jobs"][0]["cache_hit"]
    assert cached.json()["jobs"][0]["output_asset_id"] == client.get(f"/v1/jobs/{first['id']}", headers=auth).json()["output_asset_id"]


def test_no_text_completed_between_device_quote_and_confirm_is_free_without_reexecuting(client, png, monkeypatch):
    from app.adapters.images import TranslationOutput
    from app.models import Attempt
    import app.workers as workers
    settings().classic_enabled = True
    calls = []
    def no_text(*args):
        calls.append(1)
        return TranslationOutput(None, no_text=True)
    monkeypatch.setattr(workers, "run_classic", no_text)
    auth = login(client)
    source, alias = upload(client, auth, png), upload(client, auth, png)
    first = client.post("/v1/translations/classic", headers={**auth, "Idempotency-Key": "first-device"},
                         data={"asset_id": source, "target_language": "zh-Hans"})
    assert first.status_code == 202, first.text
    price = client.post("/v1/quotes", headers=auth,
                         json={"asset_ids": [alias], "mode": "classic", "target_language": "zh-Hans"}).json()
    run_job(first.json()["id"])
    second = submit_batch(client, auth, price, "second-device")
    assert second.status_code == 202, second.text
    cached = second.json()["jobs"][0]
    assert second.json()["total_cost"] == cached["cost"] == 0
    assert cached["status"] == "no_text" and cached["cache_hit"] and cached["output_asset_id"] is None
    assert cached["requested_asset_id"] == alias and cached["id"] != first.json()["id"]
    run_job(cached["id"])
    assert calls == [1]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
        assert db.scalar(select(func.count()).select_from(Attempt)) == 1
    assert client.get("/v1/me/usage", headers=auth).json()["reserved"] == 0


@pytest.mark.parametrize("invalid", ["cancel", "discard", "expired", "deleted", "missing"])
def test_cancelled_or_unavailable_active_source_is_not_reused(client, png, invalid):
    from app.assets import object_path
    auth = login(client)
    source, alias = upload(client, auth, png), upload(client, auth, png)
    first = create(client, auth, source).json()
    with session_factory()() as db:
        job, asset = db.get(Job, first["id"]), db.get(Asset, source)
        if invalid == "cancel":
            job.cancel_requested = True
        elif invalid == "discard":
            job.discard_output = True
        elif invalid == "expired":
            asset.expires_at = now() - timedelta(seconds=1)
        elif invalid == "deleted":
            asset.deleted_at = now()
        else:
            object_path(asset.storage_key).unlink()
        db.commit()
    second = create(client, auth, alias, key="different-device")
    assert second.status_code == 202 and second.json()["id"] != first["id"]


@pytest.mark.parametrize("mode", ["redraw", "classic"])
def test_changed_config_cannot_automatically_replay_unknown_redraw_but_does_not_block_classic(client, png, mode):
    from app.models import Provider
    settings().classic_enabled = True
    auth = login(client)
    source, alias = upload(client, auth, png), upload(client, auth, png)
    first = client.post(f"/v1/translations/{mode}", headers={**auth, "Idempotency-Key": "first-config"},
                         data={"asset_id": source, "target_language": "zh-Hans"}).json()
    with session_factory()() as db:
        job = db.get(Job, first["id"])
        job.status, job.unknown_since = "outcome_unknown", now()
        provider = db.get(Provider, "default")
        provider.config = {**provider.config, "parameters": {"quality": "high"}}
        db.commit()
    settings().redraw_cost = 80
    settings().classic_cost = 3
    second = client.post(f"/v1/translations/{mode}", headers={**auth, "Idempotency-Key": "changed-config"},
                          data={"asset_id": alias, "target_language": "zh-Hans"})
    assert second.status_code == 202, second.text
    assert (second.json()["id"] == first["id"]) is (mode == "redraw")
    assert second.json()["requested_asset_id"] == alias
    with session_factory()() as db:
        expected = 1 if mode == "redraw" else 2
        for model in (Job, Outbox, Ledger):
            assert db.scalar(select(func.count()).select_from(model)) == expected
        assert db.scalar(select(func.count()).select_from(JobRequest)) == 2
        if mode == "redraw":
            assert db.get(User, db.get(Job, first["id"]).owner_id).reserved == 8
            assert second.json()["status"] == "outcome_unknown"
