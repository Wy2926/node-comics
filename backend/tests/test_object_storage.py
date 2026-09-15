from datetime import timedelta, timezone
from io import BytesIO
from urllib.parse import parse_qs, urlsplit
from unittest.mock import Mock
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, EndpointConnectionError
from botocore.response import StreamingBody
from botocore.stub import Stubber
import pytest
from conftest import claim_job, create, login, run_job, upload
from test_classic import configured  # Reuse the isolated OCR/text/render fixture.


def sdk_client():
    return boto3.session.Session().client('s3', endpoint_url='https://' + 'a' * 32 + '.r2.cloudflarestorage.com',
        region_name='auto', aws_access_key_id='isolated-access', aws_secret_access_key='isolated-secret',
        config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}))


class MemoryS3:
    """Simulated S3 only: production adapter, jobs, API and billing remain real."""
    def __init__(self):
        self.objects, self.calls = {}, []
        self.fail_delete = False
        self.fail_head = False
        self.uncertain_put = False
        self.generate_presigned_url = sdk_client().generate_presigned_url

    def put_object(self, **params):
        self.calls.append(('PUT', params['Key']))
        self.objects[params['Key']] = params['Body']
        assert params['ContentType'] == 'image/png'
        assert params['CacheControl'] == 'private, no-store'
        if self.uncertain_put:
            self.uncertain_put = False
            raise EndpointConnectionError(endpoint_url='secret diagnostic must not escape')
        return {}

    def head_object(self, **params):
        self.calls.append(('HEAD', params['Key']))
        if self.fail_head:
            raise EndpointConnectionError(endpoint_url='secret diagnostic must not escape')
        if params['Key'] not in self.objects:
            raise ClientError({'Error': {'Code': '404'}, 'ResponseMetadata': {'HTTPStatusCode': 404}}, 'HeadObject')
        return {}

    def get_object(self, **params):
        self.calls.append(('GET', params['Key']))
        data = self.objects[params['Key']]
        return {'Body': StreamingBody(BytesIO(data), len(data))}

    def delete_object(self, **params):
        self.calls.append(('DELETE', params['Key']))
        if self.fail_delete:
            raise EndpointConnectionError(endpoint_url='secret diagnostic must not escape')
        self.objects.pop(params['Key'], None)
        return {}

    def list_objects_v2(self, **params):
        from app.models import now
        keys = sorted(k for k in self.objects if k > params.get('ContinuationToken', ''))
        page = keys[:params['MaxKeys']]
        return {'Contents': [{'Key': k, 'LastModified': (now() - timedelta(days=2)).replace(tzinfo=timezone.utc)} for k in page],
                'IsTruncated': len(keys) > len(page), 'NextContinuationToken': page[-1] if page else None}


@pytest.fixture
def remote(client, monkeypatch):
    from app.config import settings
    from app.storage import S3Store
    import app.storage as storage
    cfg = settings()
    cfg.result_storage_backend = 'r2'
    cfg.r2_endpoint_url = 'https://' + 'a' * 32 + '.r2.cloudflarestorage.com'
    sdk = MemoryS3()
    store = S3Store(sdk, 'test-bucket', 'isolated/')
    monkeypatch.setattr(storage, 'r2_store', lambda *args: store)
    return sdk, store


def delivered(client, png, monkeypatch):
    from app.adapters.images import TranslationOutput
    import app.workers as workers
    supplier = Mock(return_value=TranslationOutput(png, usage={'total_tokens': 17}))
    monkeypatch.setattr(workers, 'redraw', supplier)
    auth = login(client)
    original = upload(client, auth, png)
    job_id = create(client, auth, original).json()['id']
    run_job(job_id)
    job = client.get(f'/v1/jobs/{job_id}', headers=auth).json()
    return auth, original, job, supplier


def test_r2_delivery_direct_access_and_account_isolation(client, remote, png, monkeypatch):
    from app.assets import object_path
    from app.config import settings
    from app.db import session_factory
    from app.models import Asset
    sdk, _ = remote
    auth, original, job, supplier = delivered(client, png, monkeypatch)
    assert job['status'] == 'succeeded'
    output = job['output_asset_id']
    with session_factory()() as db:
        asset = db.get(Asset, output)
        assert asset.storage_backend == 'r2'
        assert not object_path(asset.storage_key).exists()
        assert object_path(db.get(Asset, original).storage_key).is_file()
    settings().result_storage_backend = 'local'  # Existing output keeps its R2 location.
    response = client.get(f'/v1/images/{output}/access', headers=auth)
    access = response.json()
    assert response.headers['cache-control'] == 'private, no-store'
    assert access['authorization_required'] is False
    parsed = urlsplit(access['url'])
    query = parse_qs(parsed.query)
    assert parsed.hostname.endswith('.r2.cloudflarestorage.com')
    assert parsed.path.startswith('/test-bucket/isolated/')
    assert query['X-Amz-Expires'] == ['300']
    assert query['X-Amz-SignedHeaders'] == ['host']
    assert '/auto/s3/' in query['X-Amz-Credential'][0]
    assert client.get(f'/v1/images/{output}/content', headers=auth, follow_redirects=False).status_code == 307
    assert not any(method == 'GET' for method, _ in sdk.calls)  # API never proxies image bytes.
    calls = len(sdk.calls)
    assert client.get(f'/v1/images/{output}/access', headers=login(client, 'bob')).status_code == 404
    assert client.get(f'/v1/images/{output}/access').status_code == 401
    assert len(sdk.calls) == calls
    run_job(job['id'])
    assert supplier.call_count == 1
    assert client.get('/v1/me/usage', headers=auth).json()['balance'] == 92


