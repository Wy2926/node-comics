"""Opt-in Windows release acceptance: real GPU, isolated local HTTPS controller.

No image task, production credential or external provider is used.
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
    payload = release / 'payload'
    backend = json.loads((payload / 'release.json').read_text(encoding='utf-8')).get('backend', 'cuda')
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
            response = {'protocol_version': 3, 'leases': [], 'server_time': datetime.now(timezone.utc).isoformat(),
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
    config = {'protocol_version': 3, 'node_id': 'isolated-release-node', 'node_token': 'isolated-fixture-token',
              'resource_id': f'isolated-{backend}:0', 'control_url': f'https://127.0.0.1:{server.server_port}',
              'control_ca': 'ca.pem', 'max_leases': 1, 'local_pages': 1, 'render_workers': 1,
              'engine': {'backend': backend, 'threads': 2}}
    source = work / 'fixture.json'
    source.write_text(json.dumps(config), encoding='utf-8')
    executable = release / 'node.exe'
    env = dict(os.environ, PYTHONHOME='Z:/missing-python', PYTHONPATH='Z:/wrong-imports', NODE_TOKEN='wrong-parent-token')
    def command(*args, timeout=180):
        return subprocess.run([str(executable), *args, '--home', str(home)], cwd=os.environ['TEMP'],
                              env=env, capture_output=True, text=True, encoding='utf-8', errors='replace',
                              timeout=timeout, check=True)
    def status():
        return json.loads(command('status').stdout)
    def gpu_memory(pid):
        # WDDM per-process counters work for both AMD and NVIDIA; never require
        # the whole GPU to be empty (the desktop/other nodes may still use it).
        script = (f"@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory "
                  f"-ErrorAction Stop | Where-Object Name -like 'pid_{pid}_*' | "
                  "Select-Object DedicatedUsage,SharedUsage) | ConvertTo-Json -Compress")
        output = subprocess.check_output(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                                         text=True, encoding='utf-8', timeout=30)
        records = json.loads(output) if output.strip() else []
        if isinstance(records, dict):
            records = [records]
        return sum(int(row['DedicatedUsage']) + int(row['SharedUsage']) for row in records)
    def process_exists(pid):
        import ctypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            if ctypes.get_last_error() == 87:  # ERROR_INVALID_PARAMETER: no such process.
                return False
            raise OSError(ctypes.get_last_error(), 'cannot verify process exit')
        kernel.CloseHandle(ctypes.c_void_p(handle))
        return True
    def wait(label, check, timeout=180):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            value = status()
            if check(value):
                print(json.dumps({'passed': label, 'worker_pid': value['supervisor']['worker_pid']}), flush=True)
                return value
            time.sleep(1)
        raise AssertionError('Timed out: ' + label)
    background = False
    try:
        command('init', '--from', str(source))
        doctor_started = time.monotonic()
        # Full environment hashing is explicit diagnostics, not normal startup.
        doctor = command('doctor', timeout=600)
        print(json.dumps({'passed': 'relocated_gpu_doctor', 'seconds': time.monotonic() - doctor_started,
                          'result': json.loads(doctor.stdout.strip())}), flush=True)
        background = True
        command('start', timeout=600)
        connected = wait('initial_registration_recovers', lambda value: value['connected'], timeout=600)
        assert requests['registrations'] >= 3
        pid = connected['supervisor']['worker_pid']
        before_stop_bytes = gpu_memory(pid)
        assert before_stop_bytes > 0, 'no per-process GPU memory observed; GPU release not verified'
        outage.set()
        wait('outage_reported_offline', lambda value: not value['connected'], timeout=80)
        assert status()['supervisor']['worker_pid'] == pid, 'network outage restarted GPU worker'
        outage.clear()
        wait('same_worker_reconnects', lambda value: value['connected'], timeout=30)
        assert status()['supervisor']['worker_pid'] == pid
        host_pid = connected['supervisor']['pid']
        assert process_exists(host_pid)
        os.kill(pid, signal.SIGTERM)
        recovered = wait('gpu_worker_crash_recovers', lambda value: value['connected'] and value['supervisor']['worker_pid'] != pid)
        assert recovered['supervisor']['restarts'] == 1
        final_pid = recovered['supervisor']['worker_pid']
        assert gpu_memory(final_pid) > 0
        command('stop', timeout=90)
        assert not process_exists(host_pid), 'supervisor remains after stop'
        assert not status()['connected']
        assert not process_exists(pid) and not process_exists(final_pid), 'compute worker remains after stop'
        until = time.monotonic() + 30
        after_stop_bytes = gpu_memory(final_pid)
        while after_stop_bytes and time.monotonic() < until:
            time.sleep(1)
            after_stop_bytes = gpu_memory(final_pid)
        assert after_stop_bytes == 0, 'WDDM still reports GPU memory for the stopped worker'
        command('stop', timeout=90)
        # Exercise the actual Start.cmd entry path after Stop's persistent gate,
        # including an idempotent second click, without another download.
        background = True
        command('start', timeout=600)
        restarted = status()
        assert restarted['connected']
        background_pid = restarted['supervisor']['worker_pid']
        assert gpu_memory(background_pid) > 0
        command('start', timeout=30)
        assert status()['supervisor']['worker_pid'] == background_pid
        command('stop', timeout=90)
        assert not process_exists(background_pid)
        until = time.monotonic() + 30
        while gpu_memory(background_pid) and time.monotonic() < until:
            time.sleep(1)
        assert gpu_memory(background_pid) == 0
        background = False
        result = {'passed': 'release_lifecycle', 'requests': requests, 'restarts': recovered['supervisor']['restarts'],
                  'engine': json.loads(doctor.stdout.strip()), 'backend': backend,
                  'gpu_memory_before_stop': before_stop_bytes, 'gpu_memory_after_stop': after_stop_bytes,
                  'workers_exited': [pid, final_pid, background_pid], 'background_start_stop': True,
                  'scope': 'desktop GPU and isolated HTTPS; not production or real image tasks'}
        (work / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    finally:
        if background:
            command('stop', timeout=90)
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    args = parser.parse_args()
    verify(args.release.resolve(), args.work.resolve())
