"""Whole-page control lifecycle against an isolated database/object-store adapter."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import BytesIO
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import func, select
from conftest import login, png_variant, submit_asset, upload
from app import classic
from app.adapters.text import TextResponse
from app.config import settings
from app.db import session_factory
from app.models import ClassicState, Job, Ledger, TextCall, now
from app.providers import digest
from app.queue_models import ComputeNode, ExecutionLease, JobStage
from app.scheduler import claim_stage
from app.storage import LocalStore
from app.workers import run_control_stage
from test_node_management import provision

PREFIX = '/internal/compute/v2'


@pytest.fixture
def v2(client, monkeypatch, png):
    monkeypatch.setenv('CLASSIC_ENABLED', 'true')
    monkeypatch.setenv('CLASSIC_ENGINE_VERSION', 'test-v2')
    settings.cache_clear()
    # An explicit test storage adapter. Production local storage cannot sign URLs.
    monkeypatch.setattr(LocalStore, 'download_url', lambda self, key, ttl: 'https://r2.example.test/' + key + '?signature=test')
    monkeypatch.setattr(classic, 'call_text', lambda *args: TextResponse(
        '{"translations":[{"id":"0","text":"Hello"}]}', {'input_tokens': 10, 'output_tokens': 2}, 'fixture'))
    node, auth, admin = provision(client, 'test:vulkan:0')
    with session_factory()() as db:
        record = db.get(ComputeNode, node['node_id'])
        record.capacity = 4
        record.desired_config = {**record.desired_config, 'execution_slots': 4}
        db.commit()
    registration = {'protocol_version': 2, 'engine_version': 'test-v2', 'resource_id': 'test:vulkan:0',
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
            response = submit_asset(client, user, asset, key=uuid4().hex, language='en', mode='classic')
            assert response.status_code == 202, response.text
            jobs.append(response.json()['items'][0]['job']['id'])
        return jobs
    state['create'] = create
    return state


def request(v2, path, body):
    return v2['client'].post(PREFIX + path, headers=v2['auth'], json=body)


def claim(v2, count=1, request_id=None):
    return request(v2, f'/nodes/{v2["node"]["node_id"]}/claim',
                   {'request_id': request_id or uuid4().hex, 'config_version': 1, 'count': count})


def encoded(image):
    buffer = BytesIO()
    image.save(buffer, 'PNG')
    return base64.b64encode(buffer.getvalue()).decode()


def analysis_for(lease, *, empty=False):
    meta = lease['input']
    mask = Image.new('L', (meta['width'], meta['height']))
    mask.putpixel((10, 10), 255)
    return {'version': 'test-v2', 'input_hash': meta['sha256'], 'width': meta['width'], 'height': meta['height'],
            'segments': [] if empty else [{'id': '0', 'source': 'Source'}],
            'regions': [] if empty else [{'lines': [[[8, 8], [20, 8], [20, 20], [8, 20]]]}],
            'mask': None if empty else encoded(mask)}


def analyze(v2, lease, empty=False):
    analysis = analysis_for(lease, empty=empty)
    body = {'lease_token': lease['lease_token'], 'analysis': analysis, 'analysis_hash': digest(analysis)}
    response = request(v2, f'/leases/{lease["lease_id"]}/analysis', body)
    assert response.status_code == 200, response.text
    return body, response.json()


def heartbeat(v2, leases, revision=None):
    return request(v2, f'/nodes/{v2["node"]["node_id"]}/heartbeat', {'config_version': 1,
        'leases': [{'lease_id': lease['lease_id'], 'lease_token': lease['lease_token'],
                    'translations_revision': revision, 'phase': 'text'} for lease in leases]})


def text(lease):
    with session_factory()() as db:
        claimed = claim_stage(db, 'control-text', ['text'])
        assert claimed and claimed.job_id == lease['job_id']
        db.commit()
    run_control_stage(claimed.id)


def result_for(v2, lease, png):
    translated = heartbeat(v2, [lease]).json()['leases'][0]['translations']
    mask = Image.new('L', (lease['input']['width'], lease['input']['height']))
    mask.putpixel((10, 10), 255)
    image = Image.open(BytesIO(png)).convert('RGB')
    image.putpixel((10, 10), (1, 2, 3))
    return {'version': 'test-v2', 'input_hash': lease['input']['sha256'],
            'analysis_hash': translated['analysis_hash'], 'translations_revision': translated['revision'],
            'image': encoded(image), 'mask': encoded(mask), 'glyph_mask': encoded(mask)}


def test_claim_receipt_capacity_fairness_shrink_and_restart(v2):
    v2['create'](5)
    response = claim(v2, 4, 'lost-response')
    assert response.status_code == 200, response.text
    leases = response.json()['leases']
    assert len(leases) == 4
    assert claim(v2, 4, 'lost-response').json()['leases'][0]['lease_id'] == leases[0]['lease_id']
    assert claim(v2, 3, 'lost-response').status_code == 409
    assert claim(v2).json()['leases'] == []
    with session_factory()() as db:
        owners = [db.get(ExecutionLease, lease['lease_id']).owner_id for lease in leases]
        assert owners[0] != owners[1]
        node = db.get(ComputeNode, v2['node']['node_id'])
        node.capacity = 1
        node.desired_config = {**node.desired_config, 'execution_slots': 1}
        node.enabled = False
        db.commit()
    assert all(item['status'] == 'active' for item in heartbeat(v2, leases).json()['leases'])
    resumed = request(v2, '/nodes/register', v2['registration']).json()
    assert len(resumed['leases']) == 4 and not resumed['config']['enabled']
    assert claim(v2).json()['leases'] == []


def test_concurrent_claims_never_exceed_capacity(v2):
    v2['create'](6)
    with ThreadPoolExecutor(4) as pool:
        replies = list(pool.map(lambda _: claim(v2, 4), range(4)))
    assert all(reply.status_code == 200 for reply in replies)
    ids = [lease['lease_id'] for reply in replies for lease in reply.json()['leases']]
    assert len(ids) == len(set(ids)) == 4


def test_no_text_checkpoint_is_terminal_idempotent_and_never_calls_llm(v2):
    v2['create']()
    lease = claim(v2).json()['leases'][0]
    body, reply = analyze(v2, lease, empty=True)
    assert reply['receipt']['job_status'] == 'no_text'
    assert request(v2, f'/leases/{lease["lease_id"]}/analysis', body).json() == reply
    assert heartbeat(v2, [lease]).json()['leases'][0] == reply['receipt']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 0
        assert db.get(ExecutionLease, lease['lease_id']).completed_at


def test_analysis_text_revision_and_delivery_settle_once(v2, png):
    jobs = v2['create']()
    lease = claim(v2).json()['leases'][0]
    body, accepted = analyze(v2, lease)
    assert accepted['receipt'] is None
    assert request(v2, f'/leases/{lease["lease_id"]}/analysis', body).status_code == 200
    changed = {**body['analysis'], 'segments': [{'id': '0', 'source': 'Different'}]}
    assert request(v2, f'/leases/{lease["lease_id"]}/analysis',
        {**body, 'analysis': changed, 'analysis_hash': digest(changed)}).status_code == 409
    text(lease)
    translated = heartbeat(v2, [lease]).json()['leases'][0]['translations']
    assert 'translations' not in heartbeat(v2, [lease], translated['revision']).json()['leases'][0]
    with session_factory()() as db:
        assert db.get(ExecutionLease, lease['lease_id']).completed_at is None
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
    result = result_for(v2, lease, png_variant(png, 0))
    body = {'lease_token': lease['lease_token'], 'result': result}
    path = f'/leases/{lease["lease_id"]}/complete'
    response = request(v2, path, body)
    assert response.status_code == 200, response.text
    assert response.json()['job_status'] == 'succeeded'
    assert request(v2, path, body).json() == response.json()
    assert request(v2, path, {**body, 'result': {**result, 'version': 'wrong'}}).status_code == 409
    with session_factory()() as db:
        job = db.get(Job, jobs[0])
        assert job.output_asset_id and job.status == 'succeeded'
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1


def test_mixed_heartbeat_cancellation_and_stopped_ack(v2):
    jobs = v2['create'](2)
    leases = claim(v2, 2).json()['leases']
    with session_factory()() as db:
        db.get(Job, leases[0]['job_id']).cancel_requested = True
        db.commit()
    reply = heartbeat(v2, [leases[0], {**leases[1], 'lease_token': 'invalid'}, leases[1]]).json()['leases']
    assert [item['status'] for item in reply] == ['stop', 'stop', 'active']
    assert request(v2, f'/leases/{leases[0]["lease_id"]}/input/authorize',
                   {'lease_token': leases[0]['lease_token']}).status_code == 409
    response = request(v2, f'/leases/{leases[0]["lease_id"]}/complete',
        {'lease_token': leases[0]['lease_token'], 'error': {'code': 'LEASE_STOPPED'}})
    assert response.status_code == 200, response.text
    assert response.json()['job_status'] == 'cancelled'


def test_recovery_reuses_analysis_and_running_text_without_duplicate_call(v2):
    from app.dispatcher import recover_lease
    v2['create']()
    lease = claim(v2, request_id='old-claim').json()['leases'][0]
    analyze(v2, lease)
    with session_factory()() as db:
        text_lease = claim_stage(db, 'control-text', ['text'])
        db.get(ExecutionLease, lease['lease_id']).expires_at = now() - timedelta(seconds=1)
        db.commit()
    recover_lease(lease['lease_id'])
    with session_factory()() as db:
        db.get(JobStage, db.get(ExecutionLease, lease['lease_id']).stage_id).available_at = now()
        db.commit()
    assert claim(v2, request_id='old-claim').json()['leases'][0]['status'] == 'terminal'
    replacement = claim(v2).json()['leases'][0]
    assert replacement['generation'] == lease['generation'] + 1
    assert replacement['analysis'] and replacement['translations'] is None
    run_control_stage(text_lease.id)
    assert heartbeat(v2, [replacement]).json()['leases'][0]['translations']['translations'] == {'0': 'Hello'}
    assert analyze(v2, replacement)[1]['receipt'] is None
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1


def test_deadline_cannot_be_extended_by_heartbeats(v2):
    from app.dispatcher import recover_lease
    v2['create']()
    lease = claim(v2).json()['leases'][0]
    with session_factory()() as db:
        row = db.get(ExecutionLease, lease['lease_id'])
        row.limits = {**row.limits, 'deadline_at': (now() - timedelta(seconds=1)).isoformat() + 'Z'}
        db.commit()
    assert heartbeat(v2, [lease]).json()['leases'][0]['status'] == 'stop'
    reply = request(v2, f'/leases/{lease["lease_id"]}/complete',
        {'lease_token': lease['lease_token'], 'error': {'code': 'LEASE_STOPPED'}})
    assert reply.json()['job_status'] == 'failed'


def test_version_languages_and_r2_authorization_do_not_probe_objects(v2, monkeypatch):
    v2['create']()
    with session_factory()() as db:
        node = db.get(ComputeNode, v2['node']['node_id'])
        node.desired_config = {**node.desired_config, 'allowed_languages': ['ko']}
        db.commit()
    assert claim(v2).json()['leases'] == []
    with session_factory()() as db:
        node = db.get(ComputeNode, v2['node']['node_id'])
        node.desired_config = {**node.desired_config, 'allowed_languages': ['en']}
        db.commit()
    lease = claim(v2).json()['leases'][0]
    from app.models import Asset
    from app import compute_v2
    with session_factory()() as db:
        db.get(Asset, db.get(Job, lease['job_id']).input_asset_id).storage_backend = 'r2'
        db.commit()
    class SigningOnly:
        def download_url(self, key, ttl):
            assert 0 < ttl <= 60
            return 'https://r2.example.test/signed'
        def exists(self, key):
            pytest.fail('unexpected object probe')
    monkeypatch.setattr(compute_v2, 'get_store', lambda _: SigningOnly())
    response = request(v2, f'/leases/{lease["lease_id"]}/input/authorize', {'lease_token': lease['lease_token']})
    assert response.status_code == 200 and response.json()['sha256'] == lease['input']['sha256']
    assert 'no-store' in response.headers['cache-control']


def test_result_written_before_lost_commit_is_recovered(v2, png, monkeypatch):
    from app import workers
    from app.dispatcher import recover_lease
    v2['create']()
    lease = claim(v2).json()['leases'][0]
    analyze(v2, lease)
    text(lease)
    result = result_for(v2, lease, png_variant(png, 0))
    original = workers.create_asset
    monkeypatch.setattr(workers, 'create_asset', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('simulated crash')))
    with pytest.raises(RuntimeError, match='simulated crash'):
        request(v2, f'/leases/{lease["lease_id"]}/complete', {'lease_token': lease['lease_token'], 'result': result})
    monkeypatch.setattr(workers, 'create_asset', original)
    with session_factory()() as db:
        db.get(ExecutionLease, lease['lease_id']).expires_at = now() - timedelta(seconds=1)
        db.commit()
    recover_lease(lease['lease_id'])
    reply = request(v2, f'/leases/{lease["lease_id"]}/complete', {'lease_token': lease['lease_token'], 'result': result})
    assert reply.status_code == 200, reply.text
    assert reply.json()['job_status'] == 'succeeded'