def test_missing_expired_and_transient_objects_are_distinct(client, remote, png, monkeypatch):
    from app.db import session_factory
    from app.models import Asset, now
    sdk, _ = remote
    auth, _, job, _ = delivered(client, png, monkeypatch)
    output = job['output_asset_id']
    sdk.fail_head = True
    result = client.get(f'/v1/images/{output}/access', headers=auth)
    assert result.status_code == 503 and result.json()['error']['code'] == 'STORAGE_UNAVAILABLE'
    assert 'diagnostic' not in result.text
    sdk.fail_head = False
    with session_factory()() as db:
        asset = db.get(Asset, output)
        asset.expires_at = now() + timedelta(seconds=30)
        db.commit()
    access = client.get(f'/v1/images/{output}/access', headers=auth).json()
    assert 1 <= int(parse_qs(urlsplit(access['url']).query)['X-Amz-Expires'][0]) <= 30
    saved = sdk.objects.copy()
    sdk.objects.clear()
    assert client.get(f'/v1/images/{output}/access', headers=auth).status_code == 410
    sdk.objects.update(saved)
    with session_factory()() as db:
        db.get(Asset, output).expires_at = now() - timedelta(seconds=1)
        db.commit()
    assert client.get(f'/v1/images/{output}/access', headers=auth).status_code == 410


def test_delete_tombstone_survives_r2_outage_and_cleanup_retries(client, remote, png, monkeypatch):
    from app.db import session_factory
    from app.dispatcher import cleanup
    from app.models import Asset
    sdk, _ = remote
    auth, original, job, _ = delivered(client, png, monkeypatch)
    sdk.fail_delete = True
    assert client.delete(f'/v1/images/{original}', headers=auth).status_code == 503
    assert client.get(f"/v1/images/{job['output_asset_id']}/access", headers=auth).status_code == 410
    with session_factory()() as db:
        assert db.get(Asset, job['output_asset_id']).deleted_at
        cleanup(db)
        db.commit()
        assert db.get(Asset, job['output_asset_id']).purged_at is None
        sdk.fail_delete = False
        cleanup(db)
        db.commit()
        assert db.get(Asset, job['output_asset_id']).purged_at
    assert not sdk.objects


def test_uncertain_put_is_recovered_without_repeating_paid_call(client, remote, png, monkeypatch):
    from app.config import settings
    from app.db import session_factory
    from app.dispatcher import recover
    from app.models import Asset, Attempt, Job, now
    sdk, _ = remote
    sdk.uncertain_put = True
    auth, _, job, supplier = delivered(client, png, monkeypatch)
    assert job['status'] == 'running'
    settings().result_storage_backend = 'local'
    with session_factory()() as db:
        current = db.get(Job, job['id'])
        assert current.error_code == 'STORAGE_UNAVAILABLE'
        attempt = db.get(Attempt, current.attempt_id)
        assert attempt.output_storage_backend == 'r2' and attempt.usage == {'total_tokens': 17}
        sdk.fail_head = True
        recover(db)
        db.commit()
        assert current.status == 'running'
        sdk.fail_head = False
        attempt.lease_expires_at = now() - timedelta(seconds=1)
        db.commit()
        recover(db)
        db.commit()
        recover(db)
        db.commit()
        assert current.status == 'succeeded' and db.get(Asset, current.output_asset_id).storage_backend == 'r2'
    run_job(job['id'])
    assert supplier.call_count == 1
    usage = client.get('/v1/me/usage', headers=auth).json()
    assert usage['balance'] == 92 and usage['reserved'] == 0


