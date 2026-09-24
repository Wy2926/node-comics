from conftest import inspect_job
from conftest import quota_usage
"""Device-independent lookup uses no local IDs and never creates/bills jobs."""
from datetime import timedelta
from hashlib import sha256

import pytest
from sqlalchemy import func, select

from conftest import create, login_plus as login, run_job, submit_asset, upload, request_for_job, request_id


FILE_HASH = sha256(b"synthetic-mobi-container").hexdigest()


def bind(client, auth, png, index=0, file_hash=FILE_HASH):
    """Prepare a private file-page fixture; actual HTTP upload validation has cluster coverage."""
    import httpx
    from app.db import session_factory
    from app.assets import available, asset_json
    from app.file_pages import FilePage
    from app.models import Asset
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    with session_factory()() as db:
        mapping = db.get(FilePage, (owner, file_hash.lower(), index))
        asset = db.get(Asset, mapping.asset_id) if mapping else None
        if asset and available(asset):
            return httpx.Response(200,json=asset_json(asset))
    asset_id = upload(client, auth, png)
    with session_factory()() as db:
        mapping = db.get(FilePage, (owner, file_hash.lower(), index))
        if mapping:
            mapping.asset_id = asset_id
        else:
            db.add(FilePage(owner_id=owner,file_hash=file_hash.lower(),page_index=index,asset_id=asset_id))
        db.commit()
        return httpx.Response(200,json=asset_json(db.get(Asset,asset_id)))


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
    return inspect_job(job['id'])


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
        assert [job["id"] for job in page["translations"]] == [request_for_job(client, auth, first["id"])]
        assert client.get(f"/v1/images/{page['translations'][0]['result']['asset_id']}/content", headers=another_device).content == png
    assert quota_usage(client, auth) == before
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Asset)) == 2
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Ledger)) == 2


def test_submission_reuses_one_source_and_preserves_each_page_identity(client, png):
    auth = login(client)
    asset = upload(client, auth, png)
    first = submit_asset(client, auth, asset, key='mapped-first').json()
    second = submit_asset(client, auth, asset, key='mapped-second').json()
    assert first['id'] != second['id']
    for index, translation in enumerate((first, second)):
        response = client.put('/v1/file-pages/bind', headers=auth, json={
            'translation_id': translation['id'], 'file_hash': FILE_HASH, 'page_index': index})
        assert response.status_code == 200, response.text
        assert response.json()['asset_id'] == asset
    from conftest import request_record
    assert request_record(client, auth, first['id']).job_id == request_record(client, auth, second['id']).job_id
    identities = [{'file_hash': FILE_HASH, 'page_index': i} for i in [1, 9, 0]]
    result = match(client, auth, identities).json()['items']
    assert [page['page_index'] for page in result] == [1, 9, 0]
    assert [page['asset']['id'] if page['asset'] else None for page in result] == [asset, None, asset]
    assert match(client, auth, [{'file_hash': FILE_HASH.upper(), 'page_index': 0}]).json()['items'][0]['asset']['id'] == asset
    assert match(client, auth, [{'file_hash': 'b' * 64, 'page_index': 0}]).json()['items'][0]['asset'] is None


def test_file_match_keeps_valid_versions_and_reuses_content_across_page_assets(client, png, monkeypatch):
    auth = login(client)
    source = bind(client, auth, png).json()["id"]
    alias = bind(client, auth, png, index=1).json()["id"]
    first = complete(client, auth, source, png, monkeypatch)
    response = create(client, auth, source, key='second-version', regenerate=True, rerun_job_id=first['id'])
    assert response.status_code == 202, response.text
    second = response.json()
    run_job(second["id"])
    identities = [{"file_hash": FILE_HASH, "page_index": index} for index in [0, 1]]
    pages = match(client, auth, identities).json()["items"]
    assert [page["asset"]["id"] for page in pages] == [source, alias]
    for page in pages:
        assert [job["id"] for job in page["translations"]] == [request_for_job(client, auth, first["id"]), request_for_job(client, auth, second["id"])]
    client.delete(f"/v1/images/{pages[0]['translations'][1]['result']['asset_id']}", headers=auth)
    for page in match(client, auth, identities).json()["items"]:
        assert [job["id"] for job in page["translations"]] == [request_for_job(client, auth, first["id"])]


