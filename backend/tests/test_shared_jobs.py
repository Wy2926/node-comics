"""Cross-device submissions share durable work and preserve every receipt."""
from datetime import timedelta
import pytest
from sqlalchemy import func, select
from conftest import create, login_plus as login, png_variant, run_job, upload, submit_asset, quota_usage
from app.config import settings
from app.db import session_factory
from app.entitlement_models import QuotaPeriod
from app.models import Asset, Job, Ledger, Provider, now
from app.queue_models import Submission, SubmissionItem
from test_lifecycle import submit_pages


@pytest.mark.parametrize("status", ["queued", "running", "outcome_unknown", "unknown_released"])
def test_active_work_reused_before_quota_and_capacity_limits(client, png, status):
    auth = login(client)
    source, alias = upload(client, auth, png), upload(client, auth, png)
    first = create(client, auth, source, key="device-one").json()
    settings().plus_queue_capacity = 1
    with session_factory()() as db:
        job = db.get(Job, first["id"])
        job.status = status
        period = db.get(QuotaPeriod, job.quota_period_id)
        period.granted = period.used + period.reserved
        db.commit()
    reused = submit_asset(client, auth, alias, key="device-two", max_quota_pages=0)
    assert reused.status_code == 202, reused.text
    assert reused.json()["quota_pages"] == 0 and reused.json()["items"][0]["reused"]
    assert reused.json()["items"][0]["job"]["id"] == first["id"]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Ledger)) == 1
        assert db.scalar(select(func.count()).select_from(Submission)) == 2


@pytest.mark.parametrize("terminal", ["succeeded", "failed", "cancelled"])
def test_reused_receipt_survives_terminal_status_and_config_changes(client, png, terminal, monkeypatch):
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
        from app.workers import finish_job
        from app.scheduler import lock_scheduler
        with session_factory()() as db:
            lock_scheduler(db)
            finish_job(db, db.get(Job, original["id"]), terminal)
            db.commit()
    with session_factory()() as db:
        provider = db.get(Provider, "default")
        provider.config = {**provider.config, "model": "changed-model"}
        db.commit()
    repeat = create(client, auth, asset, key="alias")
    assert repeat.status_code == 202 and repeat.json()["id"] == original["id"]
    assert repeat.json()["status"] == terminal
    assert create(client, auth, asset, key="alias", language="en").status_code == 409
    assert create(client, auth, upload(client, auth, png_variant(png, 9)), key="alias").status_code == 409
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Submission)) == 2


def test_submission_aliases_keep_page_order_and_share_cancellation(client, png):
    alice, bob = login(client), login(client, "bob")
    assets = [upload(client, alice, png) for _ in range(3)]
    first = submit_pages(client, alice, assets, key="first").json()
    second = submit_pages(client, alice, list(reversed(assets)), key="second").json()
    assert (first["quota_pages"], second["quota_pages"]) == (1, 0)
    assert len(first["items"]) == len(second["items"]) == 3
    assert len({item["job"]["id"] for item in first["items"] + second["items"]}) == 1
    assert [item["client_item_id"] for item in second["items"]] == ["0", "1", "2"]
    assert client.get(f"/v1/translation-submissions/{second['id']}", headers=bob).status_code == 404
    assert client.post(f"/v1/translation-submissions/{second['id']}/cancel", headers=bob).status_code == 404
    for _ in range(2):
        assert client.post(f"/v1/translation-submissions/{second['id']}/cancel", headers=alice).json()["status"] == "cancelled"
    assert client.get(f"/v1/translation-submissions/{first['id']}", headers=alice).json()["status"] == "cancelled"
    assert submit_pages(client, alice, list(reversed(assets)), key="second").json()["id"] == second["id"]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(SubmissionItem)) == 6
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert sorted(db.scalars(select(Ledger.kind))) == ["release", "reserve"]
        descriptors = list(db.scalars(select(SubmissionItem.descriptor).where(SubmissionItem.submission_id == second["id"]).order_by(SubmissionItem.ordinal)))
        assert [item["asset_id"] for item in descriptors] == list(reversed(assets))


