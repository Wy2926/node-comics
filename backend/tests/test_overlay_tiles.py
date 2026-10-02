import hashlib
from io import BytesIO
import json
import struct
from uuid import uuid4

import pytest
from fastapi import HTTPException
from PIL import Image

from app.compute_v3 import verify_output
from app.db import session_factory
from app.models import Job
from app.overlay_tiles import MIME, verify_tiles
from app.translation_requests import TranslationRequest
from conftest import login
from test_compute_v3 import analyze, claim, deliver, request, result_for, text, v3  # noqa: F401


def container(input_sha, width, height, changes=None):
    output = BytesIO()
    Image.new('RGBA', (2, 2), (20, 40, 60, 255)).save(output, 'WEBP', lossless=True)
    data = output.getvalue()
    tile = {'x': 1, 'y': 1, 'width': 2, 'height': 2, 'byte_size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    if changes:
        tile.update(changes)
    manifest = json.dumps({'format': 'overlay-tiles-v1', 'input_sha256': input_sha,
        'width': width, 'height': height, 'tiles': [tile]}, separators=(',', ':')).encode()
    raw = b'NCOT0001' + struct.pack('<I', len(manifest)) + manifest + data
    info = {'sha256': hashlib.sha256(raw).hexdigest(), 'byte_size': len(raw), 'width': width, 'height': height, 'mime': MIME}
    return raw, info


def test_result_format_is_explicit_frozen_and_preserves_legacy_request_identity(v3, png):
    client = v3['client']
    auth = login(client)
    body = {'image': {'sha256': hashlib.sha256(png).hexdigest(), 'byte_size': len(png),
        'content_type': 'image/png', 'normalization_version': 1}, 'mode': 'classic', 'target_language': 'en'}
    legacy_id, tiled_id = str(uuid4()), str(uuid4())
    for key, payload in ((legacy_id, body), (tiled_id, {**body, 'result_format': 'overlay-tiles-v1'})):
        response = client.put('/v1/translations/' + key, headers=auth, json=payload)
        assert response.status_code == 202, response.text
        assert client.put('/v1/translations/' + key, headers=auth, json=payload).json() == response.json()
    assert client.put('/v1/translations/' + legacy_id, headers=auth,
        json={**body, 'result_format': 'overlay-v1', 'priority': 'prefetch'}).status_code == 202
    assert client.put('/v1/translations/' + tiled_id, headers=auth, json=body).status_code == 409
    with session_factory()() as db:
        rows = list(db.query(TranslationRequest).filter(TranslationRequest.id.in_([legacy_id, tiled_id])))
        jobs = {row.id: db.get(Job, row.job_id) for row in rows}
        assert jobs[legacy_id].config.get('result_format') is None
        assert jobs[tiled_id].config['result_format'] == 'overlay-tiles-v1'
        assert jobs[legacy_id].cache_key != jobs[tiled_id].cache_key


def test_old_nodes_keep_ordinary_work_and_new_nodes_deliver_tiles_idempotently(v3, png):
    keys = v3['create'](2)
    with session_factory()() as db:
        job = db.get(Job, keys[0])
        job.config = {**job.config, 'result_format': 'overlay-tiles-v1'}
        row = db.query(TranslationRequest).filter_by(job_id=job.id).first()
        row.descriptor = {**row.descriptor, 'result_format': 'overlay-tiles-v1'}
        db.commit()
    ordinary = claim(v3).json()['leases']
    assert [lease['job_id'] for lease in ordinary] == [keys[1]]
    assert 'result_format' not in ordinary[0]['config']
    assert 'overlay-tiles-v1' not in v3['client'].get('/v1/capabilities').json()['representations']
    response = request(v3, '/nodes/register', {**v3['registration'], 'result_formats': ['overlay-v1', 'overlay-tiles-v1']})
    assert response.status_code == 200, response.text
    assert 'overlay-tiles-v1' in v3['client'].get('/v1/capabilities').json()['representations']
    lease = claim(v3).json()['leases'][0]
    assert lease['job_id'] == keys[0] and lease['config']['result_format'] == 'overlay-tiles-v1'
    analyze(v3, lease)
    text(lease)
    result, _ = result_for(v3, lease, png)
    raw, info = container(result['input_hash'], result['width'], result['height'])
    result.update(representation='overlay-tiles-v1', bbox=None, output=info)
    first = deliver(v3, lease, result, raw)
    assert first.status_code == 200, first.text
    assert deliver(v3, lease, result, raw).json() == first.json()
    with session_factory()() as db:
        job = db.get(Job, keys[0])
        assert job.status == 'succeeded' and job.result_description['representation'] == 'overlay-tiles-v1'
        owner, public_id = job.owner_id, db.query(TranslationRequest).filter_by(job_id=job.id).first().id
    auth = login(v3['client'], 'reader0')
    snapshot = v3['client'].get('/v1/translations/' + public_id, headers=auth).json()
    assert snapshot['result']['representation'] == 'overlay-tiles-v1'
    artifact = v3['client'].get(snapshot['result']['artifact']['path'], headers=auth)
    assert artifact.content == raw and artifact.headers['content-type'] == MIME
    assert v3['client'].get('/v1/translations/' + public_id, headers=login(v3['client'], 'other-reader')).status_code == 404
    regenerate_id = str(uuid4())
    body = {'regenerate_of': public_id}
    regenerated = v3['client'].put('/v1/translations/' + regenerate_id, headers=auth, json=body)
    assert regenerated.status_code == 202, regenerated.text
    assert v3['client'].put('/v1/translations/' + regenerate_id, headers=auth, json=body).json() == regenerated.json()
    with session_factory()() as db:
        row = db.get(TranslationRequest, (owner, regenerate_id))
        assert row.descriptor['result_format'] == 'overlay-tiles-v1'
        assert db.get(Job, row.job_id).config['result_format'] == 'overlay-tiles-v1'


def test_retry_inherits_the_frozen_tile_format_and_rejects_changing_an_ordinary_request(v3, png):
    client, auth = v3['client'], login(v3['client'])
    body = {'image': {'sha256': hashlib.sha256(png).hexdigest(), 'byte_size': len(png),
        'content_type': 'image/png', 'normalization_version': 1}, 'mode': 'classic', 'target_language': 'en'}
    for format in ('overlay-v1', 'overlay-tiles-v1'):
        previous_id, retry_id = str(uuid4()), str(uuid4())
        accepted = client.put('/v1/translations/' + previous_id, headers=auth, json={**body, 'result_format': format})
        assert accepted.status_code == 202, accepted.text
        assert client.post('/v1/translations/' + previous_id + '/cancel', headers=auth).status_code == 200
        retry = client.put('/v1/translations/' + retry_id, headers=auth, json={'retry_of': previous_id})
        assert retry.status_code == 202, retry.text
        with session_factory()() as db:
            row = db.query(TranslationRequest).filter_by(id=retry_id).first()
            assert row.descriptor.get('result_format', 'overlay-v1') == format
            assert db.get(Job, row.job_id).config.get('result_format', 'overlay-v1') == format
        if format == 'overlay-v1':
            denied = client.put('/v1/translations/' + str(uuid4()), headers=auth,
                json={'retry_of': previous_id, 'result_format': 'overlay-tiles-v1'})
            assert denied.status_code == 409 and denied.json()['error']['code'] == 'IDEMPOTENCY_CONFLICT'


@pytest.mark.parametrize('change', [{'x': -1}, {'height': 4097}, {'sha256': 'a' * 64}, {'x': 9}])
def test_tile_artifact_rejects_bad_bounds_and_frozen_hashes(change):
    raw, info = container('a' * 64, 10, 10, change)
    result = {'input_hash': 'a' * 64, 'width': 10, 'height': 10, 'representation': 'overlay-tiles-v1', 'output': info}
    with pytest.raises(HTTPException) as error:
        verify_output(BytesIO(raw), result)
    assert error.value.detail['code'] == 'INVALID_PROVIDER_OUTPUT'


def test_tile_artifact_rejects_extra_bytes_and_wrong_page_identity():
    raw, info = container('a' * 64, 10, 10)
    result = {'input_hash': 'b' * 64, 'width': 10, 'height': 10, 'output': info}
    with pytest.raises(ValueError):
        verify_tiles(BytesIO(raw), result)
    result['input_hash'] = 'a' * 64
    with pytest.raises(ValueError):
        verify_tiles(BytesIO(raw + b'extra'), result)
