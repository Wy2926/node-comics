"""Run the native Windows cluster, optionally translate one real sample through R2.

Private configuration stays in process environments. The image engine receives
only its own token and device settings. Existing paid tasks are resumed by ID.
"""
import argparse
from contextlib import contextmanager
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

import httpx
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / 'backend'
ENGINE = ROOT / 'services/classic-engine'
PYTHON = BACKEND / '.venv/Scripts/python.exe'
ENGINE_PYTHON = ENGINE / '.venv/Scripts/python.exe'
ENTRY = Path(__file__).resolve()


def require_free(port):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', port))


def wait_http(url, children, ready=False):
    until = time.monotonic() + 180
    while time.monotonic() < until:
        if any(child.poll() is not None for child in children):
            raise RuntimeError('A service exited; inspect the local service log')
        try:
            value = httpx.get(url + '/health', timeout=2, trust_env=False)
            if value.status_code == 200 and (not ready or value.json().get('ready')):
                return value.json()
        except httpx.HTTPError:
            pass
        time.sleep(.5)
    raise RuntimeError('Service readiness timed out')


@contextmanager
def cluster(folder, api_port, engine_port, device='cuda:0', engine_config=None):
    from dotenv import dotenv_values
    require_free(api_port)
    require_free(engine_port)
    folder.mkdir(parents=True, exist_ok=True)
    config = {**dotenv_values(ROOT / '.env'), **dotenv_values(ROOT / 'deploy/.env.local')}
    if not config.get('ADMIN_WEB_PATH'):
        raise RuntimeError('Configure ADMIN_WEB_PATH in deploy/.env.local before starting the local node')
    # Preserve the original and final images in R2; only test metadata is local.
    secret_file = folder / 'local-auth.json'
    if not secret_file.exists():
        secret_file.write_text(json.dumps({'auth': secrets.token_hex(32), 'engine': secrets.token_hex(32),
                                          'r2_prefix': 'node-comics-node-validation/' + uuid.uuid4().hex + '/'}), encoding='utf-8')
    tokens = json.loads(secret_file.read_text())
    url, engine_url = f'http://127.0.0.1:{api_port}', f'http://127.0.0.1:{engine_port}'
    common = {**os.environ, 'PYTHONUNBUFFERED': '1', 'PYTHONIOENCODING': 'utf-8'}
    control_env = {**common, **{k: v for k, v in config.items() if v is not None},
                   'PYTHONPATH': str(BACKEND), 'DATABASE_URL': 'sqlite:///' + (folder / 'cluster.db').as_posix(),
                   'STORAGE_PATH': str(folder / 'transient'), 'RESULT_STORAGE_BACKEND': 'r2',
                   'APP_ENV': 'development', 'DEV_AUTH': 'true', 'DEV_AUTH_SECRET': tokens['auth'], 'PROVIDERS_JSON': '[]',
                   'OPENAI_API_KEY': '', 'R2_KEY_PREFIX': tokens['r2_prefix'],
                   'CLASSIC_ENABLED': 'true',
                   'CLASSIC_ENGINE_VERSION': 'mit-95227a2-classic-v4-dml-v8-qt-roi' if device.startswith('directml') else 'mit-95227a2-classic-v9-qt-roi',
                   'DISPATCH_INTERVAL_SECONDS': '1'}
    # Explicit allowlist: do not forward credentials inherited from the caller.
    runtime_env = {k: v for k, v in common.items() if k.upper() in {
        'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
        'PROGRAMFILES', 'PROGRAMDATA', 'COMSPEC', 'PATHEXT', 'PYTHONUNBUFFERED', 'PYTHONIOENCODING'}}
    machine_path = engine_config.resolve() if engine_config else folder / 'engine.json'
    if not machine_path.exists():
        machine_path.write_text(json.dumps({
            'schema_version': 1, 'profile': 'mit-directml' if device.startswith('directml') else 'mit',
            'device': device, 'resource_id': socket.gethostname() + ':' + device,
            'model_dir': str(ROOT/'engines/mit-models'),
            'font': str(ROOT/'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc'),
            'lock_dir': str(ROOT/'engines/device-locks'), 'torch_interop_threads': 1,
            'inpaint_workers': 2 if device.startswith('directml') else 1,
            'runtime': {'languages': ['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko', 'fr', 'es', 'pt-BR', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id'],
                        'torch_threads': 4, 'opencv_threads': 2, 'cache_bytes': 268435456,
                        'cache_ttl_seconds': 900}}, indent=2), encoding='utf-8')
    engine_env = {**runtime_env, 'PYTHONPATH': os.pathsep.join([str(ENGINE), str(ROOT/'engines/mit-native')]),
                  'ENGINE_CONFIG_FILE': str(machine_path), 'ENGINE_TOKEN': tokens['engine'],
                  'ENGINE_PROFILE_DIR': str(folder / 'profiles'), 'ENGINE_STOP_FILE': str(folder / 'engine.stop')}
    agent_path = folder / 'node.json'
    agent_env = {**runtime_env, 'NODE_CONFIG_FILE': str(agent_path)}
    children, handles = [], []
    (folder / 'engine.stop').unlink(missing_ok=True)
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

    def start(name, python, arguments, env):
        output = (folder / (name + '.log')).open('w', encoding='utf-8')
        handles.append(output)
        child = subprocess.Popen([str(python), *map(str, arguments)], cwd=folder, env=env,
                                 stdout=output, stderr=subprocess.STDOUT, creationflags=flags)
        children.append(child)
        return child

    try:
        image_process = start('engine', ENGINE_PYTHON, [ENTRY, '--engine-process', '--engine-port', engine_port], engine_env)
        health = wait_http(engine_url, children, True)
        control_env['CLASSIC_ENGINE_VERSION'] = health['version']
        start('api', PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', api_port, '--no-access-log'], control_env)
        wait_http(url, children)
        with httpx.Client(base_url=url, trust_env=False, timeout=30) as admin:
            auth = admin.post('/v1/auth/dev', json={'username': 'admin'}).raise_for_status().json()
            admin.headers['Authorization'] = 'Bearer ' + auth['access_token']
            if not agent_path.exists():
                node = admin.post('/v1/admin/compute-nodes', json={'name': 'Local ' + health['device'],
                    'resource_id': health['resource_id'], 'config': {'execution_slots': 1}}).raise_for_status().json()
                agent_path.write_text(json.dumps({'schema_version': 1, 'control_url': url, 'allow_http': True,
                    'node_id': node['node_id'], 'node_token': node['token'], 'engine_url': engine_url,
                    'engine_token': tokens['engine']}, indent=2), encoding='utf-8')
        start('worker', PYTHON, ['-m', 'app.workers'], control_env)
        start('maintenance', PYTHON, ['-m', 'app.dispatcher'], control_env)
        start('agent', ENGINE_PYTHON, [ROOT / 'services/compute-agent/agent.py'], agent_env)
        print(json.dumps({'event': 'CLUSTER_READY', 'api': url, 'engine': engine_url,
                          'device': health['device'], 'model_version': health['version']}, ensure_ascii=False), flush=True)
        print(f'Text suppliers are managed at {url}{config["ADMIN_WEB_PATH"]}#translation-providers (local username: admin). '
              'Create an enabled default supplier before submitting classic translations.', flush=True)
        yield url, engine_url, health, children
    finally:
        # Let Uvicorn save device execution evidence and close model resources.
        (folder / 'engine.stop').touch()
        if 'image_process' in locals():
            try:
                image_process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                pass
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        for handle in handles:
            handle.close()


def wait_text_provider(url, children):
    """Let the operator create DB configuration while all local services stay up."""
    with httpx.Client(base_url=url, timeout=30, trust_env=False) as admin:
        auth = admin.post('/v1/auth/dev', json={'username': 'admin'}).raise_for_status().json()
        admin.headers['Authorization'] = 'Bearer ' + auth['access_token']
        announced = False
        while True:
            if any(child.poll() is not None for child in children):
                raise RuntimeError('A cluster service exited while waiting for a text supplier')
            providers = admin.get('/v1/admin/translation-providers').raise_for_status().json()['items']
            if any(provider['enabled'] and provider['is_default'] for provider in providers):
                return
            if not announced:
                print('Waiting for an enabled default text supplier in the admin console shown at startup. '
                      'The first supplier becomes default automatically; smoke translation will then continue.', flush=True)
                announced = True
            time.sleep(1)


def smoke(folder, url, engine_url, health, image):
    from submission_client import submit_page, download
    record = folder / 'operation.json'
    raw = image.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    state = json.loads(record.read_text()) if record.exists() else {'key': str(uuid.uuid4()), 'source_sha256': digest}
    if state['source_sha256'] != digest:
        raise RuntimeError('This run directory belongs to a different image')
    if state.get('job_id'):
        with sqlite3.connect(folder / 'cluster.db') as database:
            saved = database.execute('SELECT config FROM jobs WHERE id=?', (state['job_id'],)).fetchone()
        if not saved or json.loads(saved[0])['engine']['version'] != health['version']:
            raise RuntimeError('This run directory belongs to a different model version')
    record.write_text(json.dumps(state), encoding='utf-8')
    start = time.monotonic()
    with httpx.Client(base_url=url, timeout=90, trust_env=False) as client:
        token = client.post('/v1/auth/dev', json={'username': 'node-validation'}).raise_for_status().json()['access_token']
        client.headers['Authorization'] = 'Bearer ' + token
        if not state.get('job_id'):
            job = submit_page(client, raw, state['key'], 'classic')
            state['job_id'] = job['id']
            record.write_text(json.dumps(state), encoding='utf-8')
        previous = None
        while time.monotonic() - start < 1200:
            job = client.get('/v1/jobs/' + state['job_id']).raise_for_status().json()
            if (job['status'], job['phase']) != previous:
                previous = job['status'], job['phase']
                print(json.dumps({'event': 'PAGE', 'status': job['status'], 'phase': job['phase'], 'error': job.get('error')}, ensure_ascii=False), flush=True)
            if job['status'] in {'succeeded', 'failed', 'cancelled', 'no_text'}:
                break
            time.sleep(1)
        (folder / 'job.json').write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding='utf-8')
        if job['status'] != 'succeeded':
            raise RuntimeError('Page did not succeed: ' + job['status'])
        detail = client.get('/v1/jobs/' + state['job_id'] + '/classic').raise_for_status().json()
        (folder / 'stages.json').write_text(json.dumps(detail, ensure_ascii=False, indent=2), encoding='utf-8')
        result = download(client, job['output_asset_id'])
        original = download(client, job['input_asset_id'])
        if original != raw:
            raise RuntimeError('Stored original differs from input')
        with Image.open(BytesIO(result)) as picture:
            picture.load()
            size = picture.size
        with Image.open(BytesIO(raw)) as picture:
            if size != picture.size:
                raise RuntimeError('Result size mismatch')
        (folder / 'original.png').write_bytes(original)
        (folder / 'result.png').write_bytes(result)
        with sqlite3.connect(folder / 'cluster.db') as db:
            calls = [dict(zip(['model','usage','accounted_micros','cost_state','error_code'], row)) for row in db.execute(
                'SELECT model,usage,accounted_micros,cost_state,error_code FROM text_calls WHERE job_id=?', (job['id'],))]
            stages = [dict(zip(['name','status'], row)) for row in db.execute(
                'SELECT name,status FROM job_stages WHERE job_id=?', (job['id'],))]
            storage = db.execute('SELECT storage_backend FROM assets WHERE id IN (?,?)', (job['input_asset_id'],job['output_asset_id'])).fetchall()
        health = httpx.get(engine_url + '/health', timeout=5, trust_env=False).raise_for_status().json()
        report = {'status': job['status'], 'engine': health, 'dimensions': list(size),
                  'elapsed_seconds': round(time.monotonic() - start, 3), 'segments': len(detail['segments']),
                  'translations': len(detail['translations']), 'timings': detail['timings'], 'quality_flags': job.get('quality_flags', []),
                  'text_calls': calls, 'stages': stages, 'storage': [row[0] for row in storage],
                  'source_sha256': digest, 'result_sha256': hashlib.sha256(result).hexdigest()}
        (folder / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'event': 'TRANSLATION_COMPLETE', 'segments': report['segments'], 'timings': report['timings'],
                          'result': str(folder/'result.png')}, ensure_ascii=False), flush=True)


