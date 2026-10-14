from pathlib import Path
from io import BytesIO
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from switch_release import activate, probe, release_lock
from prepare_static_release import main as prepare_main, prepare


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.active = self.root / 'api.inc'
        self.active.write_bytes(b'old')

    def test_document_worker_reuses_server_network_without_file_volume_or_public_port(self):
        deploy = Path(__file__).resolve().parents[2] / 'deploy'
        document = (deploy / 'compose.document.yaml').read_text(encoding='utf-8')
        server = (deploy / 'compose.server.yaml').read_text(encoding='utf-8')
        network = ('\nnetworks:\n  infrastructure:\n    external: true\n'
                   '    name: ${INFRA_NETWORK:-1panel-network}\n')
        self.assertIn(network, server)
        self.assertIn(network, document)
        self.assertIn('    networks: [infrastructure]\n', document)
        self.assertNotIn('volumes:', document)
        self.assertNotIn('ports:', document)

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

    def test_prepare_cli_forwards_optional_document_r2_origin(self):
        origin = 'https://account.r2.cloudflarestorage.com'
        argv = ['prepare_static_release.py', 'website', '--source', 'build', '--destination', 'static',
                '--release', 'v1', '--document-r2-origin', origin]
        with patch('sys.argv', argv), patch('prepare_static_release.prepare') as prepared, patch('builtins.print'):
            prepare_main()
        self.assertEqual(prepared.call_args.kwargs['document_r2_origin'], origin)

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
