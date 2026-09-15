from conftest import quota_usage
"""Device-independent lookup uses no local IDs and never creates/bills jobs."""
from datetime import timedelta
from hashlib import sha256

import pytest
from sqlalchemy import func, select

from conftest import create, login_plus as login, run_job


FILE_HASH = sha256(b"synthetic-mobi-container").hexdigest()


def bind(client, auth, png, index=0, file_hash=FILE_HASH):
    return client.post("/v1/images", headers=auth,
        files={"image": ("renamed-page.png", png, "image/png")},
        data={"file_hash": file_hash, "page_index": index})


def match(client, auth, pages=None, mode="redraw", language="zh-Hans"):
    return client.post("/v1/file-pages/match", headers=auth, json={
        "pages": pages or [{"file_hash": FILE_HASH, "page_index": 0}],
        "mode": mode, "target_language": language})


def complete(client, auth, asset, png, monkeypatch, key="first"):
    import app.workers as workers
    from app.adapters.images import TranslationOutput
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(png))
    job = create(client, auth, asset, key=key).json()
    run_job(job["id"])
    return client.get(f"/v1/jobs/{job['id']}", headers=auth).json()


def test_new_device_restores_versions_without_upload_or_billing(client, png, monkeypatch):
    from app.db import session_factory
    from app.models import Asset, Job, Ledger
    auth = login(client)
    asset = bind(client, auth, png).json()["id"]
    first = complete(client, auth, asset, png, monkeypatch)
    # A new login/session has no device-local asset or job identifiers.
    another_device = login(client)
    before = quota_usage(client, auth)
    for _ in range(2):
        result = match(client, another_device)
        assert result.status_code == 200, result.text
        page = result.json()["items"][0]
        assert page["asset"]["id"] == asset
        assert [job["id"] for job in page["jobs"]] == [first["id"]]
        assert client.get(f"/v1/images/{page['jobs'][0]['output_asset_id']}/content", headers=another_device).content == png
    assert quota_usage(client, auth) == before
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Asset)) == 2
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Ledger)) == 2


def test_binding_deduplicates_upload_and_preserves_page_identity(client, png):
    auth = login(client)
    first = bind(client, auth, png).json()
    repeated = bind(client, auth, png, file_hash=FILE_HASH.upper()).json()
    assert first == repeated
    second = bind(client, auth, png, index=1).json()
    assert first["id"] != second["id"]
    identities = [{"file_hash": FILE_HASH, "page_index": i} for i in [1, 9, 0]]
    result = match(client, auth, identities).json()["items"]
    assert [page["page_index"] for page in result] == [1, 9, 0]
    assert [page["asset"]["id"] if page["asset"] else None for page in result] == [second["id"], None, first["id"]]
    # A different container cannot recover this container's page identities.
    assert match(client, auth, [{"file_hash": "b" * 64, "page_index": 0}]).json()["items"][0]["asset"] is None


def test_file_match_keeps_valid_versions_and_reuses_content_across_page_assets(client, png, monkeypatch):
    from conftest import preview
    auth = login(client)
    source = bind(client, auth, png).json()["id"]
    alias = bind(client, auth, png, index=1).json()["id"]
    first = complete(client, auth, source, png, monkeypatch)
    price = preview(client, auth, source)
    response = client.post(f"/v1/jobs/{first['id']}/rerun", headers={**auth, "Idempotency-Key": "second-version"},
        json={"preview_id": price["id"], "max_quota_pages": price["quota_pages"]})
    assert response.status_code == 202, response.text
    second = response.json()
    run_job(second["id"])
    identities = [{"file_hash": FILE_HASH, "page_index": index} for index in [0, 1]]
    pages = match(client, auth, identities).json()["items"]
    assert [page["asset"]["id"] for page in pages] == [source, alias]
    for page in pages:
        assert [job["id"] for job in page["jobs"]] == [first["id"], second["id"]]
    client.delete(f"/v1/images/{pages[0]['jobs'][1]['output_asset_id']}", headers=auth)
    for page in match(client, auth, identities).json()["items"]:
        assert [job["id"] for job in page["jobs"]] == [first["id"]]


def test_file_identity_cannot_be_rebound_to_different_page_bytes(client, png):
    from io import BytesIO
    from PIL import Image
    auth = login(client)
    first = bind(client, auth, png).json()["id"]
    changed = BytesIO()
    Image.new("RGB", (320, 480), "red").save(changed, "PNG")
    response = bind(client, auth, changed.getvalue())
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "FILE_PAGE_CONFLICT"
    assert match(client, auth).json()["items"][0]["asset"]["id"] == first


def test_matching_is_private_and_requires_auth(client, png, monkeypatch):
    alice, bob = login(client), login(client, "bob")
    asset = bind(client, alice, png).json()["id"]
    complete(client, alice, asset, png, monkeypatch)
    assert match(client, {}).status_code == 401
    assert match(client, bob).json()["items"] == [{"file_hash": FILE_HASH, "page_index": 0, "asset": None, "jobs": []}]
    bob_asset = bind(client, bob, png).json()["id"]
    assert bob_asset != asset
    assert match(client, bob).json()["items"][0]["jobs"] == []


