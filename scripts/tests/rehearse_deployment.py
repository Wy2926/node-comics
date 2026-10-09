"""Isolated Docker rehearsal of the production Compose + real OpenResty reload path.

Requires built deploy-blue/deploy-green images and independent static build outputs.
Creates only randomly named local resources, cleans them in finally, retains report.
No live OIDC, paid suppliers or production environment files are used.
"""
import argparse
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import shutil
import socket
import statistics
import subprocess
import sys
import threading
import time
from uuid import uuid4

import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prepare_static_release import prepare
from switch_release import activate, probe

ROOT = Path(__file__).resolve().parents[2]
OPENRESTY = 'openresty/openresty:1.29.2.4-1-alpine@sha256:a155a204d5d477d1c695dd10dc53b73e91fc0977e181a95cb5c3e07d4f35f755'
REDIS = 'redis:8.2-alpine@sha256:b51665e66f00759be7c3152ad5ac3c66fb2f619c13ef62dea7cc1f9914524635'


def command(*args, timeout=60, check=True):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True, encoding='utf-8', timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(str(arg) for arg in args[:4]) + '\n' + result.stderr[-3000:])
    return result.stdout.strip()


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def until(check, seconds=60):
    deadline = time.monotonic() + seconds
    while True:
        try:
            if check():
                return
        except Exception:
            pass
        if time.monotonic() > deadline:
            raise RuntimeError('Rehearsal condition timed out')
        time.sleep(.25)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-dir', type=Path, default=ROOT / 'artifacts/deployment-build')
    parser.add_argument('--keep', action='store_true', help='Keep isolated containers for manual inspection')
    args = parser.parse_args()
    name = 'nc-deploy-rehearsal-' + uuid4().hex[:8]
    run = ROOT / 'artifacts/deployment-rehearsal' / name
    run.mkdir(parents=True)
    public = run / 'public'
    public.mkdir()
    active = public / 'active'
    active.mkdir()
    blue_port, green_port, proxy_port = free_port(), free_port(), free_port()
    origin = f'http://127.0.0.1:{proxy_port}'
    containers = [name + suffix for suffix in ('-postgres', '-redis', '-proxy', '-worker-next')]
    postgres, redis, proxy, next_worker = containers
    network, volume = name + '-infra', name + '-files'
    report = {'scope': 'local Docker, real PostgreSQL/Redis/OpenResty, synthetic page engine', 'checks': []}
    compose_file = run / 'compose.server.yaml'
    shutil.copyfile(ROOT / 'deploy/compose.server.yaml', compose_file)
    env = {'BLUE_IMAGE': 'node-comics-backend:deploy-blue', 'GREEN_IMAGE': 'node-comics-backend:deploy-green',
           'WORKER_IMAGE': 'node-comics-backend:deploy-blue', 'MAINTENANCE_IMAGE': 'node-comics-backend:deploy-blue',
           'MIGRATION_IMAGE': 'node-comics-backend:deploy-green', 'BLUE_PORT': blue_port, 'GREEN_PORT': green_port,
           'INFRA_NETWORK': network, 'TRANSLATION_VOLUME': volume}
    env_path = run / 'compose.env'
    env_path.write_text(''.join(f'{key}={value}\n' for key, value in env.items()), encoding='utf-8')
    application = {'DATABASE_URL': 'postgresql+psycopg://rehearsal:isolated-local-only@postgres:5432/rehearsal',
                   'REDIS_URL': 'redis://shared-redis:6379/0', 'REDIS_NAMESPACE': 'deploy-rehearsal-' + uuid4().hex,
                   'CLASSIC_ENABLED': 'true', 'ADMIN_WEB_PATH': '/console-rehearsal/', 'STRIPE_ENABLED': 'false', 'CREEM_ENABLED': 'false'}
    (run / '.env.server').write_text(''.join(f'{key}={value}\n' for key, value in application.items()), encoding='utf-8')
    services = {}
    for service in ('api-blue', 'api-green', 'control-worker', 'maintenance', 'migrate'):
        services[service] = {'environment': {'APP_ENV': 'test', 'DEV_AUTH': 'true',
                            'DEV_AUTH_SECRET': 'isolated-local-rehearsal-signing-key'},
                            'volumes': [f'{ROOT / "scripts"}:/fixtures:ro']}
    services['control-worker']['command'] = ['python', '/fixtures/tests/deployment_worker_fixture.py']
    services['control-worker']['environment']['PYTHONPATH'] = '/app'
    services['api-blue']['environment']['PYTHONPATH'] = '/app'
    override = run / 'override.json'
    override.write_text(json.dumps({'services': services}), encoding='utf-8')
    base = ['docker', 'compose', '--env-file', env_path, '-p', name, '-f', compose_file, '-f', override]

    def compose(*args, **kwargs):
        return command(*base, *args, **kwargs)

    def nginx(*options):
        command('docker', 'exec', proxy, 'openresty', *options)

    def check(label):
        report['checks'].append(label)
        print(label, flush=True)

    def switch(port, release, previous):
        probe(f'http://127.0.0.1:{port}/health/ready', release)
        begin = time.perf_counter()
        # Docker Desktop proxy is bridged; production host-network OpenResty uses 127.0.0.1.
        activate(active / 'api.inc', f'server {proxy_host}:{port};\n'.encode(), nginx,
                 lambda: probe(origin + '/health/ready', release),
                 verify_previous=lambda: probe(origin + '/health/ready', previous))
        report.setdefault('switch_seconds', []).append(round(time.perf_counter() - begin, 3))

    stopping = threading.Event()
    samples, baseline, failures, observed = [], [], [], set()
    phase = 'baseline'
    pool = ThreadPoolExecutor(max_workers=8)
    try:
        resolved = json.loads(compose('--profile', '*', 'config', '--format', 'json'))
        assert 'redis' not in resolved['services']
        assert resolved['volumes']['translation_files']['external']
        check('production Compose has no Redis service or managed Redis volume')
        command('docker', 'network', 'create', network)
        command('docker', 'volume', 'create', volume)
        command('docker', 'run', '-d', '--name', postgres, '--network', network, '--network-alias', 'postgres',
                '-e', 'POSTGRES_USER=rehearsal', '-e', 'POSTGRES_PASSWORD=isolated-local-only', '-e', 'POSTGRES_DB=rehearsal',
                '--tmpfs', '/var/lib/postgresql/data', 'postgres:17.6-alpine')
        command('docker', 'run', '-d', '--name', redis, '--network', network, '--network-alias', 'shared-redis',
                REDIS, 'redis-server', '--save', '', '--appendonly', 'no', '--maxmemory-policy', 'noeviction')
        until(lambda: 'accepting connections' in command('docker', 'exec', postgres, 'pg_isready', '-U', 'rehearsal', check=False))
        until(lambda: command('docker', 'exec', redis, 'redis-cli', 'ping') == 'PONG')
        infrastructure_ids = command('docker', 'inspect', '--format', '{{.Id}} {{.State.StartedAt}}', postgres, redis)
        compose('run', '--rm', '--no-deps', 'migrate')
        # The candidate can become ready before ANY worker exists.
        compose('up', '-d', '--no-deps', 'api-blue', 'api-green')
        until(lambda: httpx.get(f'http://127.0.0.1:{blue_port}/health/ready').status_code == 200)
        until(lambda: httpx.get(f'http://127.0.0.1:{green_port}/health/ready').status_code == 200)
        assert httpx.get(f'http://127.0.0.1:{green_port}/health/cluster').status_code == 503
        check('both API releases ready without worker/maintenance; shared schema is unchanged')
        proxy_host = command('docker', 'exec', compose('ps', '-q', 'api-blue'), 'python', '-c',
                             "import socket; print(socket.gethostbyname('host.docker.internal'))")
        compose('up', '-d', '--no-deps', 'control-worker', 'maintenance')
        website_source = args.build_dir / 'website/site'
        manifest = args.build_dir / 'website/extension-release.json'
        site_v1 = prepare('website', website_source, public, 'web-v1', '/www/node-comics', manifest=manifest,
                          oidc_origin='https://identity.example')
        admin_v1 = prepare('admin', args.build_dir / 'admin/site', public, 'admin-v1', '/www/node-comics',
                           admin_path='/console-rehearsal/', oidc_origin='https://identity.example')
        shutil.copyfile(site_v1, active / 'website.inc')
        shutil.copyfile(admin_v1, active / 'admin.inc')
        (active / 'api.inc').write_text(f'server {proxy_host}:{blue_port};\n', encoding='utf-8')
        shutil.copyfile(ROOT / 'deploy/openresty.api.inc', public / 'openresty.api.inc')
        (public / 'nginx.conf').write_text('''worker_processes 2;
error_log /dev/stderr notice;
events { worker_connections 1024; }
http {
    include /usr/local/openresty/nginx/conf/mime.types;
    access_log off;
    upstream comics_api { include /www/node-comics/active/api.inc; keepalive 32; }
    server {
        listen 8080;
        client_max_body_size 96m;
        include /www/node-comics/active/website.inc;
        include /www/node-comics/active/admin.inc;
        location = /design-tokens.css { alias /www/node-comics/releases/website/web-v1/site/design-tokens.css; }
        location = /admin { return 404; }
        location ^~ /admin/ { return 404; }
        location ~ ^/(v1|internal|webhooks|billing|health)(/|$) { include /www/node-comics/openresty.api.inc; }
    }
}
''', encoding='utf-8')
        command('docker', 'run', '-d', '--name', proxy, '--network', network,
                '-p', f'127.0.0.1:{proxy_port}:8080', '-v', f'{public}:/www/node-comics:ro',
                '-v', f'{public / "nginx.conf"}:/usr/local/openresty/nginx/conf/nginx.conf:ro', OPENRESTY)
        until(lambda: httpx.get(origin + '/health/ready').status_code == 200)
        # Syntax-check the exact production template too, with isolated test certificates.
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
        certificate = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
                       .public_key(private_key.public_key()).serial_number(x509.random_serial_number())
                       .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
                       .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1))
                       .sign(private_key, hashes.SHA256()))
        (public / 'test-fullchain.pem').write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        (public / 'test-key.pem').write_bytes(private_key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        production_template = (ROOT / 'deploy/openresty.comics.conf').read_text(encoding='utf-8')
        production_template = production_template.replace('/www/sites/auth/ssl/fullchain.pem', '/www/node-comics/test-fullchain.pem')
        production_template = production_template.replace('/www/sites/auth/ssl/privkey.pem', '/www/node-comics/test-key.pem')
        # Only the private error-log destination differs from the host installation.
        production_template = production_template.replace('/var/log/nginx/node-comics-error.log', '/tmp/production-check.log')
        (public / 'production.conf').write_text('events {}\nhttp {\n' + production_template + '\n}\n', encoding='utf-8')
        nginx('-t', '-c', '/www/node-comics/production.conf')
        check('exact production OpenResty template passes syntax check with isolated TLS certificate')
        for path in ('/', '/en/', '/ja/', '/ko/', '/zh-tw/', '/console-rehearsal/'):
            response = httpx.get(origin + path)
            assert response.status_code == 200, (path, response.status_code)
            assert 'Content-Security-Policy' in response.headers
        for path in ('/.env', '/admin/', '/source.map', '/v1/missing', '/en/missing/', '/console-rehearsal/assets/.env'):
            response = httpx.get(origin + path)
            assert response.status_code == 404, (path, response.status_code)
        download = json.loads(manifest.read_text(encoding='utf-8'))['releases'][0]
        assert httpx.post(origin + download['path']).status_code == 405
        download_response = httpx.get(origin + download['path'])
        assert download_response.status_code == (308 if download.get('download_url') else 503)
        assert 'no-store' in httpx.get(origin + '/account/').headers['Cache-Control']
        missing_chunk = httpx.get(origin + '/_astro/not-present.js')
        assert missing_chunk.status_code == 404 and 'no-store' in missing_chunk.headers['Cache-Control']
        asset = next(website_source.glob('_astro/*.js')).name
        assert httpx.get(origin + '/_astro/' + asset).status_code == 200
        check('independent static website/admin: five locales, CSP, assets, private routes and real 404s')

        def poll():
            with httpx.Client(timeout=5) as client:
                while not stopping.is_set():
                    begin = time.perf_counter()
                    try:
                        response = client.get(origin + '/health/ready')
                        response.raise_for_status()
                        observed.add(response.json()['release'])
                        duration = (time.perf_counter() - begin) * 1000
                        (baseline if phase == 'baseline' else samples).append(duration)
                    except Exception as exc:
                        failures.append(type(exc).__name__)
                    stopping.wait(.03)

        pollers = [pool.submit(poll) for _ in range(4)]
        stopping.wait(2)
        phase = 'release'
        with httpx.Client(base_url=origin, timeout=30) as client:
            token = client.post('/v1/auth/dev', json={'username': 'rehearsal'}).json()['access_token']
            auth = {'Authorization': 'Bearer ' + token, 'X-Translation-Protocol': 'overlay-v1'}
            blue_id = compose('ps', '-q', 'api-blue')
            command('docker', 'exec', blue_id, 'python', '/fixtures/tests/deployment_worker_fixture.py', 'promote')
            images, ids, bodies = [], [], []
            for number in range(2):
                data = BytesIO()
                Image.new('RGB', (320, 480), (220, 230, 240 - number)).save(data, 'PNG')
                images.append(data.getvalue())
                ids.append(str(uuid4()))
                bodies.append({'image': {'sha256': hashlib.sha256(images[-1]).hexdigest(),
                                         'byte_size': len(images[-1]), 'content_type': 'image/png'},
                               'mode': 'classic', 'target_language': 'zh-Hans'})
                response = client.put('/v1/translations/' + ids[-1], headers=auth, json=bodies[-1])
                assert response.status_code < 300, response.text
            response = client.put(f'/v1/translations/{ids[0]}/input', headers={**auth, 'Content-Type': 'image/png'}, content=images[0])
            assert response.status_code < 300, response.text
            until(lambda: int(command('docker', 'exec', redis, 'redis-cli', 'get', application['REDIS_NAMESPACE'] + ':{admission}:rehearsal-supplier-calls:') or 0) == 1)
            sse_started, upload_started = threading.Event(), threading.Event()

            def stream():
                frames = []
                with httpx.stream('GET', origin + '/v1/translations/events', params={'ids': ','.join(ids)}, headers=auth, timeout=35) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        if line.startswith('event:'):
                            frames.append(line)
                            sse_started.set()
                return frames

            def slow_upload():
                raw = images[1]
                def chunks():
                    for offset in range(0, len(raw), max(1, len(raw) // 32)):
                        upload_started.set()
                        yield raw[offset:offset + max(1, len(raw) // 32)]
                        time.sleep(.12)
                return httpx.put(origin + f'/v1/translations/{ids[1]}/input',
                                 headers={**auth, 'Content-Type': 'image/png', 'Content-Length': str(len(raw))},
                                 content=chunks(), timeout=30).status_code

            sse_future, upload_future = pool.submit(stream), pool.submit(slow_upload)
            assert sse_started.wait(10) and upload_started.wait(10)
            switch(green_port, 'rehearsal-green', 'rehearsal-blue')
            old_worker = compose('ps', '-q', 'control-worker')
            command(sys.executable, ROOT / 'scripts/retire_release.py', 'worker', '--container', old_worker,
                    '--release', 'rehearsal-blue', '--active-dir', active, '--signal-only')
            env['WORKER_IMAGE'] = 'node-comics-backend:deploy-green'
            env_path.write_text(''.join(f'{key}={value}\n' for key, value in env.items()), encoding='utf-8')
            compose('run', '-d', '--name', next_worker, '--no-deps', 'control-worker')
            assert upload_future.result(timeout=30) < 300
            frames = sse_future.result(timeout=40)
            assert frames[-1] == 'event: end'
            for key, body in zip(ids, bodies):
                response = client.put('/v1/translations/' + key, headers=auth, json=body)
                assert response.status_code < 300, response.text
                result = client.get('/v1/translations/' + key + '/result', headers=auth)
                assert result.status_code == 200 and len(result.content) > 0
            stats = json.loads(command('docker', 'exec', blue_id, 'python', '/fixtures/tests/deployment_worker_fixture.py', 'stats'))
            assert stats['supplier_calls'] == 2 and len(stats['jobs']) == 2, stats
            assert stats['jobs'] == ['succeeded', 'succeeded'] and stats['ledger'] == {'reserve': 2, 'settle': 2}, stats
            report['task_stats'] = stats
            until(lambda: command('docker', 'inspect', '--format', '{{.State.Running}}', old_worker) == 'false')
            assert command('docker', 'inspect', '--format', '{{.State.ExitCode}}', old_worker) == '0'
            check('upload and SSE survive cutover; worker drains; UUID replay does not call supplier again')

        # Invalid config must never replace live routing.
        previous = (active / 'api.inc').read_bytes()
        try:
            activate(active / 'api.inc', b'invalid nginx directive;\n', nginx, lambda: None)
            raise AssertionError('Invalid config was accepted')
        except RuntimeError:
            assert (active / 'api.inc').read_bytes() == previous
        until(lambda: httpx.get(origin + '/health/ready').json()['release'] == 'rehearsal-green')
        check('invalid OpenResty configuration restores old include and keeps serving')
        try:
            activate(active / 'api.inc', f'server {proxy_host}:{blue_port};\n'.encode(), nginx,
                     lambda: probe(origin + '/health/ready', 'deliberately-wrong-version'),
                     verify_previous=lambda: probe(origin + '/health/ready', 'rehearsal-green'), timeout=1)
            raise AssertionError('Wrong version accepted')
        except RuntimeError:
            assert (active / 'api.inc').read_bytes() == previous
        check('post-reload version mismatch automatically rolls back')
        switch(blue_port, 'rehearsal-blue', 'rehearsal-green')
        check('explicit green-to-blue API rollback succeeds')
        command(sys.executable, ROOT / 'scripts/retire_release.py', 'api', '--container', compose('ps', '-q', 'api-green'),
                '--release', 'rehearsal-green', '--active-dir', active, '--openresty-container', proxy,
                '--port', str(green_port), '--active-release', 'rehearsal-blue', '--probe-url', origin + '/health/ready',
                '--timeout', '30')
        check('old API retires only after proxy drain, with normal exit and no SIGKILL')
        command(sys.executable, ROOT / 'scripts/retire_release.py', 'maintenance', '--container', compose('ps', '-q', 'maintenance'),
                '--release', 'rehearsal-blue', '--active-dir', active, '--timeout', '30')
        env['MAINTENANCE_IMAGE'] = 'node-comics-backend:deploy-green'
        env_path.write_text(''.join(f'{key}={value}\n' for key, value in env.items()), encoding='utf-8')
        compose('up', '-d', '--no-deps', '--wait', '--wait-timeout', '45', 'maintenance')
        assert 'rehearsal-green' in command('docker', 'inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', compose('ps', '-q', 'maintenance'))
        check('maintenance performs single-active graceful handover without stopping API')
        web_v2 = prepare('website', website_source, public, 'web-v2', '/www/node-comics', manifest=manifest,
                         oidc_origin='https://identity.example')
        activate(active / 'website.inc', web_v2.read_bytes(), nginx,
                 lambda: probe(origin + '/', 'web-v2', static=True))
        assert httpx.get(origin + '/console-rehearsal/').headers['X-Static-Release'] == 'admin-v1'
        assert httpx.get(origin + '/health/ready').json()['release'] == 'rehearsal-blue'
        assert httpx.get(origin + '/_astro/' + asset).status_code == 200
        activate(active / 'website.inc', site_v1.read_bytes(), nginx,
                 lambda: probe(origin + '/', 'web-v1', static=True))
        check('website-only release and rollback do not restart API/admin; retained assets still load')
        assert command('docker', 'inspect', '--format', '{{.Id}} {{.State.StartedAt}}', postgres, redis) == infrastructure_ids
        check('shared PostgreSQL and Redis are not recreated or restarted')
        stopping.set()
        for future in pollers:
            future.result(timeout=10)
        assert samples and not failures, failures
        assert observed == {'rehearsal-blue', 'rehearsal-green'}, observed
        report['http_samples'] = len(samples) + len(baseline)
        report['http_failures'] = len(failures)
        report['latency_ms'] = {'p50': round(statistics.median(samples), 2),
                                'p95': round(sorted(samples)[int(len(samples) * .95)], 2), 'max': round(max(samples), 2)}
        report['baseline_latency_ms'] = {'p50': round(statistics.median(baseline), 2),
                                         'p95': round(sorted(baseline)[int(len(baseline) * .95)], 2), 'max': round(max(baseline), 2)}
        report['passed'] = True
    finally:
        stopping.set()
        pool.shutdown(wait=True, cancel_futures=True)
        (run / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        logs = subprocess.run(['docker', 'logs', proxy], capture_output=True, text=True, encoding='utf-8')
        (run / 'proxy.log').write_text(logs.stdout + logs.stderr, encoding='utf-8')
        if not args.keep:
            compose('--profile', '*', 'down', '--remove-orphans', check=False)
            for container in containers:
                command('docker', 'rm', '-f', container, check=False)
            command('docker', 'volume', 'rm', volume, check=False)
            command('docker', 'network', 'rm', network, check=False)
        print('Report:', run / 'report.json', flush=True)


if __name__ == '__main__':
    main()