def test_mixed_submission_only_reserves_new_work_and_rolls_back_insufficient_quota(client, png):
    auth = login(client)
    assets = [upload(client, auth, png_variant(png, index)) for index in range(3)]
    existing = create(client, auth, assets[0]).json()
    with session_factory()() as db:
        db.get(QuotaPeriod, existing["quota_period_id"]).granted = 2
        db.commit()
    denied = submit_pages(client, auth, assets, key="insufficient")
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "REDRAW_QUOTA_EXHAUSTED"
    with session_factory()() as db:
        for model in (Job, Ledger, Submission, SubmissionItem):
            assert db.scalar(select(func.count()).select_from(model)) == 1
        assert db.get(QuotaPeriod, existing["quota_period_id"]).reserved == 1
    accepted = submit_pages(client, auth, assets[:2], key="mixed")
    assert accepted.status_code == 202 and accepted.json()["quota_pages"] == 1
    assert accepted.json()["items"][0]["job"]["id"] == existing["id"]
    assert quota_usage(client, auth)["reserved"] == 2


def test_success_cache_remains_free_with_full_queue_and_zero_spare_quota(client, png, monkeypatch):
    from app.adapters.images import TranslationOutput
    import app.workers as workers
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(png))
    auth = login(client)
    asset = upload(client, auth, png)
    first = create(client, auth, asset).json()
    run_job(first["id"])
    other = create(client, auth, upload(client, auth, png_variant(png, 1)), key="other").json()
    settings().plus_queue_capacity = 1
    with session_factory()() as db:
        period = db.get(QuotaPeriod, other["quota_period_id"])
        period.granted = period.used + period.reserved
        db.commit()
    cached = submit_asset(client, auth, asset, key="free-cache", max_quota_pages=0)
    assert cached.status_code == 202 and cached.json()["quota_pages"] == 0
    assert cached.json()["items"][0]["reused"]
    assert cached.json()["items"][0]["job"]["id"] == first["id"]


def test_no_text_result_is_reused_without_a_new_job_or_stage(client, png):
    from app.workers import finish_job
    from app.scheduler import lock_scheduler
    from app.queue_models import JobStage
    settings().classic_enabled = True
    auth = login(client)
    source, alias = upload(client, auth, png), upload(client, auth, png)
    first = submit_asset(client, auth, source, mode="classic").json()["items"][0]["job"]
    with session_factory()() as db:
        lock_scheduler(db)
        finish_job(db, db.get(Job, first["id"]), "no_text")
        db.commit()
    reused = submit_asset(client, auth, alias, key="other-device", mode="classic", max_quota_pages=0)
    assert reused.status_code == 202 and reused.json()["quota_pages"] == 0
    item = reused.json()["items"][0]
    assert item["reused"] and item["job"]["id"] == first["id"] and item["job"]["status"] == "no_text"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(JobStage)) == 4


@pytest.mark.parametrize("invalid", ["cancel", "discard", "deleted", "missing"])
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
        elif invalid == "deleted":
            asset.deleted_at = now()
        else:
            object_path(asset.storage_key).unlink()
        db.commit()
    second = create(client, auth, alias, key="different-device")
    assert second.status_code == 202 and second.json()["id"] != first["id"]


def test_active_pin_keeps_expired_original_available_for_reuse(client, png):
    auth = login(client)
    asset = upload(client, auth, png)
    first = create(client, auth, asset).json()
    with session_factory()() as db:
        db.get(Asset, asset).expires_at = now() - timedelta(days=1)
        db.commit()
    assert create(client, auth, asset, key="other-device").json()["id"] == first["id"]


@pytest.mark.parametrize("mode", ["redraw", "classic"])
def test_changed_config_cannot_automatically_replay_unknown_redraw(client, png, mode):
    settings().classic_enabled = True
    auth = login(client)
    source, alias = upload(client, auth, png), upload(client, auth, png)
    first = submit_asset(client, auth, source, key="first-config", mode=mode).json()["items"][0]["job"]
    with session_factory()() as db:
        job = db.get(Job, first["id"])
        job.status, job.unknown_since = "outcome_unknown", now()
        provider = db.get(Provider, "default")
        provider.config = {**provider.config, "parameters": {"quality": "high"}}
        db.commit()
    settings().text_model = "changed-text-model"
    second = submit_asset(client, auth, alias, key="changed-config", mode=mode)
    assert second.status_code == 202, second.text
    assert (second.json()["items"][0]["job"]["id"] == first["id"]) is (mode == "redraw")
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == (1 if mode == "redraw" else 2)
        assert db.scalar(select(func.count()).select_from(Ledger)) == (1 if mode == "redraw" else 0)
