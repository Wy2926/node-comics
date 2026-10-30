import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('traffic', Path(__file__).resolve().parents[1] / 'traffic.py')
traffic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(traffic)


class TrafficTests(unittest.TestCase):
    def test_error_redacts_request_upstream_referrer_and_private_file(self):
        value = traffic.redact_error(b'<131>Oct 31 00:00:00 host nodelane: 2026/10/31 [error] 12#12: *45 open() "/private/secret" failed (2: No such file), client: 8.8.8.8, server: comics.nodelane.net, request: "GET /auth/callback?code=secret HTTP/1.1", upstream: "http://upstream/?token=secret", referrer: "https://example/?key=secret"')
        self.assertNotIn('secret', str(value))
        self.assertEqual(value['client'], '8.8.8.8')
        self.assertEqual(value['connection'], '45')
        self.assertIn('open()', value['message'])
        self.assertEqual(value['level'], 'error')

    def test_error_preserves_upstream_failure_without_url(self):
        value = traffic.redact_error(b'[error] 12#12: *46 connect() failed (111: Connection refused) while connecting to upstream, client: 2001:db8::1, request: "GET /private HTTP/1.1"')
        self.assertIn('Connection refused', value['message'])
        self.assertNotIn('/private', str(value))
        self.assertEqual(value['client'], '2001:db8::1')

    def test_retention_only_removes_archives_not_active_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            active, old, recent = [root / name for name in ('access.log', 'access.log-old.gz', 'access.log-new.gz')]
            for path in (active, old, recent):
                path.write_bytes(b'x' * 100)
            now = time.time()
            os.utime(active, (now - 9 * 86400,) * 2)
            os.utime(old, (now - 9 * 86400,) * 2)
            result = traffic.clean_archives([root], 7, 10000, at=now)
            self.assertEqual(result['removed_bytes'], 100)
            self.assertTrue(active.exists())
            self.assertTrue(recent.exists())
            self.assertFalse(old.exists())

    def test_capacity_removes_oldest_archive_first(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            active, first, second = [root / name for name in ('access.log', 'access.log-1', 'access.log-2')]
            for path in (active, first, second):
                path.write_bytes(b'x' * 100)
            os.utime(first, (time.time() - 20,) * 2)
            result = traffic.clean_archives([root], 7, 200)
            self.assertFalse(first.exists())
            self.assertTrue(second.exists())
            self.assertTrue(active.exists())
            self.assertEqual(result['remaining_bytes'], 200)

    def test_html_title_and_messages_escape_markup(self):
        self.assertIn('&lt;script&gt;', traffic.page('<script>', ''))


if __name__ == '__main__':
    unittest.main()
