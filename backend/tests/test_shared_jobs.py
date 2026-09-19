"""Cross-device plans share durable work and preserve every operation receipt."""
from datetime import timedelta
import pytest
from sqlalchemy import func, select
from conftest import create, login_plus as login, png_variant, run_job, upload, submit_asset, quota_usage
from app.config import settings
from app.db import session_factory
from app.entitlement_models import QuotaPeriod
from app.models import Asset, Job, Ledger, Provider, now
from app.plan_models import TranslationOperation, ImageAdmission
from test_lifecycle import submit_pages


@pytest.mark.parametrize("status", ["queued", "running", "outcome_unknown", "unknown_released"])
def test_active_work_reused_before_quota_and_image_rate_limits(client, png, status):
    auth = login(client)
    source, alias = upload(client, auth, png), upload(client, auth, png)
    first = create(client, auth, source, key="device-one").json()
    with session_factory()() as db:
        job = db.get(Job, first["id"])
        job.status = status
        period = db.get(QuotaPeriod, job.quota_period_id)
        period.granted = period.used + period.reserved
        db.commit()
    reused = submit_asset(client, auth, alias, key="device-two", max_quota_pages=0)
    assert reused.status_code == 200, reused.text
    assert reused.json()["items"][0]["disposition"] in {"pending", "blocked"}
    assert reused.json()["items"][0]["job"]["id"] == first["id"]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Ledger)) == 1
        assert db.scalar(select(func.count()).select_from(TranslationOperation)) == 2


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
    assert repeat.status_code == 200 and repeat.json()["id"] == original["id"]
    assert repeat.json()["status"] == terminal
    assert create(client, auth, asset, key="alias", language="en").json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    assert create(client, auth, upload(client, auth, png_variant(png, 9)), key="alias").json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(TranslationOperation)) == 2


def test_operations_keep_page_order_and_share_cancellation(client, png):
    from test_cluster_submissions import resolve
    alice, bob = login(client), login(client, "bob")
    assets = [upload(client, alice, png) for _ in range(3)]
    first = submit_pages(client, alice, assets, key="first").json()
    second = submit_pages(client, alice, list(reversed(assets)), key="second").json()
    assert len(first["items"]) == len(second["items"]) == 3
    assert len({item["job"]["id"] for item in first["items"] + second["items"]}) == 1
    assert [item["page_key"] for item in second["items"]] == ["0", "1", "2"]
    job_id = first["items"][0]["job"]["id"]
    keys = [item["operation_key"] for item in second["items"]]
    assert all(item["disposition"] == "not_found" for item in resolve(client,bob,keys).json()["items"])
    assert client.post(f"/v1/jobs/{job_id}/cancel",headers=bob).status_code == 404
    for _ in range(2):
        assert client.post(f"/v1/jobs/{job_id}/cancel",headers=alice).json()["status"] == "cancelled"
    assert all(item["job"]["status"]=="cancelled" for item in resolve(client,alice,keys).json()["items"])
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TranslationOperation)) == 6
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert sorted(db.scalars(select(Ledger.kind))) == ["release", "reserve"]


def test_mixed_plan_preserves_accepted_pages_when_another_exhausts_quota(client,png):
    auth=login(client)
    assets=[upload(client,auth,png_variant(png,index)) for index in range(3)]
    existing=create(client,auth,assets[0]).json()
    with session_factory()() as db:
        db.get(QuotaPeriod,existing["quota_period_id"]).granted=2
        db.commit()
    response=submit_pages(client,auth,assets,key="mixed")
    assert response.status_code==202,response.text
    assert [item["disposition"] for item in response.json()["items"]]==["pending","accepted","blocked"]
    assert response.json()["items"][2]["code"]=="REDRAW_QUOTA_EXHAUSTED"
    assert response.json()["items"][0]["job"]["id"]==existing["id"]
    assert quota_usage(client,auth)["reserved"]==2
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job))==2
        assert db.scalar(select(func.count()).select_from(ImageAdmission))==2
        assert db.scalar(select(func.count()).select_from(TranslationOperation))==3


