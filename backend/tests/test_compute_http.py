"""Real HTTP API, worker, maintenance and two separate compute-agent processes.

Only the image engine and text provider are synthetic. All database state,
uploads, authentication, leases, heartbeat, failover and result delivery use the
actual application protocol. No model or provider request leaves localhost.
"""
from contextlib import contextmanager
from datetime import datetime
import hashlib
from io import BytesIO
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

import httpx
from PIL import Image
import pytest

ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / 'tests' / 'compute_http_server.py'
AGENT = ROOT.parent / 'services' / 'compute-agent' / 'agent.py'


def until(predicate, *, timeout=30, label='condition'):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.1)
    pytest.fail('Timed out waiting for ' + label)


def rows(database, statement, parameters=()):
    with sqlite3.connect(database, timeout=10) as connection:
        return connection.execute(statement, parameters).fetchall()


def image(index):
    page = Image.new('RGB', (80, 64), (255, 255, 255))
    page.putpixel((0, 0), (index, 0, 0))
    data = BytesIO()
    page.save(data, 'PNG')
    return data.getvalue()


@contextmanager
def cluster(tmp_path, *, text_gate=None):
    database = tmp_path / 'http-cluster.db'
    version = 'mit-95227a2-classic-v5-cluster'
    environment = {**os.environ, 'PYTHONPATH': str(ROOT), 'PYTHONUNBUFFERED': '1',
        'DATABASE_URL': 'sqlite:///' + database.as_posix(), 'STORAGE_PATH': str(tmp_path / 'objects'),
        'DEV_AUTH': 'true', 'DEV_AUTH_SECRET': 'isolated-http-auth-key-no-product-access',
        'RESULT_STORAGE_BACKEND': 'local', 'R2_ENDPOINT_URL': '', 'PROVIDERS_JSON': '[]', 'OPENAI_API_KEY': '',
        'CLASSIC_ENABLED': 'true', 'CLASSIC_ENGINE_VERSION': version,
        'CLUSTER_LEASE_SECONDS': '10', 'CLUSTER_NODE_TIMEOUT_SECONDS': '10',
        'CLUSTER_TEXT_SLOTS': '2', 'CLUSTER_UPLOAD_SLOTS': '2', 'CLUSTER_REDRAW_SLOTS': '1',
        'DISPATCH_INTERVAL_SECONDS': '1', 'CONTROL_ALLOW_HTTP': 'true',
        'ENGINE_TOKEN': 'isolated-http-engine-token', 'NODE_POLL_SECONDS': '.05',
        'NODE_HEARTBEAT_SECONDS': '.2', 'NODE_REQUEST_SECONDS': '3', 'NODE_STAGE_SECONDS': '30'}
    children, outputs = [], []
    if text_gate:
        environment.update(TEST_TEXT_GATE=str(text_gate), CLUSTER_MAX_IMAGE_STAGES='1')
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

    def start(name, args, **extra):
        output = (tmp_path / (name + '-' + str(len(children)) + '.log')).open('w', encoding='utf-8')
        outputs.append(output)
        child = subprocess.Popen([sys.executable, *map(str, args)], env={**environment, **extra}, cwd=tmp_path,
                                 stdout=output, stderr=subprocess.STDOUT, creationflags=flags)
        children.append(child)
        return child

    def live(path):
        try:
            response = httpx.get(path, timeout=.5, trust_env=False)
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    def start_http(name, role, **extra):
        ready_path = tmp_path / (name + '.port')
        child = start(name, [ENTRY, role, ready_path], **extra)

        def ready_port():
            if child.poll() is not None:
                pytest.fail(f'{name} exited before publishing its listening port; inspect {name} process log')
            return int(ready_path.read_text(encoding='ascii')) if ready_path.is_file() else None

        return until(ready_port, label=name + ' bound HTTP socket')

    identities = {}
    engine_ports = {}

    def agent(index):
        selected = engine_ports[index]
        return start('agent-' + str(index), [AGENT], NODE_ID=identities[index]['node_id'],
                     NODE_TOKEN=identities[index]['token'], ENGINE_URL=f'http://127.0.0.1:{selected}')

    try:
        control_port = start_http('control', 'api')
        control = f'http://127.0.0.1:{control_port}'
        environment['CONTROL_URL'] = control
        until(lambda: live(control + '/health'), label='isolated control HTTP readiness')
        with httpx.Client(base_url=control, trust_env=False) as admin:
            auth = admin.post('/v1/auth/dev', json={'username': 'admin'}).raise_for_status().json()
            admin.headers['Authorization'] = 'Bearer ' + auth['access_token']
            for index in (1, 2):
                identities[index] = admin.post('/v1/admin/compute-nodes', json={
                    'name': 'HTTP test node ' + str(index), 'resource_id': 'http-machine-' + str(index) + ':cpu',
                    'config': {'poll_seconds': .05, 'heartbeat_seconds': .2, 'config_poll_seconds': 1,
                               'request_seconds': 3, 'stage_seconds': 30}}).raise_for_status().json()
        for index in (1, 2):
            selected = engine_ports[index] = start_http('engine-' + str(index), 'engine',
                ENGINE_RESOURCE_ID='http-machine-' + str(index) + ':cpu')
            until(lambda: live(f'http://127.0.0.1:{selected}/health'), label='simulated engine readiness')
        assert httpx.get(control + '/health/ready', timeout=5, trust_env=False).status_code == 503
        start('worker', [ENTRY, 'worker'])
        maintenance = start('maintenance', [ENTRY, 'maintenance'])
        first, second = agent(1), agent(2)
        until(lambda: len(rows(database, "SELECT id FROM compute_nodes WHERE engine_version != 'control' AND applied_config_version=1")) == 2,
              label='both actual agents registered')
        until(lambda: live(control + '/health/ready'), label='all durable service heartbeats ready')
        yield {'url': control, 'database': database, 'first': first, 'second': second, 'agent': agent,
               'first_engine': f'http://127.0.0.1:{engine_ports[1]}', 'second_engine': f'http://127.0.0.1:{engine_ports[2]}',
               'identities': identities, 'maintenance': maintenance,
               'restart_maintenance': lambda: start('maintenance', [ENTRY, 'maintenance'])}
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        for child in reversed(children):
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        for output in outputs:
            output.close()