def verify_configuration(folder, url, engine_url):
    """Exercise real polling/engine updates; restore the operator's initial values."""
    node_id = json.loads((folder / 'node.json').read_text())['node_id']
    path = '/v1/admin/compute-nodes/' + node_id + '/config'
    records = []
    with httpx.Client(base_url=url, trust_env=False, timeout=30) as client:
        auth = client.post('/v1/auth/dev', json={'username': 'admin'}).raise_for_status().json()
        client.headers['Authorization'] = 'Bearer ' + auth['access_token']
        initial = client.get(path).raise_for_status().json()
        def save(config, enabled):
            current = client.get(path).raise_for_status().json()
            return client.put(path, json={'expected_version': current['version'], 'name': initial['name'],
                'enabled': enabled, 'config': config}).raise_for_status().json()
        def applied(desired):
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                current = client.get(path).raise_for_status().json()
                if current['applied_version'] == desired['version'] and not current['config_error']:
                    health = httpx.get(engine_url + '/health', trust_env=False, timeout=10).raise_for_status().json()
                    records.append({'version': current['version'], 'enabled': current['enabled'],
                        'execution_slots': current['config']['execution_slots'], 'engine': health['runtime']})
                    return current, health
                time.sleep(.25)
            raise RuntimeError('Live node configuration did not apply')
        try:
            changed = {**initial['config'], 'execution_slots': 2, 'config_poll_seconds': 1,
                       'engine': {'languages': ['zh-Hans', 'en'], 'torch_threads': 2, 'opencv_threads': 1}}
            current, health = applied(save(changed, True))
            assert health['runtime']['torch_threads'] == 2 and health['runtime']['opencv_threads'] == 1
            assert health['supported_languages'] == ['zh-Hans', 'en']
            current, _ = applied(save(changed, False))
            assert current['enabled'] is False
        finally:
            applied(save(initial['config'], initial['enabled']))
        (folder / 'config-validation.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
        print(json.dumps({'event': 'LIVE_CONFIG_VERIFIED', 'updates': len(records)}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--smoke', action='store_true', help='Translate one page using the configured paid text provider')
    parser.add_argument('--verify-config', action='store_true', help='Validate real live configuration without creating translation jobs')
    parser.add_argument('--image', type=Path, default=ROOT/'samples/starlight-bookshop.png')
    parser.add_argument('--directory', type=Path, default=ROOT/'private-test-data/local-cuda-nodes')
    parser.add_argument('--api-port', type=int, default=18088)
    parser.add_argument('--engine-port', type=int, default=18090)
    parser.add_argument('--device', default='cuda:0', help='cuda:0, directml:0 or cpu')
    parser.add_argument('--engine-config', type=Path, help='Machine JSON file; runtime language and performance settings')
    parser.add_argument('--engine-process', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.engine_process:
        import uvicorn
        server = uvicorn.Server(uvicorn.Config('server:app', host='127.0.0.1', port=args.engine_port, access_log=False))
        def watch():
            while not server.should_exit:
                if Path(os.environ['ENGINE_STOP_FILE']).exists():
                    server.should_exit = True
                    return
                time.sleep(.25)
        threading.Thread(target=watch, daemon=True).start()
        server.run()
        return
    with cluster(args.directory.resolve(), args.api_port, args.engine_port, args.device, args.engine_config) as (url, engine_url, health, children):
        if args.smoke:
            wait_text_provider(url, children)
            smoke(args.directory.resolve(), url, engine_url, health, args.image)
        if args.verify_config:
            verify_configuration(args.directory.resolve(), url, engine_url)
        if not (args.smoke or args.verify_config):
            try:
                while True:
                    if any(child.poll() is not None for child in children):
                        raise RuntimeError('A cluster service exited; inspect the local service log')
                    time.sleep(1)
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    main()
