"""Unlimited originals/results with user access tracking and explicit deletion."""
from datetime import timedelta
import pytest
from sqlalchemy import select
from conftest import create, login, login_plus, run_job, upload
from test_cluster_submissions import cluster
from test_upload_storage import storage_db, remote, owner


def test_completed_original_and_result_survive_age_and_cleanup(cluster, png, monkeypatch):
    import app.workers as workers
    from app.adapters.images import TranslationOutput
    from app.config import settings
    from app.db import session_factory
    from app.dispatcher import cleanup
    from app.models import Asset, Job, now
    settings().retention_days = 0
    client, sdk = cluster
    auth = login_plus(client)
    source_id = upload(client, auth, png)
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(png))
    job_id = create(client, auth, source_id).json()["id"]
    run_job(job_id)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        output_id = job.output_asset_id
        assert job.status == "succeeded" and not job.input_pinned
        assets = list(db.scalars(select(Asset)))
        assert len(assets) == 2
        for asset in assets:
            assert asset.expires_at is None and asset.active_references == 0
            assert asset.last_accessed_at is None  # Model I/O is not a user access.
            asset.created_at = now() - timedelta(days=3650)
        db.commit()
        cleanup(db)
        assert all(not asset.deleted_at and not asset.purged_at for asset in db.scalars(select(Asset)))
    assert len(sdk.objects) == 1
    history = client.get("/v1/translations", headers=auth)
    assert history.status_code == 200 and history.json()["items"][0]["state"] == "succeeded"
    assert client.get(f"/v1/images/{output_id}/access", headers=auth).status_code == 200
    deleted = client.delete(f"/v1/images/{source_id}", headers=auth)
    assert deleted.status_code == 200
    assert set(deleted.json()["asset_ids"]) == {source_id, output_id}
    assert sdk.objects  # Deletion revokes personal grants; shared bytes persist.
    for asset_id in (source_id, output_id):
        assert client.get(f"/v1/images/{asset_id}/access", headers=auth).status_code == 410


def test_user_download_tracks_access_without_remote_metadata_probes(cluster, png, monkeypatch):
    import app.assets as assets
    from app.config import settings
    from app.db import session_factory
    from app.models import Asset, now
    settings().retention_days = 0
    client, sdk = cluster
    auth, other = login(client), login(client, "other")
    asset_id = upload(client, auth, png)
    with session_factory()() as db:
        asset = db.get(Asset, asset_id)
        assert assets.read_asset(asset) == png
        assert asset.last_accessed_at is None
    stamp = now()
    monkeypatch.setattr(assets, "now", lambda: stamp)
    calls = len(sdk.calls)
    access = client.get(f"/v1/images/{asset_id}/access", headers=auth)
    assert access.status_code == 200 and access.json()["expires_at"] is not None
    assert len(sdk.calls) == calls  # R2 signatures use metadata, never HEAD.
    with session_factory()() as db:
        assert db.get(Asset, asset_id).last_accessed_at == stamp
    stamp += timedelta(seconds=1)
    assert client.get(f"/v1/images/{asset_id}/access", headers=other).status_code == 404
    with session_factory()() as db:
        assert db.get(Asset, asset_id).last_accessed_at == stamp - timedelta(seconds=1)
    direct = client.get(f"/v1/images/{asset_id}/content", headers=auth, follow_redirects=False)
    assert direct.status_code == 307 and len(sdk.calls) == calls
    with session_factory()() as db:
        assert db.get(Asset, asset_id).last_accessed_at == stamp


def test_local_permanent_access_has_nullable_expiry(client, png):
    from app.config import settings
    from app.db import session_factory
    from app.models import Asset
    settings().retention_days = 0
    auth = login(client)
    asset_id = upload(client, auth, png)
    access = client.get(f"/v1/images/{asset_id}/access", headers=auth)
    assert access.status_code == 200 and access.json()["expires_at"] is None
    assert client.get(access.json()["url"], headers=auth).content == png
    with session_factory()() as db:
        assert db.get(Asset, asset_id).last_accessed_at is not None


@pytest.mark.parametrize("source_days,result_days", [(0, 7), (7, 0), (0, 0)])
def test_parent_retention_never_shortens_unlimited_source(storage_db, remote, png, source_days, result_days):
    from app.assets import create_asset
    from app.config import settings
    from app.db import session_factory
    owner_id = owner(storage_db)
    with session_factory()() as db:
        settings().retention_days = source_days
        source = create_asset(db, owner_id, png)
        settings().retention_days = result_days
        result = create_asset(db, owner_id, png, kind="redraw", parent_id=source.id)
        db.commit()
        assert source.expires_at is None
        assert (result.expires_at is None) == (result_days == 0)


def test_reconciled_result_remains_permanent(cluster, png, monkeypatch):
    import app.workers as workers
    from app.config import settings
    from app.db import session_factory
    from app.errors import ProcessingError
    from app.models import Asset
    settings().retention_days = 0
    client, _ = cluster
    auth = login_plus(client)
    source_id = upload(client, auth, png)
    def unknown(*args):
        raise ProcessingError("UPSTREAM_OUTCOME_UNKNOWN", "isolated response lost", unknown=True)
    monkeypatch.setattr(workers, "redraw", unknown)
    job_id = create(client, auth, source_id).json()["id"]
    run_job(job_id)
    response = client.post(f"/v1/admin/jobs/{job_id}/reconcile-image", headers=login(client, "admin"),
        files={"image": ("isolated.png", png, "image/png")}, data={"note": "isolated recovered result"})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "succeeded"
    with session_factory()() as db:
        assert all(asset.expires_at is None for asset in db.scalars(select(Asset)))