def submit(client, auth, pages, key):
    response = client.post('/v1/translation-submissions', headers={**auth, 'Idempotency-Key': key}, json={
        'mode': 'classic', 'target_language': 'zh-Hans', 'max_quota_pages': len(pages),
        'items': [{'client_item_id': str(index), 'image_sha256': hashlib.sha256(data).hexdigest(),
                   'byte_size': len(data), 'content_type': 'image/png'} for index, data in enumerate(pages)]})
    assert response.status_code == 202, response.text
    result = response.json()
    for item, data in zip(result['items'], pages):
        upload = item['upload']
        sent = client.put(upload['url'], content=data, headers={**auth, **upload['headers']})
        assert sent.status_code == 200, sent.text
        accepted = client.post('/v1/uploads/' + upload['id'] + '/complete', headers=auth)
        assert accepted.status_code == 200, accepted.text
    return [item['job']['id'] for item in result['items']]


def test_health_detects_actual_maintenance_exit_and_restart(tmp_path):
    with cluster(tmp_path) as running, httpx.Client(base_url=running['url'], timeout=5, trust_env=False) as client:
        assert client.get('/health/ready').status_code == 200
        running['maintenance'].terminate()
        running['maintenance'].wait(timeout=5)
        until(lambda: client.get('/health/ready').status_code == 503, timeout=15,
              label='maintenance process heartbeat expired')
        assert client.get('/health/live').status_code == 200
        assert client.get('/health/ready').json()['checks']['maintenance'] == 'unavailable'
        running['restart_maintenance']()
        until(lambda: client.get('/health/ready').status_code == 200, label='restarted maintenance heartbeat')


def job_statuses(client, auth, ids):
    response = client.post('/v1/jobs/status', headers=auth, json={'ids': ids})
    assert response.status_code == 200, response.text
    result = response.json()['items']
    assert not any(row['status'] in {'failed', 'cancelled', 'outcome_unknown'} for row in result), result
    return result if all(row['status'] == 'succeeded' for row in result) else None


def test_single_real_agent_keeps_preparing_pages_while_text_pool_is_blocked(tmp_path):
    gate = tmp_path / 'release-text'
    with cluster(tmp_path, text_gate=gate) as running, httpx.Client(base_url=running['url'], timeout=5, trust_env=False) as client:
        running['second'].terminate()
        running['second'].wait(timeout=5)
        login = client.post('/v1/auth/dev', json={'username': 'slow-text-reader'}).raise_for_status()
        auth = {'Authorization': 'Bearer ' + login.json()['access_token']}
        try:
            ids = submit(client, auth, [image(i+30) for i in range(3)], 'slow-text-batch')
            until(lambda: rows(running['database'], "SELECT count(*) FROM job_stages WHERE name='inpaint' AND status='succeeded'")[0][0] == 3,
                  timeout=25, label='all image preparation before any text returns')
            assert rows(running['database'], "SELECT count(*) FROM job_stages WHERE name='text' AND status='succeeded'")[0][0] == 0
            assert rows(running['database'], "SELECT count(*) FROM jobs WHERE status='succeeded'")[0][0] == 0
            assert rows(running['database'], "SELECT count(*) FROM execution_leases WHERE node_id=? AND completed_at IS NULL", (running['identities'][1]['node_id'],))[0][0] == 0
        finally:
            gate.touch()
        completed = until(lambda: job_statuses(client, auth, ids), label='late text renders all prepared pages')
        assert len(completed) == 3
        assert rows(running['database'], "SELECT count(*) FROM usage_ledger WHERE kind='settle'")[0][0] == 3


