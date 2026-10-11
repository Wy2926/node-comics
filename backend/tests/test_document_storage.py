from concurrent.futures import ThreadPoolExecutor
import gc
from io import BytesIO
import hashlib
from threading import Barrier
from time import sleep
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from weakref import ref as weakref

import pytest
from botocore.exceptions import ClientError
from pydantic import SecretStr

from app.documents.config import DocumentSettings, MAX_SOURCE_BYTES
from app.documents.storage import DocumentStore, DocumentStoreError


def configured(**options):
    return DocumentSettings(_env_file=None, enabled=True,
        r2_endpoint_url='https://isolated.r2.cloudflarestorage.com', r2_bucket='test',
        r2_access_key_id='test-key', r2_secret_access_key='test-secret', **options)


class R2:
    def __init__(self):
        self.objects, self.uploads, self.calls = {}, {}, []
        self.closed = 0

    def close(self):
        self.closed += 1

    def head_object(self, *, Bucket, Key):
        if Key not in self.objects:
            raise ClientError({'Error': {'Code': 'NoSuchKey'}}, 'HeadObject')
        data, mime, metadata = self.objects[Key]
        return {'ContentLength': len(data), 'ContentType': mime, 'Metadata': metadata, 'ETag': '"revision-not-sha"'}

    def get_object(self, **kwargs):
        self.calls.append(('get', kwargs['Key']))
        return {**self.head_object(Bucket=kwargs['Bucket'], Key=kwargs['Key']),
                'Body': BytesIO(self.objects[kwargs['Key']][0])}

    def create_multipart_upload(self, **kwargs):
        identity = 'upload-' + str(len(self.uploads) + 1)
        self.uploads[identity] = {'parts': {}, **kwargs}
        return {'UploadId': identity}

    def upload_part(self, **kwargs):
        body = kwargs['Body']
        data = body.read() if hasattr(body, 'read') else body
        self.uploads[kwargs['UploadId']]['parts'][kwargs['PartNumber']] = data
        self.calls.append(('part', len(data)))
        return {'ETag': f'part-{kwargs["PartNumber"]}'}

    def list_parts(self, **kwargs):
        if kwargs['UploadId'] not in self.uploads:
            raise ClientError({'Error': {'Code': 'NoSuchUpload'}}, 'ListParts')
        return {'Parts': [{'PartNumber': number, 'ETag': f'part-{number}', 'Size': len(data)}
                          for number, data in sorted(self.uploads[kwargs['UploadId']]['parts'].items())]}

    def complete_multipart_upload(self, **kwargs):
        self.calls.append(('complete', kwargs['MultipartUpload']))
        upload = self.uploads.pop(kwargs['UploadId'])
        data = b''.join(upload['parts'][part['PartNumber']] for part in kwargs['MultipartUpload']['Parts'])
        self.objects[kwargs['Key']] = data, upload['ContentType'], upload.get('Metadata', {})
        return {'ETag': 'multipart-not-a-sha256'}

    def abort_multipart_upload(self, **kwargs):
        self.calls.append(('abort', kwargs['UploadId']))
        self.uploads.pop(kwargs['UploadId'], None)

    def put_object(self, **kwargs):
        if kwargs['Key'] in self.objects:
            raise ClientError({'Error': {'Code': 'PreconditionFailed'}}, 'PutObject')
        body = kwargs['Body']
        data = body.read() if hasattr(body, 'read') else body
        self.objects[kwargs['Key']] = data, kwargs['ContentType'], kwargs['Metadata']
        self.calls.append(('put', len(data)))
        return {}


@pytest.fixture
def storage():
    client = R2()
    return DocumentStore(configured(), client=client), client


@pytest.fixture
def process_store(monkeypatch):
    import boto3
    from app.documents import storage as module
    config, clients = configured(), []

    def build(*args, **kwargs):
        sleep(.01)  # Allow simultaneous first callers to contend for initialization.
        client = R2()
        clients.append(client)
        return client

    monkeypatch.setattr(module, '_store', None)
    monkeypatch.setattr(module, 'get_document_settings', lambda: config)
    monkeypatch.setattr(boto3, 'Session', lambda: SimpleNamespace(client=build))
    return module, config, clients


