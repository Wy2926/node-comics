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
def cluster(folder, api_port, engine_port):
    from dotenv import dotenv_values
    require_free(api_port)
    require_free(engine_port)
    folder.mkdir(parents=True, exist_ok=True)
    config = {**dotenv_values(ROOT / '.env'), **dotenv_values(ROOT / 'deploy/.env.local')}
    if not config.get('TEXT_API_KEY'):
        config['TEXT_API_KEY'] = config.get('OPENAI_API_KEY', '')
        config['TEXT_BASE_URL'] = config.get('OPENAI_BASE_URL', '')
    if not config.get('TEXT_API_KEY') or not config.get('TEXT_BASE_URL'):
        raise RuntimeError('Configure TEXT_API_KEY and TEXT_BASE_URL in the private environment')
    config.setdefault('TEXT_MODEL', 'gpt-5.6-luna')
    # Preserve the original and final images in R2; only test metadata is local.
    secret_file = folder / 'local-auth.json'
    if not secret_file.exists():
        secret_file.write_text(json.dumps({'auth': secrets.token_hex(32), 'node': secrets.token_hex(32),
                                          'engine': secrets.token_hex(32)}), encoding='utf-8')
    tokens = json.loads(secret_file.read_text())
    url, engine_url = f'http://127.0.0.1:{api_port}', f'http://127.0.0.1:{engine_port}'
    common = {**os.environ, 'PYTHONUNBUFFERED': '1', 'PYTHONIOENCODING': 'utf-8'}
    control_env = {**common, **{k: v for k, v in config.items() if v is not None},
                   'PYTHONPATH': str(BACKEND), 'DATABASE_URL': 'sqlite:///' + (folder / 'cluster.db').as_posix(),
                   'STORAGE_PATH': str(folder / 'transient'), 'RESULT_STORAGE_BACKEND': 'r2',
                   'DEV_AUTH': 'true', 'DEV_AUTH_SECRET': tokens['auth'], 'PROVIDERS_JSON': '[]',
                   'OPENAI_API_KEY': '', 'CLUSTER_NODE_TOKEN': tokens['node'],
                   'CLASSIC_ENABLED': 'true', 'CLASSIC_ENGINE_PROFILE': 'mit-directml',
                   'CLASSIC_ENGINE_VERSION': 'mit-95227a2-classic-v4-dml-v1',
                   'TEXT_PAGE_BUDGET_MICROS': config.get('TEXT_PAGE_BUDGET_MICROS', '50000'), 'TEXT_MAX_ATTEMPTS': '3',
                   'DISPATCH_INTERVAL_SECONDS': '1'}
    # Explicit allowlist: do not forward credentials inherited from the caller.
    runtime_env = {k: v for k, v in common.items() if k.upper() in {
        'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
        'PROGRAMFILES', 'PROGRAMDATA', 'COMSPEC', 'PATHEXT', 'PYTHONUNBUFFERED', 'PYTHONIOENCODING'}}
    engine_env = {**runtime_env, 'PYTHONPATH': os.pathsep.join([str(ENGINE), str(ROOT/'engines/mit-native')]), 'ENGINE_PROFILE': 'mit-directml',
                  'ENGINE_DEVICE': os.environ.get('ENGINE_DEVICE', 'directml:0'),
                  'MODEL_DIR': str(ROOT/'engines/mit-models'),
                  'ENGINE_FONT': str(ROOT/'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc'),
                  'ENGINE_RESOURCE_ID': socket.gethostname() + ':amd:0', 'ENGINE_TOKEN': tokens['engine'],
                  'ENGINE_LOCK_DIR': str(ROOT / 'engines/device-locks'),
                  'ENGINE_PROFILE_DIR': str(folder / 'profiles'), 'ENGINE_STOP_FILE': str(folder / 'engine.stop')}
    agent_env = {**runtime_env, 'CONTROL_URL': url, 'CONTROL_ALLOW_HTTP': 'true',
                 'CLUSTER_NODE_TOKEN': tokens['node'], 'NODE_ID': 'local-amd', 'NODE_NAME': 'Local AMD DirectML',
                 'ENGINE_URL': engine_url, 'ENGINE_TOKEN': tokens['engine']}
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
        start('api', PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', api_port, '--no-access-log'], control_env)
        wait_http(url, children)
        image_process = start('engine', ENGINE_PYTHON, [ENTRY, '--engine-process', '--engine-port', engine_port], engine_env)
        health = wait_http(engine_url, children, True)
        start('worker', PYTHON, ['-m', 'app.workers'], control_env)
        start('maintenance', PYTHON, ['-m', 'app.dispatcher'], control_env)
        start('agent', ENGINE_PYTHON, [ROOT / 'services/compute-agent/agent.py'], agent_env)
        print(json.dumps({'event': 'CLUSTER_READY', 'api': url, 'engine': engine_url,
                          'device': health['device'], 'model_version': health['version']}, ensure_ascii=False), flush=True)
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
        token = client.post('/v1/auth/dev', json={'username': 'amd-validation'}).raise_for_status().json()['access_token']
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--smoke', action='store_true', help='Translate one page using the configured paid text provider')
    parser.add_argument('--image', type=Path, default=ROOT/'samples/starlight-bookshop.png')
    parser.add_argument('--directory', type=Path, default=ROOT/'private-test-data/amd-original-models')
    parser.add_argument('--api-port', type=int, default=18088)
    parser.add_argument('--engine-port', type=int, default=18090)
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
    with cluster(args.directory.resolve(), args.api_port, args.engine_port) as (url, engine_url, health, children):
        if args.smoke:
            smoke(args.directory.resolve(), url, engine_url, health, args.image)
        else:
            try:
                while True:
                    if any(child.poll() is not None for child in children):
                        raise RuntimeError('A cluster service exited; inspect the local service log')
                    time.sleep(1)
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    main()