def test_two_real_agents_complete_http_pipeline_and_recover_killed_renderer(tmp_path):
    with cluster(tmp_path) as running, httpx.Client(base_url=running['url'], timeout=5, trust_env=False) as client:
        login = client.post('/v1/auth/dev', json={'username': 'http-reader'})
        assert login.status_code == 200, login.text
        auth = {'Authorization': 'Bearer ' + login.json()['access_token']}
        denied = client.post('/internal/nodes/http-node-1/claim', headers=auth, json={'stages': ['analyze']})
        assert denied.status_code == 401
        initial = submit(client, auth, [image(index) for index in range(3)], 'http-initial')
        completed = until(lambda: job_statuses(client, auth, initial), label='first HTTP batch delivery')
        nodes = {row[0] for row in rows(running['database'],
            "SELECT DISTINCT node_id FROM execution_leases WHERE node_id LIKE 'node-%' AND outcome='succeeded'")}
        assert nodes == {item['node_id'] for item in running['identities'].values()}
        for job in completed:
            delivered = client.get('/v1/images/' + job['output_asset_id'] + '/content', headers=auth)
            assert delivered.status_code == 200
            with Image.open(BytesIO(delivered.content)) as final:
                assert final.size == (80, 64) and final.getpixel((10, 10)) == (0, 0, 0)

        # Leave only node 1 claiming, then hold a render after paid text has been
        # persisted. Kill the actual agent while its heartbeat is keeping it live.
        running['second'].terminate()
        running['second'].wait(timeout=5)
        assert httpx.post(running['first_engine'] + '/test/hold/render', trust_env=False).status_code == 200
        target = submit(client, auth, [image(20)], 'http-failover')[0]
        def held_lease():
            result = rows(running['database'], "SELECT l.id,l.started_at,l.expires_at FROM execution_leases l JOIN job_stages s ON s.id=l.stage_id WHERE l.job_id=? AND l.node_id=? AND s.name='render' AND l.completed_at IS NULL", (target, running['identities'][1]['node_id']))
            if result and httpx.get(running['first_engine'] + '/test/state', trust_env=False).json()['active'] == 'render':
                return result[0]
        old = until(held_lease, label='node 1 holding render')
        def heartbeat_extended():
            current = rows(running['database'], 'SELECT expires_at FROM execution_leases WHERE id=?', (old[0],))[0][0]
            return (datetime.fromisoformat(current) - datetime.fromisoformat(old[2])).total_seconds() > .3
        until(heartbeat_extended, timeout=5, label='real HTTP lease heartbeat')
        assert rows(running['database'], 'SELECT count(*) FROM text_calls WHERE job_id=?', (target,))[0][0] == 1
        running['first'].kill()
        running['first'].wait(timeout=5)
        running['agent'](2)
        final = until(lambda: job_statuses(client, auth, [target]), timeout=35, label='node 2 lease recovery and delivery')[0]
        recovered = rows(running['database'], "SELECT l.node_id,l.generation,l.outcome FROM execution_leases l JOIN job_stages s ON s.id=l.stage_id WHERE l.job_id=? AND s.name='render' ORDER BY l.generation", (target,))
        assert recovered == [(running['identities'][1]['node_id'], 1, 'failed'), (running['identities'][2]['node_id'], 2, 'succeeded')]
        assert rows(running['database'], 'SELECT count(*) FROM text_calls WHERE job_id=?', (target,))[0][0] == 1
        assert final['result_available'] and final['settlement'] == 'settled'
        assert rows(running['database'], "SELECT count(*) FROM usage_ledger WHERE job_id=? AND kind='settle'", (target,))[0][0] == 1
        calls = httpx.get(running['second_engine'] + '/test/state', trust_env=False).json()['calls']
        assert any(call['stage'] == 'render' and call['scope'] == target and call['has_analysis'] and call['has_translations'] for call in calls)
