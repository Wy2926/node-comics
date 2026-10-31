"""Focused regressions for proxy configuration, log privacy and GeoIP updates."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


errors = load('nginx_error_log')
geoip = load('update_geoip')
config = load('configure_nginxpulse')


class NginxSupportTests(unittest.TestCase):
    def test_configurable_proxy_address(self):
        with tempfile.TemporaryDirectory() as temporary:
            env = Path(temporary) / 'pulse.env'
            env.write_text('NGINXPULSE_ORIGIN=https://stats.example.com:8443\n'
                           'NGINXPULSE_BASE_PATH=site-stats\nNGINXPULSE_PORT=19090\n')
            values = config.read_settings(env)
            templates = Path(__file__).resolve().parents[2] / 'deploy' / 'nginxpulse'
            rendered = config.render(values, templates)
            self.assertIn('"https://stats.example.com:8443" 1;', rendered['nginx.http.conf'])
            self.assertIn('~^/(site-stats|health)(/|$) 0;', rendered['nginx.http.conf'])
            self.assertIn('location ^~ /site-stats/', rendered['nginx.dashboard.inc'])
            self.assertIn('http://127.0.0.1:19090;', rendered['nginx.dashboard.inc'])
            self.assertIn('$remote_addr', rendered['nginx.http.conf'])
            for key, value in [('NGINXPULSE_ORIGIN', 'https://example.com/extra'),
                               ('NGINXPULSE_ORIGIN', 'http://example.com'),
                               ('NGINXPULSE_BASE_PATH', 'one/two'),
                               ('NGINXPULSE_BASE_PATH', 'v1'),
                               ('NGINXPULSE_BASE_PATH', 'bad;return'),
                               ('NGINXPULSE_PORT', '70000')]:
                with self.subTest(key=key, value=value):
                    invalid = {**values, key: value}
                    env.write_text('\n'.join(k + '=' + v for k, v in invalid.items()))
                    with self.assertRaises(ValueError):
                        config.read_settings(env)

    def test_error_redacts_private_context(self):
        value = errors.redact_error(b'[error] 12#12: *45 open() "/private/SECRET" failed, client: 8.8.8.8, request: "GET /auth/callback?code=SECRET HTTP/1.1", upstream: "http://upstream/?token=SECRET", referrer: "https://example/?key=SECRET"')
        self.assertNotIn('SECRET', str(value))
        self.assertEqual(value['client'], '8.8.8.8')
        self.assertEqual(value['connection'], '45')
        self.assertIn('open()', value['message'])

    def test_error_preserves_failure_and_ipv6(self):
        value = errors.redact_error(b'[error] 12#12: *46 connect() failed (111: Connection refused) while connecting to upstream, client: 2001:db8::1, request: "GET /private HTTP/1.1"')
        self.assertIn('Connection refused', value['message'])
        self.assertNotIn('/private', str(value))
        self.assertEqual(value['client'], '2001:db8::1')

    def test_geoip_validates_and_updates_once_per_month(self):
        payload = b'synthetic-mmdb'
        database = MagicMock()
        database.__enter__.return_value.metadata.return_value.database_type = 'DBIP-City-Lite'
        mmdb = SimpleNamespace(open_database=MagicMock(return_value=database))
        with tempfile.TemporaryDirectory() as temporary, patch.dict(sys.modules, {'maxminddb': mmdb}), \
                patch.object(geoip.urllib.request, 'urlopen', return_value=io.BytesIO(gzip.compress(payload))) as request:
            root = Path(temporary)
            geoip.update(root, month='2026-10')
            geoip.update(root, month='2026-10')
            self.assertEqual(request.call_count, 1)
            self.assertEqual((root / 'city.mmdb').read_bytes(), payload)
            manifest = json.loads((root / 'sources.json').read_text())
            self.assertEqual(manifest['sources']['city']['sha256'], hashlib.sha256(payload).hexdigest())
            self.assertEqual(manifest['license'], 'CC-BY-4.0')

    def test_geoip_invalid_download_preserves_existing_database(self):
        mmdb = SimpleNamespace(open_database=MagicMock(side_effect=ValueError('invalid database')))
        with tempfile.TemporaryDirectory() as temporary, patch.dict(sys.modules, {'maxminddb': mmdb}), \
                patch.object(geoip.urllib.request, 'urlopen', return_value=io.BytesIO(gzip.compress(b'invalid'))):
            root = Path(temporary)
            (root / 'city.mmdb').write_bytes(b'previous-valid-database')
            (root / 'sources.json').write_text('{"month":"2026-09"}')
            with self.assertRaises(ValueError):
                geoip.update(root, month='2026-10')
            self.assertEqual((root / 'city.mmdb').read_bytes(), b'previous-valid-database')
            self.assertEqual(json.loads((root / 'sources.json').read_text())['month'], '2026-09')
            self.assertFalse((root / '.city.tmp').exists())


if __name__ == '__main__':
    unittest.main()
