from pathlib import Path
from io import BytesIO
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from switch_release import activate, probe, release_lock
from prepare_static_release import prepare


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.active = self.root / 'api.inc'
        self.active.write_bytes(b'old')

    def test_probe_identifies_release_checker_and_bypasses_cache(self):
        response = BytesIO(b'{"status":"ready","release":"v1"}')
        with patch('switch_release.urllib.request.urlopen', return_value=response) as opened:
            probe('https://example.test/health/ready', 'v1')
        request = opened.call_args.args[0]
        self.assertEqual(request.get_header('Cache-control'), 'no-cache')
        self.assertIn('NodeComicsReleaseCheck/', request.get_header('User-agent'))

    def test_success_keeps_previous_and_does_not_stop_services(self):
        calls = []
        activate(self.active, b'new', lambda *args: calls.append(args), lambda: None)
        self.assertEqual(calls, [('-t',), ('-s', 'reload')])
        self.assertEqual(self.active.read_bytes(), b'new')
        self.assertEqual(self.active.with_suffix('.inc.previous').read_bytes(), b'old')

    def test_bad_config_and_failed_probe_restore_old_config(self):
        for fail_test in (True, False):
            def nginx(*args):
                if fail_test and self.active.read_bytes() == b'new':
                    raise RuntimeError('bad config')

            def failed():
                raise RuntimeError('wrong release')

            with self.assertRaises(RuntimeError):
                activate(self.active, b'new', nginx, failed, timeout=0)
            self.assertEqual(self.active.read_bytes(), b'old')

    def test_lock_prevents_overlapping_releases(self):
        with release_lock(self.root):
            with self.assertRaises(OSError):
                activate(self.active, b'new', lambda *args: None, lambda: None)
        self.assertEqual(self.active.read_bytes(), b'old')

    def test_preflight_failure_does_not_touch_active_file(self):
        def rejected():
            raise RuntimeError('another release has become active')
        with self.assertRaises(RuntimeError):
            activate(self.active, b'new', lambda *args: None, lambda: None, preflight=rejected)
        self.assertEqual(self.active.read_bytes(), b'old')

    def test_private_entry_is_preserved_and_reserved_entries_rejected(self):
        source = self.root / 'build'
        source.mkdir()
        (source / 'index.html').write_text('console', encoding='utf-8')
        config = prepare('admin', source, self.root / 'static', 'v1', '/www/node-comics', admin_path='/existing-panel/')
        self.assertIn('location = /existing-panel/', config.read_text())
        for path in ('/admin/', '/v1/', '/billing/', '/webhooks/'):
            with self.assertRaises(ValueError):
                prepare('admin', source, self.root / 'static', 'v2', '/www/node-comics', admin_path=path)

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