def test_success_cache_remains_free_with_zero_spare_quota(client, png, monkeypatch):
    from app.adapters.images import TranslationOutput
    import app.workers as workers
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(png))
    auth = login(client)
    asset = upload(client, auth, png)
    first = create(client, auth, asset).json()
    run_job(first["id"])
    other = create(client, auth, upload(client, auth, png_variant(png, 1)), key="other").json()
    with session_factory()() as db:
        period = db.get(QuotaPeriod, other["quota_period_id"])
        period.granted = period.used + period.reserved
        db.commit()
    cached = submit_asset(client, auth, asset, key="free-cache", max_quota_pages=0)
    assert cached.status_code == 200 and cached.json()["items"][0]["disposition"] == "ready"
    assert cached.json()["items"][0]["disposition"] == "ready"
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
    assert reused.status_code == 200 and reused.json()["items"][0]["disposition"] == "ready"
    item = reused.json()["items"][0]
    assert item["disposition"] == "ready" and item["job"]["id"] == first["id"] and item["job"]["status"] == "no_text"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(JobStage)) == 2


def test_reusing_verified_source_does_not_reload_historical_page_descriptors(client,png):
    from sqlalchemy import event
    from sqlalchemy.orm import Session
    from app.file_pages import FilePage
    from test_cluster_submissions import descriptor,submit
    auth=login(client)
    asset=upload(client,auth,png)
    historical=[]
    for index in range(20):
        response=submit(client,auth,[descriptor(png,str(index),asset_id=asset,
            file_hash="a"*64,page_index=index)],key=f"old-{index}",mode="redraw")
        assert response.status_code in {200,202},response.text
    def loaded(db,value):
        if isinstance(value,TranslationOperation) and value.operation_key.startswith("old-"):
            historical.append(value.operation_key)
    event.listen(Session,"loaded_as_persistent",loaded)
    try:
        response=submit(client,auth,[descriptor(png,asset_id=asset,file_hash="b"*64,page_index=7)],
                        key="new-file-page",mode="redraw")
        assert response.status_code==200,response.text
        assert historical==[]
    finally:event.remove(Session,"loaded_as_persistent",loaded)
    with session_factory()() as db:
        assert len(list(db.scalars(select(FilePage))))==21


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
    if invalid == "missing":
        # Both account-local assets refer to the same physical object; its loss
        # invalidates both grants, and must not start work with missing bytes.
        assert second.status_code == 200 and second.json()["error"]["code"] == "ASSET_EXPIRED"
        return
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
    from translation_fixtures import configure_text_provider
    if mode == "classic":
        with session_factory()() as db:
            provider_id = db.get(Job, first["id"]).config['text']['provider_id']
            configure_text_provider(db, provider_id, model="changed-text-model")
    second = submit_asset(client, auth, alias, key="changed-config", mode=mode)
    assert second.status_code == (200 if mode == "redraw" else 202), second.text
    assert (second.json()["items"][0]["job"]["id"] == first["id"]) is (mode == "redraw")
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == (1 if mode == "redraw" else 2)
        assert db.scalar(select(func.count()).select_from(Ledger)) == (1 if mode == "redraw" else 0)


def test_failed_new_version_does_not_hide_an_older_free_result(client,png,monkeypatch):
    from app.adapters.images import TranslationOutput
    from app.errors import ProcessingError
    import app.workers as workers
    auth=login(client)
    source=upload(client,auth,png)
    monkeypatch.setattr(workers,'redraw',lambda *args:TranslationOutput(png))
    original=create(client,auth,source,key='delivered').json()
    run_job(original['id'])
    replacement=submit_asset(client,auth,source,key='explicit-new',regenerate=True,
                             rerun_job_id=original['id']).json()['items'][0]['job']
    def rejected(*args):raise ProcessingError('PROVIDER_REJECTED','isolated rejection')
    monkeypatch.setattr(workers,'redraw',rejected)
    run_job(replacement['id'])
    before=quota_usage(client,auth)
    restored=submit_asset(client,auth,source,key='new-device',max_quota_pages=0)
    assert restored.status_code==200
    assert restored.json()['items'][0]['disposition']=='ready'
    assert restored.json()['items'][0]['job']['id']==original['id']
    assert quota_usage(client,auth)==before
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job))==2
        assert db.scalar(select(func.count()).select_from(ImageAdmission))==2
