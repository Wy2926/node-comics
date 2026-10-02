from conftest import create as create_translation_job
"""Whole-page control lifecycle against an isolated database/object-store adapter."""
import base64
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import BytesIO
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import func, select
from conftest import login, png_variant, upload
from app import classic
from app.adapters.llm import TextResponse
from app.config import settings
from app.db import session_factory
from app.models import Job, TextCall, now
from app.providers import digest
from app.queue_models import ComputeNode, ExecutionLease, JobStage
from app.scheduler import claim_stage
from app.storage import LocalStore
from app.workers import run_control_stage
from test_node_management import provision

PREFIX = '/internal/compute/v3'


def test_node_detailed_timings_are_bounded_and_whitelisted():
    from pydantic import TypeAdapter, ValidationError
    from app.compute_v3 import Timings
    adapter = TypeAdapter(Timings)
    values = {key: .25 for key in ('render_areas', 'render_layout', 'render_diff', 'render_encode',
                                  'detect_lock_wait', 'ocr_lock_wait', 'inpaint_lock_wait')}
    assert adapter.validate_python(values) == values
    for invalid in ({'render_encode': -1}, {'render_layout': float('nan')}, {'not_a_timing': 1}):
        with pytest.raises(ValidationError):
            adapter.validate_python(invalid)


