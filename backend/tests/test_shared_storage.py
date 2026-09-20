"""Cross-account byte/result reuse with account-local grants and settlement."""
from datetime import timedelta
import os

import pytest
from sqlalchemy import select

from conftest import create, login, login_plus, png_variant, quota_usage, run_job, upload
from test_cluster_submissions import cluster, descriptor, submit


def test_second_account_skips_upload_and_translation_and_keeps_private_ids(cluster, png, monkeypatch):
    from app.adapters.images import TranslationOutput
    from app.db import session_factory
    from app.models import Asset, Job, now
    import app.workers as workers

    client, sdk = cluster
    alice, bob = login_plus(client), login(client, "bob")
    output = png_variant(png, 21)
    calls = []
    monkeypatch.setattr(workers, "redraw", lambda *args: calls.append(True) or TranslationOutput(output))
    alice_source = upload(client, alice, png)
    alice_job = create(client, alice, alice_source).json()
    run_job(alice_job["id"])
    before = list(sdk.calls)
    bob_quota = client.get('/v1/me/usage', headers=bob).json()
    response = submit(client, bob, [descriptor(png, file_hash="c" * 64, page_index=4)],
                      mode="redraw", max_pages=0)
    assert response.status_code == 200, response.text
    item = response.json()["items"][0]
    job = item["job"]
    assert item["upload"] is None and item["disposition"] == "ready"
    assert job["status"] == "succeeded" and job["cache_hit"] and job["quota_pages"] == 0
    assert job["id"] != alice_job["id"] and job["input_asset_id"] != alice_source
    assert len(calls) == 1 and len(sdk.objects) == 2 and sdk.calls == before
    after_quota = client.get('/v1/me/usage', headers=bob).json()
    assert after_quota['items'] == bob_quota['items'] == []
    assert after_quota['entitlements']['modes']['redraw']['quota'] == bob_quota['entitlements']['modes']['redraw']['quota']
    with session_factory()() as db:
        original = db.get(Job, alice_job["id"])
        assert original.output_asset_id != job["output_asset_id"]
        assert db.get(Asset, original.output_asset_id).storage_key == db.get(Asset, job["output_asset_id"]).storage_key
        assert db.get(Asset, alice_source).storage_key == db.get(Asset, job["input_asset_id"]).storage_key
    assert client.get(f"/v1/jobs/{alice_job['id']}", headers=bob).status_code == 404
    assert client.get(f"/v1/images/{alice_source}/access", headers=bob).status_code == 404
    assert client.delete(f"/v1/images/{alice_source}", headers=alice).status_code == 200
    assert client.get(f"/v1/images/{job['output_asset_id']}/access", headers=bob).status_code == 200
    assert len(sdk.objects) == 2


def test_identical_direct_uploads_write_only_one_shared_object(cluster, png):
    from app.db import session_factory
    from app.models import Asset
    client, sdk = cluster
    first = upload(client, login(client), png)
    second = upload(client, login(client, "bob"), png)
    assert first != second
    assert len(sdk.objects) == 1 and len(sdk.calls) == 1
    with session_factory()() as db:
        assert db.get(Asset, first).storage_key == db.get(Asset, second).storage_key


@pytest.mark.parametrize("field,value", [("byte_size", 1), ("content_type", "image/jpeg")])
def test_shared_original_checks_descriptor_metadata(cluster, png, field, value):
    client, _ = cluster
    upload(client, login(client), png)
    page = descriptor(png)
    page[field] = value
    assert submit(client, login(client, "bob"), [page]).json()["items"][0]["disposition"] == "blocked"