@pytest.mark.parametrize("invalid", [
    {"file_hash": "invalid", "page_index": 0},
    {"file_hash": FILE_HASH, "page_index": -1},
    {"file_hash": FILE_HASH, "page_index": 0.5},
    {"file_hash": FILE_HASH, "page_index": True},
    {"file_hash": FILE_HASH, "page_index": 1_000_001},
    {"file_hash": FILE_HASH},
    {"file_hash": FILE_HASH, "page_index": 0, "owner_id": "someone-else"},
])
def test_match_rejects_invalid_identity(client, invalid):
    assert match(client, login(client), [invalid]).status_code == 422


def test_upload_identity_pair_and_match_size_validated(client, png):
    auth = login(client)
    for data in [{"file_hash": FILE_HASH}, {"page_index": 0}, {"file_hash": "bad", "page_index": 0}]:
        response = client.post("/v1/images", headers=auth,
            files={"image": ("page.png", png, "image/png")}, data=data)
        assert response.status_code == 422
    assert match(client, auth, [{"file_hash": FILE_HASH, "page_index": 0}] * 101).status_code == 422


@pytest.mark.parametrize("invalidated", ["output_deleted", "source_deleted", "output_expired", "source_expired", "output_missing"])
def test_deleted_expired_and_missing_results_never_match(client, png, monkeypatch, invalidated):
    from app.assets import object_path
    from app.db import session_factory
    from app.models import Asset, now
    auth = login(client)
    source = bind(client, auth, png).json()["id"]
    job = complete(client, auth, source, png, monkeypatch)
    target = source if invalidated.startswith("source") else job["output_asset_id"]
    if invalidated.endswith("deleted"):
        assert client.delete(f"/v1/images/{target}", headers=auth).status_code == 200
    else:
        with session_factory()() as db:
            asset = db.get(Asset, target)
            if invalidated.endswith("expired"):
                asset.expires_at = now() - timedelta(seconds=1)
            else:
                object_path(asset.storage_key).unlink()
            db.commit()
    page = match(client, auth).json()["items"][0]
    assert page["jobs"] == []
    assert (page["asset"] is None) == invalidated.startswith("source")
    if invalidated.startswith("source"):
        replacement = bind(client, auth, png).json()["id"]
        assert replacement != source
        assert match(client, auth).json()["items"][0]["jobs"] == []


def test_match_filters_language_mode_and_effective_config(client, png, monkeypatch):
    from app.config import settings
    auth = login(client)
    asset = bind(client, auth, png).json()["id"]
    complete(client, auth, asset, png, monkeypatch)
    assert match(client, auth, language="en").json()["items"][0]["jobs"] == []
    monkeypatch.setenv("CLASSIC_ENABLED", "true")
    settings.cache_clear()
    assert match(client, auth, mode="classic").json()["items"][0]["jobs"] == []
    from app.db import session_factory
    from app.models import Provider
    with session_factory()() as db:
        provider = db.get(Provider, "default")
        provider.config = {**provider.config, "model": "updated-image-model"}
        db.commit()
    assert match(client, auth).json()["items"][0]["jobs"] == []


def test_active_and_unknown_jobs_recover_but_cancelled_jobs_do_not(client, png):
    from app.db import session_factory
    from app.models import Job
    auth = login(client)
    asset = bind(client, auth, png).json()["id"]
    job = create(client, auth, asset).json()
    assert match(client, auth).json()["items"][0]["jobs"][0]["id"] == job["id"]
    with session_factory()() as db:
        db.get(Job, job["id"]).status = "outcome_unknown"
        db.commit()
    assert match(client, auth).json()["items"][0]["jobs"][0]["status"] == "outcome_unknown"
    client.post(f"/v1/jobs/{job['id']}/cancel", headers=auth)
    assert match(client, auth).json()["items"][0]["jobs"] == []


def test_classic_no_text_is_reusable_without_new_charge(client, png, monkeypatch):
    from app.config import settings
    from app.db import session_factory
    from app.jobs import settle
    from app.models import Job
    monkeypatch.setenv("CLASSIC_ENABLED", "true")
    settings.cache_clear()
    auth = login(client)
    source = bind(client, auth, png).json()["id"]
    job = client.post("/v1/translations/classic", headers={**auth, "Idempotency-Key": "no-text"},
        data={"asset_id": source, "target_language": "zh-Hans"}).json()
    with session_factory()() as db:
        saved = db.get(Job, job["id"])
        saved.status, saved.phase = "no_text", "completed"
        settle(db, saved, success=False)
        db.commit()
    result = match(client, auth, mode="classic").json()["items"][0]
    assert result["jobs"][0]["status"] == "no_text"
    assert quota_usage(client, auth)["used"] == 0