@pytest.fixture
def v3(client, monkeypatch, png):
    monkeypatch.setenv('CLASSIC_ENABLED', 'true')
    settings.cache_clear()
    monkeypatch.setattr(classic, 'call_text', lambda *args: TextResponse(
        '{"translations":{"0":"Hello"}}', {'input_tokens': 10, 'output_tokens': 2}, 'fixture'))
    node, auth, admin = provision(client, 'test:vulkan:0')
    with session_factory()() as db:
        record = db.get(ComputeNode, node['node_id'])
        record.capacity = 4
        record.desired_config = {**record.desired_config, 'execution_slots': 4}
        db.commit()
    registration = {'protocol_version': 3, 'engine_version': 'test-v3', 'resource_id': 'test:vulkan:0',
                    'device': 'fixture', 'ready': True, 'supported_languages': ['en', 'zh-Hans']}
    response = client.post(PREFIX + '/nodes/register', headers=auth, json=registration)
    assert response.status_code == 200, response.text
    assert 'no-store' in response.headers['cache-control']
    state = {'client': client, 'node': node, 'auth': auth, 'admin': admin, 'registration': registration}

    def create(count=1):
        jobs = []
        for index in range(count):
            user = login(client, 'reader' + str(index // 3))
            asset = upload(client, user, png_variant(png, index))
            response = create_translation_job(client, user, asset, key=uuid4().hex, language='en', mode='classic')
            assert response.status_code == 202, response.text
            jobs.append(response.json()['id'])
        return jobs
    state['create'] = create
    return state


def request(v3, path, body):
    return v3['client'].post(PREFIX + path, headers=v3['auth'], json=body)


def claim(v3, count=1, request_id=None):
    return request(v3, f'/nodes/{v3["node"]["node_id"]}/claim',
                   {'request_id': request_id or uuid4().hex, 'config_version': 1, 'count': count})


def encoded(image):
    buffer = BytesIO()
    image.save(buffer, 'PNG')
    return base64.b64encode(buffer.getvalue()).decode()


def analysis_for(lease, *, empty=False):
    meta = lease['input']
    mask = Image.new('L', (meta['width'], meta['height']))
    mask.putpixel((10, 10), 255)
    return {'version': 'test-v3', 'input_hash': meta['sha256'], 'width': meta['width'], 'height': meta['height'],
            'segments': [] if empty else [{'id': '0', 'source': 'Source'}],
            'regions': [] if empty else [{'lines': [[[8, 8], [20, 8], [20, 20], [8, 20]]]}],
            'mask': None if empty else encoded(mask)}


def analyze(v3, lease, empty=False):
    analysis = analysis_for(lease, empty=empty)
    body = {'lease_token': lease['lease_token'], 'analysis': analysis, 'analysis_hash': digest(analysis)}
    response = request(v3, f'/leases/{lease["lease_id"]}/analysis', body)
    assert response.status_code == 200, response.text
    return body, response.json()


def heartbeat(v3, leases, revision=None):
    return request(v3, f'/nodes/{v3["node"]["node_id"]}/heartbeat', {'config_version': 1,
        'leases': [{'lease_id': lease['lease_id'], 'lease_token': lease['lease_token'],
                    'translations_revision': revision, 'phase': 'text'} for lease in leases]})


def text(lease):
    with session_factory()() as db:
        claimed = claim_stage(db, 'control-text', ['text'])
        assert claimed and claimed.job_id == lease['job_id']
        db.commit()
    run_control_stage(claimed.id)


def result_for(v3, lease, png):
    translated = heartbeat(v3, [lease]).json()['leases'][0]['translations']
    image = Image.new('RGBA', (13, 13), (0, 0, 0, 0))
    image.putpixel((2, 2), (1, 2, 3, 255))
    buffer = BytesIO()
    image.save(buffer, 'WEBP', lossless=True)
    data = buffer.getvalue()
    result = {'version': 'test-v3', 'input_hash': lease['input']['sha256'],
            'analysis_hash': translated['analysis_hash'], 'translations_revision': translated['revision'],
            'representation': 'overlay-v1', 'normalization_version': 1,
            'width': lease['input']['width'], 'height': lease['input']['height'],
            'bbox': {'x': 8, 'y': 8, 'width': 13, 'height': 13},
            'output': {'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data),
                       'width': image.width, 'height': image.height, 'mime': 'image/webp'}}
    return result, data


def deliver(v3, lease, result, data=None, *, token=None):
    files = {'metadata': (None, json.dumps({'lease_token': token or lease['lease_token'], 'result': result}),
                          'application/json')}
    if data is not None:
        files['output'] = ('overlay.webp', data, 'image/webp')
    return v3['client'].put(PREFIX + f'/leases/{lease["lease_id"]}/result', headers=v3['auth'], files=files)


def read_input(v3, lease, *, token=None):
    return v3['client'].get(lease['input']['path'],
        headers={**v3['auth'], 'X-Lease-Token': token or lease['lease_token']})


def test_claim_receipt_capacity_shrink_and_restart(v3):
    v3['create'](5)
    response = claim(v3, 4, 'lost-response')
    assert response.status_code == 200, response.text
    leases = response.json()['leases']
    assert len(leases) == 4
    assert claim(v3, 4, 'lost-response').json()['leases'][0]['lease_id'] == leases[0]['lease_id']
    assert claim(v3, 3, 'lost-response').status_code == 409
    assert claim(v3).json()['leases'] == []
    with session_factory()() as db:
        owners = [db.get(ExecutionLease, lease['lease_id']).owner_id for lease in leases]
        assert owners[0] == owners[1]  # FIFO has no per-account election.
        node = db.get(ComputeNode, v3['node']['node_id'])
        node.capacity = 1
        node.desired_config = {**node.desired_config, 'execution_slots': 1}
        node.enabled = False
        db.commit()
    assert all(item['status'] == 'active' for item in heartbeat(v3, leases).json()['leases'])
    resumed = request(v3, '/nodes/register', v3['registration']).json()
    assert len(resumed['leases']) == 4 and not resumed['config']['enabled']
    assert claim(v3).json()['leases'] == []


def test_concurrent_claims_never_exceed_capacity(v3):
    v3['create'](6)
    with ThreadPoolExecutor(4) as pool:
        replies = list(pool.map(lambda _: claim(v3, 4), range(4)))
    assert all(reply.status_code == 200 for reply in replies)
    ids = [lease['lease_id'] for reply in replies for lease in reply.json()['leases']]
    assert len(ids) == len(set(ids)) == 4


def test_no_text_checkpoint_is_terminal_idempotent_and_never_calls_llm(v3):
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    body, reply = analyze(v3, lease, empty=True)
    assert reply['receipt']['job_status'] == 'no_text'
    assert request(v3, f'/leases/{lease["lease_id"]}/analysis', body).json() == reply
    assert heartbeat(v3, [lease]).json()['leases'][0] == reply['receipt']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 0
        assert db.get(ExecutionLease, lease['lease_id']).completed_at


def test_analysis_text_revision_and_delivery_settle_once(v3, png):
    jobs = v3['create']()
    lease = claim(v3).json()['leases'][0]
    body, accepted = analyze(v3, lease)
    assert accepted['receipt'] is None
    assert request(v3, f'/leases/{lease["lease_id"]}/analysis', body).status_code == 200
    changed = {**body['analysis'], 'segments': [{'id': '0', 'source': 'Different'}]}
    assert request(v3, f'/leases/{lease["lease_id"]}/analysis',
        {**body, 'analysis': changed, 'analysis_hash': digest(changed)}).status_code == 409
    text(lease)
    translated = heartbeat(v3, [lease]).json()['leases'][0]['translations']
    assert 'translations' not in heartbeat(v3, [lease], translated['revision']).json()['leases'][0]
    with session_factory()() as db:
        assert db.get(ExecutionLease, lease['lease_id']).completed_at is None
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
    result, data = result_for(v3, lease, png_variant(png, 0))
    response = deliver(v3, lease, result, data)
    assert response.status_code == 200, response.text
    assert response.json()['job_status'] == 'succeeded'
    assert deliver(v3, lease, result, data).json() == response.json()
    assert deliver(v3, lease, {**result, 'version': 'wrong'}, data).status_code == 409
    with session_factory()() as db:
        job = db.get(Job, jobs[0])
        assert job.output_asset_id and job.status == 'succeeded'
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1


@pytest.mark.parametrize('representation', ['overlay-v1', 'original'])
def test_all_empty_translations_deliver_and_settle_once(v3, png, monkeypatch, representation):
    from app.models import Ledger
    jobs = v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    monkeypatch.setattr(classic, 'call_text', lambda *args: TextResponse(
        '{"translations":{"0":""}}', {'input_tokens': 10, 'output_tokens': 2}, 'empty-translation'))
    text(lease)
    translated = heartbeat(v3, [lease]).json()['leases'][0]['translations']
    assert translated['translations'] == {'0': ''}
    result, data = result_for(v3, lease, png)
    if representation == 'original':
        result.update(representation='original', bbox=None, output=None)
        data = None
    response = deliver(v3, lease, result, data)
    assert response.status_code == 200, response.text
    assert response.json()['job_status'] == 'succeeded'
    assert deliver(v3, lease, result, data).json() == response.json()
    with session_factory()() as db:
        job = db.get(Job, jobs[0])
        assert job.status == 'succeeded' and job.settlement == 'settled'
        assert db.scalar(select(func.count()).select_from(TextCall).where(TextCall.job_id == job.id)) == 1
        assert db.scalar(select(func.count()).select_from(Ledger).where(
            Ledger.job_id == job.id, Ledger.kind == 'settle')) == 1


def test_admitted_long_strip_and_tall_overlay_deliver_without_a_second_8192_ceiling(v3):
    source = BytesIO()
    Image.new('RGB', (64, 12000), 'white').save(source, 'PNG')
    user = login(v3['client'], 'long-strip-reader')
    asset = upload(v3['client'], user, source.getvalue())
    created = create_translation_job(v3['client'], user, asset, key=uuid4().hex, language='en', mode='classic')
    assert created.status_code == 202
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, _ = result_for(v3, lease, source.getvalue())
    overlay = BytesIO()
    Image.new('RGBA', (1, 12000), (1, 2, 3, 255)).save(overlay, 'WEBP', lossless=True)
    data = overlay.getvalue()
    result.update(bbox={'x': 10, 'y': 0, 'width': 1, 'height': 12000},
        output={'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data), 'width': 1, 'height': 12000, 'mime': 'image/webp'})
    # Center still checks canvas identity and bounds before decoding/publishing.
    assert deliver(v3, lease, {**result, 'height': 16001}, data).status_code == 422
    response = deliver(v3, lease, result, data)
    assert response.status_code == 200, response.text
    assert response.json()['job_status'] == 'succeeded'
    assert deliver(v3, lease, result, data).json() == response.json()


def test_mixed_heartbeat_cancellation_and_stopped_ack(v3):
    jobs = v3['create'](2)
    leases = claim(v3, 2).json()['leases']
    with session_factory()() as db:
        db.get(Job, leases[0]['job_id']).cancel_requested = True
        db.commit()
    reply = heartbeat(v3, [leases[0], {**leases[1], 'lease_token': 'invalid'}, leases[1]]).json()['leases']
    assert [item['status'] for item in reply] == ['stop', 'stop', 'active']
    assert read_input(v3, leases[0]).status_code == 409
    response = request(v3, f'/leases/{leases[0]["lease_id"]}/complete',
        {'lease_token': leases[0]['lease_token'], 'error': {'code': 'LEASE_STOPPED'}})
    assert response.status_code == 200, response.text
    assert response.json()['job_status'] == 'cancelled'


def test_recovery_reuses_analysis_and_running_text_without_duplicate_call(v3):
    from app.dispatcher import recover_lease
    v3['create']()
    lease = claim(v3, request_id='old-claim').json()['leases'][0]
    analyze(v3, lease)
    with session_factory()() as db:
        text_lease = claim_stage(db, 'control-text', ['text'])
        db.get(ExecutionLease, lease['lease_id']).expires_at = now() - timedelta(seconds=1)
        db.commit()
    recover_lease(lease['lease_id'])
    with session_factory()() as db:
        db.get(JobStage, db.get(ExecutionLease, lease['lease_id']).stage_id).available_at = now()
        db.commit()
    assert claim(v3, request_id='old-claim').json()['leases'][0]['status'] == 'terminal'
    replacement = claim(v3).json()['leases'][0]
    assert replacement['generation'] == lease['generation'] + 1
    assert replacement['analysis'] and replacement['translations'] is None
    run_control_stage(text_lease.id)
    assert heartbeat(v3, [replacement]).json()['leases'][0]['translations']['translations'] == {'0': 'Hello'}
    assert analyze(v3, replacement)[1]['receipt'] is None
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1


def test_deadline_cannot_be_extended_by_heartbeats(v3):
    from app.dispatcher import recover_lease
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    with session_factory()() as db:
        row = db.get(ExecutionLease, lease['lease_id'])
        row.limits = {**row.limits, 'deadline_at': (now() - timedelta(seconds=1)).isoformat() + 'Z'}
        db.commit()
    assert heartbeat(v3, [lease]).json()['leases'][0]['status'] == 'stop'
    reply = request(v3, f'/leases/{lease["lease_id"]}/complete',
        {'lease_token': lease['lease_token'], 'error': {'code': 'LEASE_STOPPED'}})
    assert reply.json()['job_status'] == 'failed'


@pytest.mark.parametrize('code', ['INPUT_INVALID', 'INPUT_MEMORY_EXCEEDED', 'CLASSIC_LAYOUT_OVERFLOW', 'FUTURE_NODE_ERROR_123'])
def test_node_diagnostic_codes_fail_once_and_remain_visible(v3, code):
    from app.models import Ledger
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    body = {'lease_token': lease['lease_token'], 'error': {'code': code}}
    url = f'/leases/{lease["lease_id"]}/complete'
    response = request(v3, url, body)
    assert response.status_code == 200, response.text
    assert response.json()['job_status'] == 'failed'
    assert request(v3, url, body).json() == response.json()
    with session_factory()() as db:
        job = db.get(Job, lease['job_id'])
        assert job.error_code == code and code in job.error_message
        assert job.settlement == 'released'
        stage = db.get(JobStage, db.get(ExecutionLease, lease['lease_id']).stage_id)
        assert stage.status == 'failed' and stage.attempts == 1
        assert db.scalar(select(func.count()).select_from(Ledger).where(
            Ledger.job_id == job.id, Ledger.kind == 'release')) == 1


def test_known_transient_node_error_still_retries(v3):
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    response = request(v3, f'/leases/{lease["lease_id"]}/complete',
                       {'lease_token': lease['lease_token'], 'error': {'code': 'STORAGE_UNAVAILABLE'}})
    assert response.status_code == 200, response.text
    with session_factory()() as db:
        job = db.get(Job, lease['job_id'])
        assert job.status == 'running' and job.settlement == 'reserved'
        stage = db.get(JobStage, db.get(ExecutionLease, lease['lease_id']).stage_id)
        assert stage.status == 'ready'


@pytest.mark.parametrize('code', ['', 'A' * 61, 'bad code', 'ERROR\n', '<script>', '错误'])
def test_node_error_code_rejects_unbounded_or_unsafe_text(code):
    from pydantic import ValidationError
    from app.compute_v3 import NodeError
    with pytest.raises(ValidationError):
        NodeError(code=code)


def test_version_languages_and_direct_input_access(v3):
    v3['create']()
    with session_factory()() as db:
        node = db.get(ComputeNode, v3['node']['node_id'])
        node.supported_languages = ['ko']
        db.commit()
    assert claim(v3).json()['leases'] == []
    with session_factory()() as db:
        node = db.get(ComputeNode, v3['node']['node_id'])
        node.supported_languages = ['en']
        db.commit()
    lease = claim(v3).json()['leases'][0]
    response = read_input(v3, lease)
    assert response.status_code == 200
    assert hashlib.sha256(response.content).hexdigest() == lease['input']['sha256']
    assert 'no-store' in response.headers['cache-control']
    assert read_input(v3, lease, token='invalid').status_code == 403
    assert v3['client'].get(lease['input']['path']).status_code == 401
    assert request(v3, '/nodes/register', {**v3['registration'], 'protocol_version': 2}).status_code == 422
    assert v3['client'].post('/internal/compute/v2/nodes/register', headers=v3['auth'], json=v3['registration']).status_code == 404


def test_result_written_before_lost_commit_is_recovered(v3, png, monkeypatch):
    from app import compute_v3
    from app.assets import asset_storage_key
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, data = result_for(v3, lease, png)
    original = compute_v3.create_asset
    monkeypatch.setattr(compute_v3, 'create_asset', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('simulated crash')))
    with pytest.raises(RuntimeError, match='simulated crash'):
        deliver(v3, lease, result, data)
    assert LocalStore().exists(asset_storage_key(lease['lease_id'], 'classic'))
    monkeypatch.setattr(compute_v3, 'create_asset', original)
    with session_factory()() as db:
        db.get(ExecutionLease, lease['lease_id']).expires_at = now() - timedelta(seconds=1)
        db.commit()
    with session_factory()() as db:
        assert compute_v3.recover_compute_results(db) == 1
        db.commit()
    reply = deliver(v3, lease, result, data)
    assert reply.status_code == 200 and reply.json()['job_status'] == 'succeeded'
    with session_factory()() as db:
        from app.models import Asset, Ledger
        job = db.get(Job, lease['job_id'])
        source = db.get(Asset, job.input_asset_id)
        assert not LocalStore().exists(source.storage_key)
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.job_id == job.id, Ledger.kind == 'settle')) <= 1


def test_upload_is_scoped_frozen_and_validates_container_metadata(v3, png):
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, data = result_for(v3, lease, png)
    assert deliver(v3, lease, result, data, token='wrong').status_code == 403
    assert deliver(v3, lease, {**result, 'image': 'bytes forbidden'}, data).status_code == 422
    assert deliver(v3, lease, {**result, 'bbox': {**result['bbox'], 'x': 9999}}, data).status_code == 422
    assert deliver(v3, lease, result, data + b'garbage').status_code == 422
    # Failed transmission freezes identity; correct bytes of that result remain retryable.
    assert deliver(v3, lease, {**result, 'output': {**result['output'], 'sha256': 'a'*64}}, data).status_code == 409
    response = deliver(v3, lease, result, data)
    assert response.status_code == 200 and response.json()['job_status'] == 'succeeded'


def test_identity_result_has_no_file_and_retains_success(v3, png):
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, _ = result_for(v3, lease, png)
    result.update(representation='original', bbox=None, output=None)
    reply = deliver(v3, lease, result)
    assert reply.status_code == 200 and reply.json()['job_status'] == 'succeeded'
    assert deliver(v3, lease, result).json() == reply.json()
    with session_factory()() as db:
        job = db.get(Job, lease['job_id'])
        assert job.output_asset_id is None and job.result_description['representation'] == 'original'


def test_late_direct_upload_cannot_publish_after_cancel_or_new_generation(v3, png):
    from app.dispatcher import recover_lease
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, data = result_for(v3, lease, png)
    with session_factory()() as db:
        db.get(ExecutionLease, lease['lease_id']).expires_at = now() - timedelta(seconds=1)
        db.commit()
    recover_lease(lease['lease_id'])
    with session_factory()() as db:
        db.get(JobStage, db.get(ExecutionLease, lease['lease_id']).stage_id).available_at = now()
        db.commit()
    replacement = claim(v3).json()['leases'][0]
    assert replacement['generation'] == lease['generation'] + 1
    assert replacement['translations']
    assert deliver(v3, lease, result, data).status_code == 409
    with session_factory()() as db:
        job = db.get(Job, lease['job_id'])
        assert job.output_asset_id is None
        job.cancel_requested = True
        db.commit()
    assert deliver(v3, replacement, result, data).status_code == 409


def test_cancellation_during_file_publish_never_settles(v3, png, monkeypatch):
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, data = result_for(v3, lease, png)
    original = LocalStore.put_file
    def cancelling(*args, **kwargs):
        original(*args, **kwargs)
        with session_factory()() as db:
            db.get(Job, lease['job_id']).cancel_requested = True
            db.commit()
    monkeypatch.setattr(LocalStore, 'put_file', cancelling)
    assert deliver(v3, lease, result, data).status_code == 409
    with session_factory()() as db:
        assert db.get(Job, lease['job_id']).output_asset_id is None
        assert db.get(Job, lease['job_id']).settlement == 'reserved'


@pytest.mark.parametrize('deadline', ['deadline_at', 'delivery_deadline_at', 'expires_at'])
def test_verification_finishing_after_deadline_is_never_recovered(v3, png, monkeypatch, deadline):
    from app import compute_v3
    from app.assets import asset_storage_key
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, data = result_for(v3, lease, png)
    verify = compute_v3.verify_output

    def expiring(*args):
        verify(*args)
        with session_factory()() as db:
            record = db.get(ExecutionLease, lease['lease_id'])
            elapsed = now() - timedelta(seconds=1)
            if deadline == 'expires_at':
                record.expires_at = elapsed
            else:
                record.limits = {**record.limits, deadline: compute_v3.stamp(elapsed)}
            db.commit()

    monkeypatch.setattr(compute_v3, 'verify_output', expiring)
    reply = deliver(v3, lease, result, data)
    assert reply.status_code in {409, 422}, reply.text
    assert not LocalStore().exists(asset_storage_key(lease['lease_id'], 'classic'))
    monkeypatch.setattr(compute_v3, 'verify_output', verify)
    with session_factory()() as db:
        record = db.get(ExecutionLease, lease['lease_id'])
        assert 'delivery_received_at' not in record.limits
        record.expires_at = now() - timedelta(seconds=1)
        db.commit()
    with session_factory()() as db:
        assert compute_v3.recover_compute_results(db) == 0
        assert db.get(Job, lease['job_id']).output_asset_id is None
        assert db.get(Job, lease['job_id']).settlement == 'reserved'


@pytest.mark.parametrize('crash', [False, True])
def test_timely_received_result_can_publish_or_recover_after_deadline(v3, png, monkeypatch, crash):
    from app import compute_v3
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, data = result_for(v3, lease, png)
    cutoff = now() + timedelta(seconds=30)
    with session_factory()() as db:
        record = db.get(ExecutionLease, lease['lease_id'])
        record.limits = {**record.limits, 'deadline_at': compute_v3.stamp(cutoff)}
        record.expires_at = cutoff
        db.commit()
    publish = LocalStore.put_file

    def slow_publish(*args, **kwargs):
        publish(*args, **kwargs)
        # Move only the clock: the accepted processing deadlines stay immutable.
        monkeypatch.setattr(compute_v3, 'now', lambda: cutoff + timedelta(seconds=300))
        if crash:
            raise RuntimeError('crash after durable file before final transaction')

    monkeypatch.setattr(LocalStore, 'put_file', slow_publish)
    if crash:
        with pytest.raises(RuntimeError, match='after durable file'):
            deliver(v3, lease, result, data)
        with session_factory()() as db:
            record = db.get(ExecutionLease, lease['lease_id'])
            assert compute_v3.accepted_delivery(record)
            assert record.completed_at is None
            assert compute_v3.recover_compute_results(db) == 1
            db.commit()
    else:
        response = deliver(v3, lease, result, data)
        assert response.status_code == 200, response.text
    reply = deliver(v3, lease, result, data)
    assert reply.status_code == 200 and reply.json()['job_status'] == 'succeeded'
    with session_factory()() as db:
        assert compute_v3.recover_compute_results(db) == 0


def test_invalid_identity_file_has_no_accepted_receipt_to_recover(v3, png):
    from app import compute_v3
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, data = result_for(v3, lease, png)
    result.update(representation='original', bbox=None, output=None)
    assert deliver(v3, lease, result, data).status_code == 422
    with session_factory()() as db:
        record = db.get(ExecutionLease, lease['lease_id'])
        assert 'delivery_received_at' not in record.limits
        record.expires_at = now() - timedelta(seconds=1)
        db.commit()
    with session_factory()() as db:
        assert compute_v3.recover_compute_results(db) == 0
        assert db.get(Job, lease['job_id']).status == 'running'


def test_identity_receipt_survives_crash_before_final_commit(v3, png, monkeypatch):
    from app import compute_v3
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, _ = result_for(v3, lease, png)
    result.update(representation='original', bbox=None, output=None)
    commit = compute_v3.commit_result
    monkeypatch.setattr(compute_v3, 'commit_result', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('crash')))
    with pytest.raises(RuntimeError, match='crash'):
        deliver(v3, lease, result)
    monkeypatch.setattr(compute_v3, 'commit_result', commit)
    with session_factory()() as db:
        db.get(ExecutionLease, lease['lease_id']).expires_at = now() - timedelta(seconds=1)
        db.commit()
    with session_factory()() as db:
        assert compute_v3.recover_compute_results(db) == 1
        db.commit()
    assert deliver(v3, lease, result).json()['job_status'] == 'succeeded'


