"""R2 contracts and durable storage lifecycle under the cluster design."""
from datetime import timedelta
from io import BytesIO
from urllib.parse import parse_qs, urlsplit
from botocore.response import StreamingBody
from botocore.stub import Stubber
from fastapi import HTTPException
import pytest
from storage_fakes import MemoryS3, sdk_client
from test_upload_storage import storage_db, remote, owner, pending


@pytest.mark.parametrize("kind", ["classic_stage", "mask", None])
def test_remote_storage_rejects_disposable_intermediates(storage_db, remote, png, kind):
    from app.assets import create_asset
    from app.db import session_factory
    sdk, store = remote
    with pytest.raises(ValueError, match="originals, uploads and final"):
        store.put("fixture/disposable", png, "image/png", kind=kind)
    with session_factory()() as db, pytest.raises(ValueError, match="disposable local"):
        create_asset(db, "fixture", png, kind=kind, storage_backend="r2")
    assert sdk.calls == []


def test_signing_and_cross_account_queries_never_contact_r2(storage_db, remote, png):
    from app.assets import access_json, create_asset, owned_asset
    from app.db import session_factory
    from app.models import now
    sdk, _ = remote
    owner_id = owner(storage_db)
    with session_factory()() as db:
        source = create_asset(db, owner_id, png)
        output = create_asset(db, owner_id, png, kind="redraw", parent_id=source.id)
        db.commit()
        sdk.calls.clear()
        sdk.fail_head = True
        with pytest.raises(HTTPException) as failure:
            owned_asset(db, output.id, "other-owner")
        assert failure.value.status_code == 404
        receipt = access_json(owned_asset(db, output.id, owner_id))
        assert not receipt["authorization_required"]
        parsed = urlsplit(receipt["url"])
        query = parse_qs(parsed.query)
        assert parsed.hostname.endswith(".r2.cloudflarestorage.com")
        assert parsed.path.startswith("/test-bucket/isolated/")
        assert query["X-Amz-Expires"] == ["300"]
        assert query["X-Amz-SignedHeaders"] == ["host"]
        assert "/auto/s3/" in query["X-Amz-Credential"][0]
        output.expires_at = now() + timedelta(seconds=30)
        shorter = access_json(owned_asset(db, output.id, owner_id))
        assert 1 <= int(parse_qs(urlsplit(shorter["url"]).query)["X-Amz-Expires"][0]) <= 30
        sdk.objects.clear()
        assert access_json(owned_asset(db, output.id, owner_id))["url"]
        output.expires_at = now() - timedelta(seconds=1)
        with pytest.raises(HTTPException) as failure:
            owned_asset(db, output.id, owner_id)
        assert failure.value.status_code == 410
        assert sdk.calls == []


def test_deleted_ancestor_revokes_late_result_without_head_requests(storage_db, remote, png):
    from app.assets import create_asset, owned_asset
    from app.db import session_factory
    from app.models import now
    owner_id = owner(storage_db)
    with session_factory()() as db:
        source = create_asset(db, owner_id, png)
        source.deleted_at = now()
        db.commit()
        output = create_asset(db, owner_id, png, kind="redraw", parent_id=source.id)
        remote[0].calls.clear()
        with pytest.raises(HTTPException) as failure:
            owned_asset(db, output.id, owner_id)
        assert failure.value.status_code == 410
        assert remote[0].calls == []


def test_delete_revokes_grant_without_deleting_shared_object(storage_db, remote, png):
    from app.assets import create_asset, delete_asset_object, owned_asset
    from app.db import session_factory
    from app.models import now
    owner_id = owner(storage_db)
    with session_factory()() as db:
        source = create_asset(db, owner_id, png)
        source.deleted_at = now()
        db.commit()
        remote[0].fail_delete = True
        delete_asset_object(source)
        with pytest.raises(HTTPException) as failure:
            owned_asset(db, source.id, owner_id)
        assert failure.value.status_code == 410
        assert source.deleted_at and not source.purged_at
        remote[0].fail_delete = False
        delete_asset_object(source)
        delete_asset_object(source)
        source.purged_at = now()
        db.commit()
        assert remote[0].objects
        assert not any(method == "DELETE" for method, _ in remote[0].calls)






def test_sdk_contract_and_bounded_reads(storage_db, png):
    from app.storage import S3Store, StorageError
    from app.config import settings
    sdk = sdk_client()
    store = S3Store(sdk, 'test-bucket', 'isolated/')
    params = {'Bucket': 'test-bucket', 'Key': 'isolated/user/result'}
    raw = BytesIO(png)
    body = StreamingBody(raw, len(png))
    with Stubber(sdk) as stub:
        stub.add_response('put_object', {}, {**params, 'Body': png, 'ContentType': 'image/png', 'CacheControl': 'private, no-store'})
        stub.add_response('head_object', {}, params)
        stub.add_response('get_object', {'Body': body}, params)
        stub.add_client_error('head_object', 'NoSuchKey', http_status_code=404, expected_params=params)
        stub.add_client_error('head_object', 'AccessDenied', http_status_code=403, expected_params=params)
        stub.add_response('delete_object', {}, params)
        store.put('user/result', png, 'image/png', kind='redraw')
        assert store.exists('user/result')
        assert store.read('user/result') == png and raw.closed
        assert not store.exists('user/result')
        with pytest.raises(StorageError):
            store.exists('user/result')
        store.delete('user/result')
        stub.assert_no_pending_responses()
    settings().max_upload_bytes = 8
    raw = BytesIO(png)
    body = StreamingBody(raw, len(png))
    with Stubber(sdk) as stub:
        stub.add_response('get_object', {'Body': body}, params)
        with pytest.raises(StorageError):
            store.read('user/result')
        assert raw.closed


@pytest.mark.parametrize('changes', [
    {'r2_endpoint_url': 'https://wrong.example'}, {'r2_endpoint_url': 'http://' + 'a'*32 + '.r2.cloudflarestorage.com'},
    {'r2_endpoint_url': 'https://' + 'a'*32 + '.r2.cloudflarestorage.com/path'}, {'r2_key_prefix': '../'},
    {'r2_key_prefix': ''}, {'r2_bucket': 'bad/bucket'}, {'r2_secret_access_key': ''}, {'storage_url_ttl_seconds': 0},
])
def test_r2_configuration_rejects_invalid_targets(changes):
    from app.config import Settings
    from pydantic import ValidationError
    params = dict(_env_file=None, result_storage_backend='r2', r2_endpoint_url='https://' + 'a'*32 + '.r2.cloudflarestorage.com',
                  r2_bucket='test-bucket', r2_access_key_id='isolated-access', r2_secret_access_key='isolated-secret')
    with pytest.raises(ValidationError):
        Settings(**{**params, **changes})
