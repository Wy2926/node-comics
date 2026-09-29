"""Verifier safety checks, no network/model calls."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import httpx
from PIL import Image

spec = importlib.util.spec_from_file_location('overlay_live', Path(__file__).parents[1] / 'verify_overlay_live.py')
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


class Agent:
    def poll_control(self):
        pass

    def reap(self):
        pass


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'page.webp'
        Image.new('RGB', (3, 4), 'white').save(self.source, lossless=True)

    def tearDown(self):
        self.temp.cleanup()

    def run_scenario(self, scenario):
        calls, writes, uploads = [], [], []
        artifact = None
        result = {'kind': 'no_text', 'representation': 'original',
                  'input_sha256': hashlib.sha256(self.source.read_bytes()).hexdigest(),
                  'normalization_version': 1, 'width': 3, 'height': 4, 'artifact': artifact}

        def handler(request):
            nonlocal result
            calls.append((request.method, request.url.path))
            path = request.url.path
            if scenario == 'artifact' and result['artifact'] is None:
                result = {**result, 'kind': 'translated', 'representation': 'full-image-v1',
                          'artifact': {'path': path + '/result', 'mime': 'image/webp',
                                       'byte_size': self.source.stat().st_size,
                                       'sha256': hashlib.sha256(self.source.read_bytes()).hexdigest()}}
            if request.method == 'GET' and path.endswith('/result'):
                self.assertEqual(request.headers.get('X-Translation-Protocol'), 'overlay-v1')
                token = request.headers.get('Authorization')
                if token == 'Bearer test':
                    return httpx.Response(200, content=self.source.read_bytes(), headers={'Content-Type': 'image/webp'})
                return httpx.Response(404 if token else 401)
            if request.method == 'GET' and path.endswith('/classic'):
                return httpx.Response(200, json={'segments': [], 'translations': {}})
            if request.method == 'PUT' and path.endswith('/input'):
                uploads.append(request)
                self.assertEqual(request.headers['content-type'], 'image/webp')
                return httpx.Response(202, json={'state': 'running'})
            if request.method == 'PUT':
                intent = json.loads((self.root / 'run' / 'intent.json').read_text())
                self.assertTrue(path.endswith(intent['request_id']))
                writes.append(request)
                if scenario == '429' and len(writes) == 1:
                    return httpx.Response(429, headers={'Retry-After': '.1'}, json={'error': {'code': 'RATE_LIMITED'}})
                if scenario == 'ambiguous' and len(writes) == 1:
                    raise httpx.ReadTimeout('secret must never enter output', request=request)
                if len(writes) == (2 if scenario == '429' else 1):
                    return httpx.Response(202, json={'state': 'needs_input'})
            if scenario == 'failed':
                return httpx.Response(200, json={'state': 'failed', 'error': {'code': 'TEXT_UNAVAILABLE', 'message': 'private OCR'}})
            return httpx.Response(200, json={'state': 'succeeded', 'result': result})

        with httpx.Client(base_url='https://localhost', transport=httpx.MockTransport(handler)) as client:
            protocol = {'X-Translation-Protocol': 'overlay-v1'}
            item = live.run_page(client, {**protocol, 'Authorization': 'Bearer test'},
                                 {**protocol, 'Authorization': 'Bearer other'}, Agent(), self.source, self.root / 'run', 1, 5)
        return item, writes, uploads, calls

    def test_anonymous_artifact_check_passes_protocol_before_authentication(self):
        item, _, _, _ = self.run_scenario('artifact')
        self.assertEqual(item['state'], 'succeeded')
        self.assertTrue(item['checks']['anonymous_denied'])
        self.assertTrue(item['checks']['other_account_denied'])

    def test_429_keeps_uuid_and_actual_mime_and_original_has_no_download(self):
        item, writes, uploads, calls = self.run_scenario('429')
        self.assertEqual(item['state'], 'succeeded')
        self.assertEqual(item['admission_retries'], 1)
        self.assertEqual(len({str(r.url) for r in writes}), 1)
        self.assertEqual(len(uploads), 1)
        self.assertFalse(any(p.endswith('/result') for _, p in calls))
        self.assertEqual((self.root / 'run' / 'source.webp').read_bytes(), self.source.read_bytes())
        self.assertTrue(item['checks']['original_without_download'])

    def test_ambiguous_submit_is_observed_before_completed_uuid_replay(self):
        item, writes, uploads, calls = self.run_scenario('ambiguous')
        self.assertEqual(item['state'], 'succeeded')
        self.assertTrue(item['ambiguous_write'])
        self.assertEqual(len(writes), 2)  # Initial ambiguous write + terminal replay only.
        self.assertEqual(len(uploads), 0)
        self.assertEqual(calls[1][0], 'GET')

    def test_terminal_failure_is_returned_without_retry_or_error_text(self):
        item, writes, uploads, _ = self.run_scenario('failed')
        self.assertEqual(item['state'], 'failed')
        self.assertEqual(item['error_code'], 'TEXT_UNAVAILABLE')
        self.assertEqual(len(writes), 1)
        self.assertNotIn('private OCR', json.dumps(item))

    def test_natural_sort_excludes_export_manifest(self):
        for name in ['00010.webp', '00002.webp', 'export-manifest.json']:
            (self.root / name).touch()
        self.assertEqual([p.name for p in live.source_files(self.root)], ['00002.webp', '00010.webp', 'page.webp'])


if __name__ == '__main__':
    unittest.main()