def test_remote_sweep_advances_and_preserves_pending_recovery(client, remote, png):
    from app.db import session_factory
    from app.dispatcher import cleanup
    from app.models import Job, StorageScan, now
    sdk, store = remote
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()['id']
    attempt = claim_job(job_id)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        store.put(f'{job.owner_id}/{attempt}', png, 'image/png')
        for index in range(205):
            store.put(f'orphans/{index:04}', png, 'image/png')
        cleanup(db)
        db.commit()
        assert db.get(StorageScan, 'r2').cursor
        db.get(StorageScan, 'r2').next_scan_at = now()
        db.commit()
        cleanup(db)
        db.commit()
        assert list(sdk.objects) == [f'isolated/{job.owner_id}/{attempt}']
        assert db.get(StorageScan, 'r2').cursor is None


def test_sdk_contract_and_bounded_reads(client, png):
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
        store.put('user/result', png, 'image/png')
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


def test_classic_restores_r2_checkpoint_without_rerunning_text(configured, remote, monkeypatch):
    from app.assets import object_path
    from app.db import session_factory
    from app.dispatcher import recover
    from app.models import Asset, ClassicState, Job
    from app.storage import StorageError
    import app.workers as workers
    from test_classic import submit
    client, auth, _, calls = configured
    actual_create = workers.create_asset
    def interrupted(*args, **kwargs):
        monkeypatch.setattr(workers, 'create_asset', actual_create)
        raise StorageError()
    monkeypatch.setattr(workers, 'create_asset', interrupted)
    job_id = submit(configured)
    run_job(job_id)
    with session_factory()() as db:
        assert db.get(Job, job_id).status == 'running'
        state = db.get(ClassicState, job_id)
        for asset_id in state.artifacts.values():
            asset = db.get(Asset, asset_id)
            assert asset.storage_backend == 'r2' and not object_path(asset.storage_key).exists()
        recover(db)
        db.commit()
    run_job(job_id)
    assert calls == {'text': 1, 'analyze': 1, 'render': 1}
    assert client.get(f'/v1/jobs/{job_id}', headers=auth).json()['status'] == 'succeeded'
    assert any(method == 'GET' for method, _ in remote[0].calls)


def test_reconciled_upload_is_delivered_from_r2_and_local_copy_removed(client, remote, png, monkeypatch):
    from app.assets import object_path
    from app.db import session_factory
    from app.errors import ProcessingError
    from app.models import Asset
    import app.workers as workers
    def unknown(*args):
        raise ProcessingError('UPSTREAM_OUTCOME_UNKNOWN', 'test', unknown=True)
    monkeypatch.setattr(workers, 'redraw', unknown)
    auth, admin = login(client), login(client, 'admin')
    job_id = create(client, auth, upload(client, auth, png)).json()['id']
    run_job(job_id)
    output = upload(client, auth, png)
    response = client.post(f'/v1/admin/jobs/{job_id}/reconcile', headers=admin,
        json={'resolution': 'succeeded', 'output_asset_id': output, 'note': 'isolated test'})
    assert response.status_code == 200 and response.json()['status'] == 'succeeded'
    with session_factory()() as db:
        asset = db.get(Asset, output)
        assert asset.storage_backend == 'r2' and not object_path(asset.storage_key).exists()
    assert client.get(f'/v1/images/{output}/access', headers=auth).json()['authorization_required'] is False


def test_cancelled_crash_output_is_removed_without_charging(client, remote, png):
    from app.db import session_factory
    from app.dispatcher import recover
    from app.models import Attempt, Job, now
    auth = login(client)
    original = upload(client, auth, png)
    job_id = create(client, auth, original).json()['id']
    attempt_id = claim_job(job_id)
    with session_factory()() as db:
        attempt = db.get(Attempt, attempt_id)
        attempt.call_started_at = now() - timedelta(minutes=5)
        attempt.lease_expires_at = now() - timedelta(seconds=1)
        remote[1].put(f'{db.get(Job, job_id).owner_id}/{attempt_id}', png, 'image/png')
        db.commit()
    assert client.delete(f'/v1/images/{original}', headers=auth).status_code == 200
    with session_factory()() as db:
        recover(db)
        db.commit()
        assert db.get(Job, job_id).status == 'cancelled'
    assert not remote[0].objects
    assert client.get('/v1/me/usage', headers=auth).json()['balance'] == 100


def test_upgrade_preserves_existing_local_assets_and_attempts(client, png):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from app.assets import read_asset
    from app.db import engine, session_factory
    from app.models import Asset, Attempt
    auth = login(client)
    original = upload(client, auth, png)
    attempt_id = claim_job(create(client, auth, original).json()['id'])
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with engine().begin() as connection:
        config.attributes['connection'] = connection
        command.downgrade(config, '0007')
        command.upgrade(config, 'head')
    with session_factory()() as db:
        asset = db.get(Asset, original)
        assert asset.storage_backend == 'local' and read_asset(asset) == png
        assert db.get(Attempt, attempt_id).output_storage_backend == 'local'


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
