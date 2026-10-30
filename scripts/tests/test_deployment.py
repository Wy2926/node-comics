from pathlib import Path
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import sys
import ssl
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from switch_release import activate, probe, release_lock
from switch_release import main as switch_main
from retire_release import main as retire_main, proxy_draining
from prepare_static_release import prepare
import json


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.active = self.root / 'api.inc'
        self.active.write_bytes(b'old')

    def test_local_probe_preserves_host_and_rejects_wrong_release(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(dict(self.headers))
                self.send_response(200)
                self.send_header('X-Static-Release', 'v1')
                self.end_headers()
                self.wfile.write(b'{"status":"ready","release":"v1"}')
            def log_message(self, *args):
                pass
        with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                host = f'no-public-dns.invalid:{server.server_port}'
                for static in (False, True):
                    probe('http://' + host + '/', 'v1', local=True, static=static)
                    with self.assertRaises(RuntimeError):
                        probe('http://' + host + '/', 'wrong', local=True, static=static)
                self.assertTrue(all(row['Host'] == host and row['Cache-Control'] == 'no-cache' for row in requests))
            finally:
                server.shutdown()
                thread.join(timeout=5)

    def switch_args(self):
        return ['switch_release.py', 'api', '--active-file', str(self.active), '--release', 'new',
                '--probe-url', 'http://proxy/health/ready',
                '--port', '18089', '--nginx-bin', 'nginx']

    def test_local_https_probe_preserves_sni_and_validates_certificate(self):
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        hostname, seen = 'no-public-dns.invalid', []
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])
        certificate = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(hostname)]), critical=False)
            .sign(key, hashes.SHA256()))
        cert_path, key_path = self.root / 'cert.pem', self.root / 'key.pem'
        cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert_path, key_path)
        context.set_servername_callback(lambda socket, name, context: seen.append(name))
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"ready","release":"v1"}')
            def log_message(self, *args):
                pass
        with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f'https://{hostname}:{server.server_port}/health/ready'
                with self.assertRaises(ssl.SSLCertVerificationError):
                    probe(url, 'v1', local=True)
                trusted = ssl.create_default_context(cafile=str(cert_path))
                with patch('switch_release.ssl.create_default_context', return_value=trusted):
                    probe(url, 'v1', local=True)
                    with self.assertRaises(ssl.SSLCertVerificationError):
                        probe(url.replace(hostname, 'wrong-host.invalid'), 'v1', local=True)
                self.assertEqual(seen, [hostname, hostname, 'wrong-host.invalid'])
            finally:
                server.shutdown()
                thread.join(timeout=5)

    def test_healthy_replacement_needs_no_previous_release_or_backup(self):
        calls = []
        def ready(url, release, **kwargs):
            calls.append((url, release, kwargs.get('local', False)))
        with patch('sys.argv', self.switch_args()), patch('switch_release.probe', side_effect=ready), \
                patch('switch_release.subprocess.run') as run, patch('builtins.print'):
            run.return_value.returncode = 0
            switch_main()
        self.assertEqual(calls, [('http://127.0.0.1:18089/health/ready', 'new', False), ('http://proxy/health/ready', 'new', True)])
        self.assertIn(b'18089', self.active.read_bytes())
        self.assertFalse(self.active.with_suffix('.inc.previous').exists())

    def test_unready_candidate_does_not_replace_or_reload(self):
        with patch('sys.argv', self.switch_args()), patch('switch_release.probe', side_effect=RuntimeError('unready')), \
                patch('switch_release.subprocess.run') as run, self.assertRaisesRegex(RuntimeError, 'unready'):
            switch_main()
        run.assert_not_called()
        self.assertEqual(self.active.read_bytes(), b'old')

    def test_failed_post_reload_probe_keeps_new_config_and_reports_uncertainty(self):
        def unready():
            raise RuntimeError('unavailable')
        calls = []
        with self.assertRaisesRegex(RuntimeError, 'new include retained'):
            activate(self.active, b'new', lambda *args: calls.append(args), unready, timeout=0)
        self.assertEqual(self.active.read_bytes(), b'new')
        self.assertEqual(calls, [('-t',), ('-s', 'reload')])

    def test_retirement_uses_active_port_not_release_inequality(self):
        argv = ['retire_release.py', 'api', '--container', 'old-slot', '--release', 'same',
                '--active-dir', str(self.root), '--port', '18088', '--timeout', '1',
                '--active-release', 'same', '--probe-url', 'http://proxy/health/ready']
        info = {'Id': 'frozen-container-id', 'Config': {'Env': ['RELEASE_ID=same'],
            'Labels': {'com.docker.compose.service': 'api-blue'}},
            'HostConfig': {'PortBindings': {'8000/tcp': [{'HostPort': '18088', 'HostIp': '127.0.0.1'}]}},
            'State': {'Running': True}}
        calls = []
        def docker(*args):
            calls.append(args)
            if args == ('inspect', 'old-slot'):
                return json.dumps([info])
            if args[:2] == ('inspect', '--format'):
                return json.dumps({'Running': False, 'ExitCode': 0})
            return ''
        for port, draining in ((18088, False), (18089, True), (18089, False)):
            calls.clear()
            self.active.write_text(f'server 127.0.0.1:{port};', encoding='utf-8')
            with patch('sys.argv', argv), patch('retire_release.docker', side_effect=docker), \
                    patch('retire_release.probe'), patch('retire_release.proxy_draining', return_value=draining), \
                    patch('retire_release.time.monotonic', side_effect=range(20)), patch('builtins.print'):
                if port == 18088 or draining:
                    with self.assertRaisesRegex(RuntimeError, 'still in the active upstream|Proxy has not drained'):
                        retire_main()
                    self.assertFalse(any(call[0] == 'kill' for call in calls))
                else:
                    retire_main()
                    self.assertIn(('kill', '--signal=TERM', 'frozen-container-id'), calls)

    def test_native_nginx_drain_only_checks_current_master_children(self):
        pid_file = self.root / 'nginx.pid'
        pid_file.write_text('123\n')
        for status, expected in (('worker process', False), ('worker process is shutting down', True)):
            with patch('retire_release.subprocess.run') as run:
                run.return_value.stdout = 'nginx: ' + status
                self.assertEqual(proxy_draining(None, pid_file), expected)
                run.assert_called_once_with(['ps', '--ppid', '123', '-o', 'args='],
                    capture_output=True, text=True, timeout=5, check=True)

    def test_nginx_activation_failure_restores_disk_config(self):
        for failed_option in ('-t', '-s'):
            calls = []
            def nginx(*args):
                calls.append(args)
                if args[0] == failed_option:
                    raise RuntimeError('nginx failed')
            with self.assertRaisesRegex(RuntimeError, 'inspect running proxy state'):
                activate(self.active, b'new', nginx, lambda: self.fail('No probe before successful reload'))
            self.assertEqual(self.active.read_bytes(), b'old')
            self.assertEqual(calls, [('-t',)] if failed_option == '-t' else [('-t',), ('-s', 'reload')])

    def test_lock_prevents_overlapping_releases(self):
        with release_lock(self.root):
            with self.assertRaises(OSError):
                activate(self.active, b'new', lambda *args: None, lambda: None)
        self.assertEqual(self.active.read_bytes(), b'old')

    def test_private_entry_is_preserved_and_reserved_entries_rejected(self):
        source = self.root / 'build'
        source.mkdir()
        (source / 'index.html').write_text('console', encoding='utf-8')
        config = prepare('admin', source, self.root / 'static', 'v1', '/www/node-comics', admin_path='/existing-panel/')
        self.assertIn('location = /existing-panel/', config.read_text())
        for path in ('/admin/', '/v1/', '/billing/', '/webhooks/', '/translate/', '/sites/'):
            with self.assertRaises(ValueError):
                prepare('admin', source, self.root / 'static', 'v2', '/www/node-comics', admin_path=path)

    def test_translation_pages_keep_private_headers_and_scoped_challenge_csp(self):
        source = self.root / 'build'
        source.mkdir()
        (source / 'index.html').write_text('<h1>Public home</h1>', encoding='utf-8')
        for locale in ('', 'en', 'ja', 'ko', 'zh-tw', 'ar'):
            page = source / locale / 'translate' / 'index.html'
            page.parent.mkdir(parents=True)
            page.write_text('<h1>Translation</h1>', encoding='utf-8')
        config = prepare('website', source, self.root / 'static', 'v1', '/www/node-comics').read_text()
        home = config.split('location = / {', 1)[1].split('\n}', 1)[0]
        self.assertNotIn('challenges.cloudflare.com', home)
        self.assertNotIn('blob:', home)
        for locale in ('', 'en/', 'ja/', 'ko/', 'zh-tw/', 'ar/'):
            page = config.split(f'location = /{locale}translate/ {{', 1)[1].split('\n}', 1)[0]
            self.assertIn('no-store', page)
            self.assertIn('noindex', page)
            self.assertIn('https://challenges.cloudflare.com', page)
            self.assertIn("img-src 'self' data: blob:", page)
            self.assertIn("worker-src 'self'", page)
            self.assertIn("connect-src 'self'  https://challenges.cloudflare.com;", page)

    def test_document_r2_csp_is_exact_and_confined_to_translate_connect(self):
        source = self.root / 'build'
        source.mkdir()
        (source / 'index.html').write_text('<h1>Home</h1>', encoding='utf-8')
        for path in ('account', 'translate', 'en/translate', 'ar/translate'):
            page = source / path / 'index.html'
            page.parent.mkdir(parents=True)
            page.write_text('<h1>Page</h1>', encoding='utf-8')
        origin = 'https://account.r2.cloudflarestorage.com:443'
        config = prepare('website', source, self.root / 'static', 'v1', '/www/node-comics',
                         oidc_origin='https://identity.example', document_r2_origin=origin).read_text()
        for path in ('translate', 'en/translate', 'ar/translate'):
            page = config.split(f'location = /{path}/ {{', 1)[1].split('\n}', 1)[0]
            sources = [directive.strip() for directive in page.split(';') if origin in directive]
            self.assertEqual(sources, [f"connect-src 'self' https://identity.example https://challenges.cloudflare.com {origin}"])
        for path in ('/', '/account/'):
            page = config.split(f'location = {path} {{', 1)[1].split('\n}', 1)[0]
            self.assertNotIn(origin, page)
        admin = prepare('admin', source, self.root / 'static', 'v1', '/www/node-comics',
                        admin_path='/private-panel/', document_r2_origin=origin).read_text()
        self.assertNotIn(origin, admin)
        self.assertNotIn('*.r2.cloudflarestorage.com', config)

    def test_document_r2_csp_rejects_non_origins_before_writing_release(self):
        source = self.root / 'build'
        source.mkdir()
        (source / 'index.html').write_text('<h1>Home</h1>', encoding='utf-8')
        destination = self.root / 'static'
        for origin in ('http://account.r2.cloudflarestorage.com',
                       'https://user:secret@account.r2.cloudflarestorage.com', 'https://@account.r2.cloudflarestorage.com',
                       'https://account.r2.cloudflarestorage.com/', 'https://account.r2.cloudflarestorage.com/bucket',
                       'https://account.r2.cloudflarestorage.com?private=1', 'https://account.r2.cloudflarestorage.com?',
                       'https://account.r2.cloudflarestorage.com#fragment', 'https://*.r2.cloudflarestorage.com',
                       'https://account.r2.cloudflarestorage.com; connect-src *',
                       'https://account.r2.cloudflarestorage.com\n', 'https://account.r2.cloudflarestorage.com:0',
                       'https://account.r2.cloudflarestorage.com:65536'):
            with self.subTest(origin=origin), self.assertRaisesRegex(ValueError, 'bare HTTPS origin'):
                prepare('website', source, destination, 'v1', '/www/node-comics', document_r2_origin=origin)
            self.assertFalse(destination.exists())

    def test_built_languages_get_localized_not_found_routes(self):
        source = self.root / 'build'
        source.mkdir()
        (source / 'index.html').write_text('<h1>Home</h1>', encoding='utf-8')
        for locale in ('zh-tw', 'en', 'ja', 'ko', 'fr', 'es', 'pt-br', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id', 'ar'):
            error = source / locale / '404' / 'index.html'
            error.parent.mkdir(parents=True)
            error.write_text('<h1>Not found</h1>', encoding='utf-8')
        config = prepare('website', source, self.root / 'static', 'v1', '/www/node-comics').read_text()
        for error in source.glob('*/404/index.html'):
            locale = error.parent.parent.name
            self.assertIn(f'location /{locale}/ {{ error_page 404 /__static_errors/{locale}/404/index.html;', config)

    def test_static_release_is_immutable_and_old_chunks_remain(self):
        source = self.root / 'build'
        source.mkdir()
        (source / 'index.html').write_text('<script>window.example=1;</script>', encoding='utf-8')
        (source / '_astro').mkdir()
        (source / '_astro/a.hash.js').write_text('old', encoding='utf-8')
        destination = self.root / 'static'
        first = prepare('website', source, destination, 'v1', '/www/node-comics')
        self.assertIn("'sha256-", first.read_text())
        with self.assertRaises(ValueError):
            prepare('website', source, destination, 'v1', '/www/node-comics')
        (source / '_astro/a.hash.js').unlink()
        (source / '_astro/b.hash.js').write_text('new', encoding='utf-8')
        prepare('website', source, destination, 'v2', '/www/node-comics')
        self.assertTrue((destination / 'assets/website/_astro/a.hash.js').is_file())
        (source / '_astro/b.hash.js').write_text('collision', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'collision'):
            prepare('website', source, destination, 'v3', '/www/node-comics')


if __name__ == '__main__':
    unittest.main()