def test_accepted_publish_grace_is_fixed_and_stop_cannot_revoke_it(v3, png, monkeypatch):
    from app import compute_v3
    from app.dispatcher import recover_lease
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, data = result_for(v3, lease, png)
    received = []

    def interrupted(*args, **kwargs):
        with session_factory()() as db:
            record = db.get(ExecutionLease, lease['lease_id'])
            received.append((record.limits['delivery_received_at'], record.expires_at))
            assert record.expires_at == compute_v3.parsed(record.limits['delivery_persist_deadline_at'])
        # No file yet: maintenance must leave this accepted publish alone.
        recover_lease(lease['lease_id'])
        raise RuntimeError('local disk interrupted')

    monkeypatch.setattr(LocalStore, 'put_file', interrupted)
    for _ in range(2):
        with pytest.raises(RuntimeError, match='local disk interrupted'):
            deliver(v3, lease, result, data)
        assert heartbeat(v3, [lease]).json()['leases'][0]['status'] == 'active'
    assert received[0] == received[1]
    with session_factory()() as db:
        record = db.get(ExecutionLease, lease['lease_id'])
        assert record.completed_at is None and record.expires_at == received[0][1]
        # Natural page expiry occurs while the server is publishing the body.
        record.limits = {**record.limits, 'deadline_at': compute_v3.stamp(now() + timedelta(seconds=1))}
        db.commit()
    monkeypatch.setattr(compute_v3, 'now', lambda: now() + timedelta(seconds=2))
    reply = request(v3, f'/leases/{lease["lease_id"]}/complete',
        {'lease_token': lease['lease_token'], 'error': {'code': 'LEASE_STOPPED'}})
    assert reply.status_code == 503, reply.text
    with session_factory()() as db:
        record = db.get(ExecutionLease, lease['lease_id'])
        assert record.completed_at is None and record.expires_at == received[0][1]


