"""Opt-in Windows release acceptance: real GPU, isolated local HTTPS controller.

No image task, production credential, R2 request or external provider is used.
Requires cryptography in the developer's test environment, not in the node.
"""
import argparse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import signal
import ssl
import subprocess
import threading
import time

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def verify(release, work):
    work.mkdir(parents=True, exist_ok=False)
    home = work / '独立 节点数据'
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'isolated-node-test')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
            .sign(key, hashes.SHA256()))
    (work / 'ca.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (work / 'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    outage = threading.Event()
    requests = {'registrations': 0, 'heartbeats': 0}
    class Controller(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
            if (self.headers.get('Authorization') != 'Bearer isolated-fixture-token'
                    or self.headers.get('X-Node-Id') != 'isolated-release-node'
                    or not self.path.endswith(('/register', '/heartbeat', '/updates'))):
                self.send_error(403)
                return
            registration = self.path.endswith('/register')
            if registration:
                requests['registrations'] += 1
            if self.path.endswith('/heartbeat'):
                requests['heartbeats'] += 1
            failed = outage.is_set() or (registration and requests['registrations'] <= 2)
            response = {'protocol_version': 2, 'leases': [], 'server_time': datetime.now(timezone.utc).isoformat(),
                        'revision': 1, 'config': {'version': 1, 'request_seconds': 5, 'execution_slots': 1,
                            'enabled': False, 'heartbeat_seconds': 1, 'poll_seconds': 1}}
            if self.path.endswith('/updates'):
                time.sleep(.25)
            payload = json.dumps(response if not failed else {'error': {'code': 'ISOLATED_OUTAGE'}}).encode()
            self.send_response(503 if failed else 200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Controller)
    server.daemon_threads = True
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(work / 'ca.pem', work / 'key.pem')
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    config = {'protocol_version': 2, 'node_id': 'isolated-release-node', 'node_token': 'isolated-fixture-token',
              'resource_id': 'isolated-vulkan:0', 'control_url': f'https://127.0.0.1:{server.server_port}',
              'control_ca': 'ca.pem', 'r2_origin': 'https://storage.example.test',
              'languages': ['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko', 'fr', 'es', 'pt-BR', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id']}
    source = work / 'fixture.json'
    source.write_text(json.dumps(config), encoding='utf-8')
    executable = release / 'node.exe'
    env = dict(os.environ, PYTHONHOME='Z:/missing-python', PYTHONPATH='Z:/wrong-imports', NODE_TOKEN='wrong-parent-token')
    def command(*args, timeout=180):
        return subprocess.run([str(executable), *args, '--home', str(home)], cwd=os.environ['TEMP'],
                              env=env, capture_output=True, text=True, encoding='utf-8', timeout=timeout, check=True)
    def status():
        return json.loads(command('status').stdout)
    def wait(label, check, timeout=180):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            value = status()
            if check(value):
                print(json.dumps({'passed': label, 'worker_pid': value['supervisor']['worker_pid']}), flush=True)
                return value
            time.sleep(1)
        raise AssertionError('Timed out: ' + label)
    host = None
    try:
        command('init', '--from', str(source))
        doctor = command('doctor')
        print(json.dumps({'passed': 'relocated_gpu_doctor', 'result': json.loads(doctor.stdout.strip())}), flush=True)
        host = subprocess.Popen([str(executable), 'run', '--home', str(home)], cwd=os.environ['TEMP'], env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        connected = wait('initial_registration_recovers', lambda value: value['connected'])
        assert requests['registrations'] >= 3
        pid = connected['supervisor']['worker_pid']
        outage.set()
        wait('outage_reported_offline', lambda value: not value['connected'], timeout=80)
        assert status()['supervisor']['worker_pid'] == pid, 'network outage restarted GPU worker'
        outage.clear()
        wait('same_worker_reconnects', lambda value: value['connected'], timeout=30)
        assert status()['supervisor']['worker_pid'] == pid
        assert connected['supervisor']['pid'] == host.pid, 'wrong supervisor identity'
        os.kill(pid, signal.SIGTERM)
        recovered = wait('gpu_worker_crash_recovers', lambda value: value['connected'] and value['supervisor']['worker_pid'] != pid)
        assert recovered['supervisor']['restarts'] == 1
        command('stop', timeout=90)
        assert host.wait(timeout=10) == 0
        assert not status()['connected']
        result = {'passed': 'release_lifecycle', 'requests': requests, 'restarts': recovered['supervisor']['restarts'],
                  'engine': json.loads(doctor.stdout.strip()), 'scope': 'desktop GPU and isolated HTTPS; not SCM or production'}
        (work / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    finally:
        if host and host.poll() is None:
            try:
                command('stop', timeout=90)
            finally:
                if host.poll() is None:
                    host.kill()
                host.wait(timeout=10)
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    args = parser.parse_args()
    verify(args.release.resolve(), args.work.resolve())
