"""Linux-only isolated Nginx/GoAccess checks; never calls the application."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import runpy
import shutil
import sys
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / 'deploy' / 'traffic'
expire_calendar_days = runpy.run_path(str(ROOT / 'scripts' / 'traffic.py'))['expire_calendar_days']


def line(at=None, agent='Mozilla/5.0', route='/'):
    at = at or datetime.now(timezone.utc)
    return (f'8.8.8.8 [{at.strftime("%Y-%m-%dT%H:%M:%S%z")}] "GET {route} HTTP/1.1" '
            f'200 123 "example.com" "{agent}" 0.012 "-" comics.nodelane.net 15\n')


@unittest.skipUnless(sys.platform == 'linux' and shutil.which('nginx') and shutil.which('goaccess'), 'Requires native Linux Nginx and GoAccess')
class NativeTrafficTests(unittest.TestCase):
    def test_empty_report_without_fake_visits(self):
        with tempfile.TemporaryDirectory(prefix='traffic-empty-') as work:
            root = Path(work)
            (root / 'logs').mkdir()
            module = runpy.run_path(str(ROOT / 'scripts' / 'traffic.py'))
            module['report']({'state_dir': str(root), 'log_dir': str(root / 'logs'),
                              'report_days': 30, 'raw_days': 7, 'timezone': 'Asia/Shanghai'})
            self.assertTrue((root / 'reports' / 'index.html').exists())
            self.assertIn('尚无符合条件', (root / 'reports' / 'website.html').read_text())

    def test_nginx_redaction_and_classification(self):
        with tempfile.TemporaryDirectory(prefix='traffic-native-') as work:
            root = Path(work)
            (root / 'private-route.map').write_text('~^/private-console(/|$) /:admin;\n')
            (root / 'private-kind.map').write_text('~^/private-console(/|$) private;\n')
            maps = (DEPLOY / 'nginx.http.conf').read_text().replace('/etc/nodelane/traffic-private-', str(root / 'private-'))
            logs = (DEPLOY / 'nginx.logs.inc').read_text().replace('/var/log/nginx/traffic/', str(root) + '/')
            logs = logs[:logs.index('# The local receiver')]
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            config = (f'worker_processes 1; pid {root}/nginx.pid; error_log {root}/error.log warn; '
                'events { worker_connections 64; } http { ' + maps + f' server {{ listen 127.0.0.1:{port}; '
                'server_name comics.nodelane.net; set_real_ip_from 127.0.0.1; real_ip_header X-Test-IP; '
                + logs + ' location / { default_type text/html; return 200 "page"; } '
                'location /v1/ { default_type application/json; return 200 "{}"; } '
                'location = /asset.css { default_type text/css; return 200 "body{}"; } }}')
            (root / 'nginx.conf').write_text(config)
            process = subprocess.Popen(['nginx', '-p', str(root), '-c', str(root / 'nginx.conf'), '-g', 'daemon off;'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                for _ in range(50):
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=.1): break
                    except OSError:
                        if process.poll() is not None: self.fail(process.stderr.read().decode())
                        time.sleep(.05)
                cases = [('/', {}), ('/asset.css', {}), ('/?code=SECRET', {}),
                    ('/v1/translations/12345678-1234-1234-1234-123456789abc/result?token=SECRET', {}),
                    ('/v1/translations/events', {}), ('/private-console/', {}),
                    ('/auth/callback/?code=SECRET', {}), ('/en/account/', {}), ('/', {'Purpose': 'prefetch'}),
                    ('/', {'User-Agent': 'Googlebot/2.1'}), ('/', {'User-Agent': 'NodeLane-Traffic-Probe/1.0'}),
                    ('/interaction/SECRET', {'Host': 'auth.nodelane.net'})]
                for route, extra in cases:
                    headers = {'Host': 'comics.nodelane.net', 'X-Test-IP': '8.8.8.8',
                        'User-Agent': 'Mozilla/5.0', 'Referer': 'https://example.com/private?token=SECRET', **extra}
                    with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}' + route, headers=headers)) as response:
                        self.assertEqual(response.status, 200)
            finally:
                subprocess.run(['nginx', '-p', str(root), '-c', str(root / 'nginx.conf'), '-s', 'quit'], capture_output=True)
                process.wait(timeout=5)
                process.stderr.close()
            access = (root / 'access.log').read_text()
            self.assertNotIn('SECRET', access)
            self.assertNotIn('12345678-', access)
            self.assertNotIn('private-console', access)
            self.assertIn('/v1/translations/:id/result', access)
            self.assertEqual(len(access.splitlines()), 8)
            self.assertEqual(len((root / 'pages.log').read_text().splitlines()), 3)
            self.assertEqual(len((root / 'web.log').read_text().splitlines()), 5)
            self.assertEqual(len((root / 'services.log').read_text().splitlines()), 2)
            self.assertEqual(len((root / 'streams.log').read_text().splitlines()), 1)

    def run_goaccess(self, root, files=(), flags=()):
        command = ['goaccess', '--no-global-config', '-p', str(DEPLOY / 'goaccess.conf'),
            '--persist', '--db-path=' + str(root), '--keep-last=30', '--tz=Asia/Shanghai',
            '-o', str(root / 'result.json'), *flags, *map(str, files)]
        result = subprocess.run(command, input=b'', capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        base = command[:len(command) - len(files)] if files else command
        data = expire_calendar_days(base, root / 'result.json', root, {'report_days': 30, 'timezone': 'Asia/Shanghai'})
        return data or {'visitors': {'data': []}}

    def test_incremental_same_second_rotation_and_age(self):
        with tempfile.TemporaryDirectory(prefix='traffic-incremental-') as work:
            root = Path(work)
            log = root / 'access.log'
            at = datetime.now(timezone.utc)
            log.write_text(line(at - timedelta(days=40)) + line(at))
            first = self.run_goaccess(root, [log])
            self.assertEqual(sum(row['hits']['count'] for row in first['visitors']['data']), 1)
            with log.open('a') as handle: handle.write(line(at))
            second = self.run_goaccess(root, [log], ['--restore'])
            self.assertEqual(sum(row['hits']['count'] for row in second['visitors']['data']), 2)
            old = root / 'access.log.1'
            log.rename(old)
            log.write_text(line(at + timedelta(seconds=1)))
            third = self.run_goaccess(root, [old, log], ['--restore'])
            self.assertEqual(sum(row['hits']['count'] for row in third['visitors']['data']), 3)
            fourth = self.run_goaccess(root, [old, log], ['--restore'])
            self.assertEqual(sum(row['hits']['count'] for row in fourth['visitors']['data']), 3)

    def test_idle_old_dataset_expires(self):
        with tempfile.TemporaryDirectory(prefix='traffic-expiry-') as work:
            root = Path(work)
            log = root / 'access.log'
            log.write_text(line(datetime.now(timezone.utc) - timedelta(days=40)))
            data = self.run_goaccess(root, [log])
            self.assertEqual(data['visitors']['data'], [])

    def test_rotation_resume_after_report_interruption(self):
        with tempfile.TemporaryDirectory(prefix='traffic-resume-') as work:
            root = Path(work)
            logs = root / 'logs'
            logs.mkdir()
            log = logs / 'access.log'
            at = datetime.now(timezone.utc)
            log.write_text(line(at))
            self.run_goaccess(root, [log])
            with log.open('a') as handle:
                handle.write(line(at))
            log.rename(logs / 'access.log-rotated')
            log.write_text(line(at + timedelta(seconds=1)))
            inputs = runpy.run_path(str(ROOT / 'scripts' / 'traffic.py'))['inputs']
            files = inputs(logs, 'access')
            data = self.run_goaccess(root, files, ['--restore'])
            self.assertEqual(sum(row['hits']['count'] for row in data['visitors']['data']), 3)

    def test_bots_and_geoip_and_bounded_batch_benchmark(self):
        import resource
        with tempfile.TemporaryDirectory(prefix='traffic-benchmark-') as work:
            root = Path(work)
            log = root / 'access.log'
            log.write_text(''.join(line(agent='Googlebot/2.1' if index % 10 == 0 else 'Mozilla/5.0', route=f'/page-{index % 20}') for index in range(50000)))
            geo = Path('/var/lib/nodelane-traffic/geoip')
            flags = ['--ignore-crawlers'] + ['--geoip-database=' + str(p) for p in geo.glob('*.mmdb')]
            started = time.monotonic()
            data = self.run_goaccess(root, [log], flags)
            self.assertEqual(sum(row['hits']['count'] for row in data['visitors']['data']), 45000)
            self.assertTrue(data['hosts']['data'])
            if list(geo.glob('*.mmdb')):
                self.assertIn('United States', json.dumps(data))
                self.assertIn('15169', json.dumps(data))
            print(json.dumps({'fixture_rows': 50000, 'parse_seconds': round(time.monotonic() - started, 3),
                'children_peak_rss_kib': resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss}))


if __name__ == '__main__':
    unittest.main()