def test_result_multipart_total_timeout_closes_partial_file(v3, monkeypatch):
    import asyncio
    from fastapi import HTTPException
    from starlette.requests import Request
    from starlette import formparsers
    from app import compute_v3
    monkeypatch.setenv('UPLOAD_BODY_TIMEOUT_SECONDS', '.1')
    settings.cache_clear()
    opened = []
    spool = formparsers.SpooledTemporaryFile

    def tracked(*args, **kwargs):
        handle = spool(*args, **kwargs)
        opened.append(handle)
        return handle

    monkeypatch.setattr(formparsers, 'SpooledTemporaryFile', tracked)
    header = (b'--compute\r\nContent-Disposition: form-data; name="output"; filename="overlay.webp"\r\n'
              b'Content-Type: image/webp\r\n\r\n')

    async def exercise():
        calls = 0

        async def receive():
            nonlocal calls
            calls += 1
            if calls == 1:
                return {'type': 'http.request', 'body': header, 'more_body': True}
            # Keep making progress: the total timeout must still bound the body.
            await asyncio.sleep(.02)
            return {'type': 'http.request', 'body': b'x', 'more_body': True}

        request = Request({'type': 'http', 'method': 'PUT', 'path': '/',
            'headers': [(b'content-type', b'multipart/form-data; boundary=compute')]}, receive)
        started = asyncio.get_running_loop().time()
        with pytest.raises(HTTPException) as error:
            await compute_v3.deliver_result('lease', request, v3['node']['node_id'])
        assert error.value.status_code == 408 and error.value.detail['code'] == 'UPLOAD_TIMEOUT'
        assert asyncio.get_running_loop().time() - started < 1
        assert calls > 2

    asyncio.run(exercise())
    assert len(opened) == 1 and opened[0].closed
    from app.result_ingress import acquire_result_ingress, release_result_ingress
    slots = [acquire_result_ingress() for _ in range(settings().cluster_result_ingress_concurrency)]
    for slot in slots:
        release_result_ingress(slot)