def test_process_store_reuses_one_thread_safe_client(process_store):
    module, _, clients = process_store
    ready = Barrier(8)

    def initialize(_):
        store = module.get_document_store()
        ready.wait(timeout=5)
        return store, store.client

    with ThreadPoolExecutor(8) as pool:
        values = list(pool.map(initialize, range(8)))
    assert len(clients) == 1
    assert all(store is module.get_document_store() and client is clients[0] for store, client in values)


@pytest.mark.parametrize(('field', 'value'), [
    ('r2_bucket', 'other-bucket'), ('r2_key_prefix', 'isolated/other-run'),
    ('r2_endpoint_url', 'https://other.r2.cloudflarestorage.com'),
    ('r2_access_key_id', SecretStr('replacement-test-key')),
    ('r2_secret_access_key', SecretStr('replacement-test-secret')),
    ('signed_url_seconds', 60), ('max_output_bytes', 1024), ('enabled', False),
])
def test_configuration_change_does_not_close_a_store_still_in_use(process_store, field, value):
    module, config, clients = process_store
    old = module.get_document_store()
    old_client, original_value = old.client, getattr(old.config, field)
    setattr(config, field, value)
    replacement = module.get_document_store()
    assert replacement is not old and getattr(replacement.config, field) == value
    assert getattr(old.config, field) == original_value
    assert old.client is old_client and old_client.closed == 0
    if config.enabled:
        assert replacement.client is not old_client and len(clients) == 2
    else:
        with pytest.raises(DocumentStoreError, match='DOCUMENT_STORAGE_DISABLED'):
            replacement.client
        assert len(clients) == 1
    reference = weakref(old)
    del old
    gc.collect()
    assert reference() is None and old_client.closed == 1


def test_equivalent_reloaded_settings_keep_the_same_pool(process_store, monkeypatch):
    module, _, clients = process_store
    original = module.get_document_store()
    original.client
    monkeypatch.setattr(module, 'get_document_settings', configured)
    assert module.get_document_store() is original and len(clients) == 1


def test_injected_clients_are_not_closed_by_store_lifecycle():
    client = R2()
    store = DocumentStore(configured(), client=client)
    assert store.client is client
    del store
    gc.collect()
    assert client.closed == 0


def test_disabled_channel_never_uses_sdk():
    store = DocumentStore(DocumentSettings(_env_file=None))
    with pytest.raises(DocumentStoreError, match='DOCUMENT_STORAGE_DISABLED'):
        store.head('documents/input/job/upload/source')


def test_secret_fields_do_not_leak_and_configuration_is_opt_in():
    settings = configured()
    assert 'test-secret' not in repr(settings)
    assert 'test-key' not in repr(settings)
    assert DocumentSettings(_env_file=None).enabled is False


@pytest.mark.parametrize('key', ['documents', 'documents/work', 'documents/work/job/../escape',
    'documents/work/job//x', '/documents/work/job/x', 'another/work/job/x', 'documents/work/job/C:x'])
def test_reject_unsafe_or_foreign_namespace_keys(storage, key):
    store, _ = storage
    with pytest.raises(DocumentStoreError, match='DOCUMENT_INVALID_OBJECT'):
        store.head(key)


def test_source_completion_uses_server_parts_and_exact_expected_sizes(storage):
    store, client = storage
    key = store.key('input', 'job', 'generation', 'source')
    upload = store.create_multipart(key, 'application/zip')
    client.uploads[upload]['parts'][1] = b'content'
    result = store.complete_multipart(key, upload, expected_size=7)
    assert result['byte_size'] == 7 and 'sha256' not in result
    assert client.calls[-1][0] == 'complete'
    assert not any(call[0] == 'get' for call in client.calls)
    # A lost completion response replays from the sealed object, not a new upload.
    assert store.complete_multipart(key, upload, expected_size=7) == result


def test_source_completion_rejects_size_or_part_tampering(storage):
    store, client = storage
    key = store.key('input', 'job', 'generation', 'source')
    upload = store.create_multipart(key, 'application/zip')
    client.uploads[upload]['parts'][1] = b'oversized'
    with pytest.raises(DocumentStoreError, match='DOCUMENT_UPLOAD_SIZE_MISMATCH'):
        store.complete_multipart(key, upload, expected_size=3)
    assert key not in client.objects
    with pytest.raises(DocumentStoreError, match='DOCUMENT_SOURCE_TOO_LARGE'):
        store.complete_multipart(key, upload, expected_size=MAX_SOURCE_BYTES + 1)