@pytest.mark.parametrize("invalid", ["expired", "deleted", "config", "language"])
def test_invalid_or_different_results_are_not_shared(cluster, png, monkeypatch, invalid):
    from app.adapters.images import TranslationOutput
    from app.db import session_factory
    from app.models import Asset, Job, Provider, now
    import app.workers as workers
    client, _ = cluster
    alice, bob = login_plus(client), login_plus(client, "bob")
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(png_variant(png, 22)))
    original = create(client, alice, upload(client, alice, png)).json()
    run_job(original["id"])
    with session_factory()() as db:
        job = db.get(Job, original["id"])
        result = db.get(Asset, job.output_asset_id)
        if invalid == "expired":
            result.expires_at = now() - timedelta(seconds=1)
        elif invalid == "deleted":
            result.deleted_at = now()
        elif invalid == "config":
            provider = db.get(Provider, "default")
            provider.config = {**provider.config, "model": "new-model"}
        else:
            job.cache_key = "a" * 64
            job.target_language = "en"
            from app.results import TranslationResult
            db.get(TranslationResult, job.id).cache_key = job.cache_key
        db.commit()
    response = submit(client, bob, [descriptor(png)], mode="redraw")
    assert response.status_code == 202, response.text
    item = response.json()["items"][0]
    assert item["upload"] is None  # The verified original still avoids re-upload.
    assert item["job"]["status"] == "queued" and not item["job"]["cache_hit"]
    assert item["job"]["quota_pages"] == 1


def test_maintenance_never_scans_or_deletes_old_unreferenced_objects(cluster, png):
    from app.assets import object_path, write_object
    from app.db import session_factory
    from app.dispatcher import cleanup
    from app.models import now
    from app.storage import get_store
    _, sdk = cluster
    key = "unreferenced/synthetic-original"
    get_store("r2").put(key, png, "image/png", kind="original")
    write_object(key, png)
    stamp = (now() - timedelta(days=365)).timestamp()
    os.utime(object_path(key), (stamp, stamp))
    before = dict(sdk.objects)
    sdk.calls.clear()
    with session_factory()() as db:
        cleanup(db)
    assert sdk.objects == before and sdk.calls == []
    assert object_path(key).read_bytes() == png


def test_conditional_content_write_does_not_overwrite_and_412_is_success(client, png):
    from botocore.stub import Stubber
    from app.assets import content_storage_key, inspect_image
    from app.storage import S3Store
    from storage_fakes import sdk_client
    sdk = sdk_client()
    store = S3Store(sdk, "test-bucket", "isolated/")
    key = content_storage_key(inspect_image(png)["sha256"])
    params = dict(Bucket="test-bucket", Key="isolated/" + key, Body=png,
                  ContentType="image/png", CacheControl="private, no-store", IfNoneMatch="*")
    with Stubber(sdk) as stub:
        stub.add_response("put_object", {}, params)
        stub.add_client_error("put_object", "PreconditionFailed", http_status_code=412, expected_params=params)
        store.put(key, png, "image/png", kind="original")
        store.put(key, png, "image/png", kind="original")
        stub.assert_no_pending_responses()


def test_recovery_rejects_wrong_bytes_at_recorded_content_key(client, png):
    from conftest import claim_job
    from app.assets import content_storage_key, inspect_image
    from app.db import session_factory
    from app.dispatcher import recover_lease
    from app.models import Job, now
    from app.queue_models import ExecutionLease
    from app.storage import get_store
    auth = login_plus(client)
    job = create(client, auth, upload(client, auth, png)).json()
    lease_id = claim_job(job['id'])
    expected = png_variant(png, 50)
    key = content_storage_key(inspect_image(expected)['sha256'])
    with session_factory()() as db:
        lease = db.get(ExecutionLease, lease_id)
        lease.output_key = key
        lease.expires_at = now() - timedelta(seconds=1)
        db.commit()
    get_store('local').put(key, png_variant(png, 51), 'image/png', kind='redraw')
    recover_lease(lease_id)
    with session_factory()() as db:
        row = db.get(Job, job['id'])
        assert row.status == 'failed' and row.error_code == 'INVALID_PROVIDER_OUTPUT'
        assert row.output_asset_id is None and row.settlement == 'released'