def test_result_ingress_full_rejects_before_reading_multipart(v3, monkeypatch):
    import asyncio
    from fastapi import HTTPException
    from starlette.requests import Request
    from app import compute_v3, result_ingress
    from app.storage import StorageError

    async def busy():
        raise StorageError('RESULT_INGRESS_BUSY')

    monkeypatch.setattr(result_ingress, 'begin_result_ingress', busy)

    async def receive():
        pytest.fail('Admission must precede body consumption')

    request = Request({'type': 'http', 'method': 'PUT', 'path': '/', 'headers': []}, receive)
    with pytest.raises(HTTPException) as error:
        asyncio.run(compute_v3.deliver_result('lease', request, v3['node']['node_id']))
    assert error.value.status_code == 503
    assert error.value.detail['code'] == 'RESULT_INGRESS_BUSY'
    assert error.value.headers['Retry-After'] == '2'


def test_overlay_limit_is_independent_of_original_upload_limit(v3, png, monkeypatch):
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, data = result_for(v3, lease, png)
    monkeypatch.setenv('MAX_UPLOAD_BYTES', '1')
    settings.cache_clear()
    assert len(data) > settings().max_upload_bytes
    response = deliver(v3, lease, result, data)
    assert response.status_code == 200, response.text


def test_overlay_larger_than_cluster_result_limit_is_rejected(v3, png, monkeypatch):
    import random
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    result, _ = result_for(v3, lease, png)
    image = Image.frombytes('RGB', (40, 40), random.Random(72).randbytes(40 * 40 * 3))
    stream = BytesIO()
    image.save(stream, 'WEBP', lossless=True)
    data = stream.getvalue()
    result.update(bbox={'x': 0, 'y': 0, 'width': 40, 'height': 40}, output={
        'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data),
        'width': 40, 'height': 40, 'mime': 'image/webp'})
    monkeypatch.setenv('CLUSTER_MAX_RESULT_BYTES', '1024')
    settings.cache_clear()
    assert len(data) > 1024
    response = deliver(v3, lease, result, data)
    assert response.status_code in {413, 422}, response.text
    with session_factory()() as db:
        assert db.get(Job, lease['job_id']).output_asset_id is None
        assert db.get(Job, lease['job_id']).settlement == 'reserved'