def test_file_identity_cannot_be_rebound_to_different_page_bytes(client, png):
    from conftest import png_variant
    auth = login(client)
    first = bind(client, auth, png).json()['id']
    changed = upload(client, auth, png_variant(png, 2))
    request = submit_asset(client, auth, changed, key='rebind').json()
    response = client.put('/v1/file-pages/bind', headers=auth, json={
        'translation_id': request['id'], 'file_hash': FILE_HASH, 'page_index': 0})
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'FILE_PAGE_CONFLICT'
    assert match(client, auth).json()['items'][0]['asset']['id'] == first
    assert client.put('/v1/file-pages/bind', headers=login(client, 'other'), json={
        'translation_id': request['id'], 'file_hash': FILE_HASH, 'page_index': 0}).status_code == 404


def test_matching_is_private_and_requires_auth(client, png, monkeypatch):
    alice, bob = login(client), login(client, "bob")
    asset = bind(client, alice, png).json()["id"]
    complete(client, alice, asset, png, monkeypatch)
    assert match(client, {}).status_code == 401
    assert match(client, bob).json()["items"] == [{"file_hash": FILE_HASH, "page_index": 0, "asset": None, "translations": []}]
    bob_asset = bind(client, bob, png).json()["id"]
    assert bob_asset != asset
    assert match(client, bob).json()["items"][0]["translations"] == []


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


def test_submission_identity_pair_and_match_size_validated(client, png):
    auth = login(client)
    for data in [{'file_hash': FILE_HASH}, {'page_index': 0}, {'file_hash': 'bad', 'page_index': 0}]:
        response = client.put('/v1/file-pages/bind', headers=auth, json={
            'translation_id': request_id('missing'), **data})
        assert response.status_code == 422, response.text
    assert match(client, auth, [{'file_hash': FILE_HASH, 'page_index': 0}] * 101).status_code == 422


@pytest.mark.parametrize("invalidated", ["output_deleted", "source_deleted", "output_expired", "source_expired"])
def test_deleted_and_expired_results_never_match(client, png, monkeypatch, invalidated):
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
            db.commit()
    page = match(client, auth).json()["items"][0]
    assert page["translations"] == []
    assert (page["asset"] is None) == invalidated.startswith("source")
    if invalidated.startswith("source"):
        replacement = bind(client, auth, png).json()["id"]
        assert replacement != source
        assert match(client, auth).json()["items"][0]["translations"] == []


def test_match_filters_language_mode_and_effective_config(client, png, monkeypatch):
    from app.config import settings
    auth = login(client)
    asset = bind(client, auth, png).json()["id"]
    complete(client, auth, asset, png, monkeypatch)
    assert match(client, auth, language="en").json()["items"][0]["translations"] == []
    monkeypatch.setenv("CLASSIC_ENABLED", "true")
    settings.cache_clear()
    assert match(client, auth, mode="classic").json()["items"][0]["translations"] == []
    from app.db import session_factory
    from app.models import Provider
    with session_factory()() as db:
        provider = db.get(Provider, "default")
        provider.config = {**provider.config, "model": "updated-image-model"}
        db.commit()
    assert match(client, auth).json()["items"][0]["translations"] == []


def test_active_and_unknown_jobs_recover_but_cancelled_jobs_do_not(client, png):
    from app.db import session_factory
    from app.models import Job
    auth = login(client)
    asset = bind(client, auth, png).json()["id"]
    job = create(client, auth, asset).json()
    assert match(client, auth).json()["items"][0]["translations"][0]["id"] == request_for_job(client, auth, job["id"])
    with session_factory()() as db:
        db.get(Job, job["id"]).status = "outcome_unknown"
        db.commit()
    assert match(client, auth).json()["items"][0]["translations"][0]["state"] == "needs_attention"
    client.post(f"/v1/translations/{request_for_job(client, auth, job['id'])}/cancel", headers=auth)
    assert match(client, auth).json()["items"][0]["translations"] == []


def test_classic_no_text_is_reusable_without_new_charge(client, png, monkeypatch):
    from app.config import settings
    from app.db import session_factory
    from app.jobs import settle
    from app.models import Job
    monkeypatch.setenv("CLASSIC_ENABLED", "true")
    settings.cache_clear()
    auth = login(client)
    source = bind(client, auth, png).json()["id"]
    job = create(client,auth,source,key='no-text',mode='classic').json()
    with session_factory()() as db:
        saved = db.get(Job, job["id"])
        saved.status, saved.phase = "no_text", "completed"
        settle(db, saved, success=False)
        db.commit()
    result = match(client, auth, mode="classic").json()["items"][0]
    assert result["translations"][0]["result"]["kind"] == "no_text"
    assert quota_usage(client, auth)["used"] == 0