def test_presigned_inputs_are_multipart_and_outputs_are_conditional():
    store = DocumentStore(configured())
    source = store.key('input', 'job', 'generation', 'source')
    signed = store.presign_upload_part(source, 'upload', 1, byte_size=12)
    headers = parse_qs(urlsplit(signed['url']).query)['X-Amz-SignedHeaders'][0]
    assert 'content-length' in headers
    assert signed['headers'] == {}  # Browser supplies its own Content-Length for the Blob.
    output = {'key': store.key('work', 'job', 'lease', 'image.png'), 'sha256': 'a' * 64,
              'byte_size': 12, 'mime': 'image/png'}
    signed = store.presign_put(output)
    assert signed['headers']['If-None-Match'] == '*'
    headers = parse_qs(urlsplit(signed['url']).query)['X-Amz-SignedHeaders'][0]
    assert all(value in headers for value in ('if-none-match', 'content-length', 'x-amz-meta-sha256'))
    with pytest.raises(DocumentStoreError, match='DOCUMENT_INPUT_MULTIPART_REQUIRED'):
        store.presign_put({**output, 'key': source})


def test_verify_is_head_only_and_rejects_unverified_digest(storage):
    store, client = storage
    key = store.key('work', 'job', 'lease', 'x')
    client.objects[key] = b'abc', 'image/png', {'sha256': 'a' * 64}
    ref = {'key': key, 'sha256': 'a' * 64, 'byte_size': 3, 'mime': 'image/png'}
    assert store.verify(ref)['etag'] == '"revision-not-sha"'
    assert client.calls == []
    with pytest.raises(DocumentStoreError, match='DOCUMENT_OBJECT_MISMATCH'):
        store.verify({**ref, 'sha256': 'b' * 64})


def test_get_hash_verification_and_existing_destination_preservation(storage, tmp_path):
    store, client = storage
    key = store.key('work', 'job', 'lease', 'x')
    client.objects[key] = b'abc', 'image/png', {'sha256': 'a' * 64}
    ref = {'key': key, 'sha256': 'a' * 64, 'byte_size': 3, 'mime': 'image/png'}
    target = tmp_path / 'result'
    with pytest.raises(DocumentStoreError, match='DOCUMENT_OBJECT_MISMATCH'):
        store.get_to_file(ref, target)
    assert not target.exists()
    target.touch()
    with pytest.raises(FileExistsError):
        store.get_to_file(ref, target)
    assert target.exists() and target.stat().st_size == 0


def test_large_worker_output_uses_bounded_parts_and_replay_does_not_overwrite(tmp_path):
    client = R2()
    store = DocumentStore(configured(upload_part_bytes=5 * 1024 * 1024), client=client)
    target = tmp_path / 'output.zip'
    target.write_bytes(b'x' * (5 * 1024 * 1024 + 200))
    key = store.key('output', 'job', 'lease', 'translated.zip')
    ref = store.put_file(key, target, 'application/zip')
    assert [call[1] for call in client.calls if call[0] == 'part'] == [5 * 1024 * 1024, 200]
    before = len(client.calls)
    assert store.put_file(key, target, 'application/zip') == ref
    assert len(client.calls) == before
    target.write_bytes(b'y' * (5 * 1024 * 1024 + 200))
    with pytest.raises(DocumentStoreError, match='DOCUMENT_OBJECT_MISMATCH'):
        store.put_file(key, target, 'application/zip')
    assert hashlib.sha256(client.objects[key][0]).hexdigest() == ref['sha256']


def test_json_bounds_and_content_checks(storage):
    store, _ = storage
    key = store.key('work', 'job', 'lease', 'text.json')
    ref = store.put_json(key, {'x': '文本'})
    assert store.get_json(ref) == {'x': '文本'}
    with pytest.raises(DocumentStoreError, match='DOCUMENT_JSON_TOO_LARGE'):
        store.put_json(key, {'x': 'large'}, maximum=1)


def test_sdk_errors_do_not_expose_secrets(storage):
    store, client = storage
    def failure(**kwargs):
        raise RuntimeError('https://secret-url/?token=credential')
    client.head_object = failure
    with pytest.raises(DocumentStoreError) as caught:
        store.head(store.key('work', 'job', 'lease', 'x'))
    assert str(caught.value) == 'DOCUMENT_STORAGE_UNAVAILABLE'
