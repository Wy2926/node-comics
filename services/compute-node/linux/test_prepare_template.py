"""Pinned template generation uses Git blobs and one bounded public download."""
from contextlib import contextmanager, redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request

spec = importlib.util.spec_from_file_location('prepare_template', Path(__file__).with_name('prepare_template.py'))
template = importlib.util.module_from_spec(spec)
spec.loader.exec_module(template)


@unittest.skipUnless(shutil.which('git'), 'requires Git')
class PrepareTemplateTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.bootstrap = self.root / template.BOOTSTRAP_PATH
        self.bootstrap.parent.mkdir(parents=True)
        self.template_path = self.root / template.TEMPLATE_PATH
        self.original_template = json.loads(Path(__file__).with_name('vast-template.json').read_text())
        self.template_path.write_text(json.dumps(self.original_template), encoding='utf-8')
        self.git('init')
        self.original = b'print("committed bootstrap")\n'
        self.revision = self.commit(self.original)
        repository = patch.object(template, 'REPOSITORY_ROOT', self.root)
        repository.start()
        self.addCleanup(repository.stop)

    def git(self, *arguments):
        return subprocess.check_output(['git', '-C', str(self.root),
            '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false',
            '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
            *arguments], stderr=subprocess.PIPE)

    def commit(self, content, template_value=None):
        self.bootstrap.write_bytes(content)
        if template_value is not None:
            self.template_path.write_text(json.dumps(template_value), encoding='utf-8')
        self.git('add', template.BOOTSTRAP_PATH, template.TEMPLATE_PATH)
        self.git('commit', '-m', 'fixture')
        return self.git('rev-parse', 'HEAD').decode().strip()

    @contextmanager
    def remote(self, content=None, failure=None):
        response = io.BytesIO(self.original if content is None else content)
        opener = Mock()
        opener.open.side_effect = failure
        opener.open.return_value = response
        with patch.object(template, 'build_opener', return_value=opener):
            yield opener

    def assert_pinned(self, value, revision, content):
        url = f'{template.RAW_ORIGIN}/Wy2926/node-comics/{revision}/{template.BOOTSTRAP_PATH}'
        self.assertIn(url, value['onstart'])
        self.assertIn(hashlib.sha256(content).hexdigest(), value['onstart'])
        self.assertIn('--revision ' + revision, value['onstart'])
        self.assertNotIn('REPLACE_WITH_BOOTSTRAP', value['onstart'])
        self.assertNotIn('REPLACE_WITH_SOURCE', value['onstart'])
        self.assertIn('REPLACE_WITH_NODE_TOKEN', value['env'])
        return url

    def test_dirty_bootstrap_does_not_change_published_hash(self):
        self.bootstrap.write_bytes(b'print("dirty local edit")\r\n')
        with self.remote() as opener:
            value = template.render(self.revision)
        url = self.assert_pinned(value, self.revision, self.original)
        opener.open.assert_called_once_with(url, timeout=30)
        self.assertNotIn(hashlib.sha256(self.bootstrap.read_bytes()).hexdigest(), value['onstart'])

    def test_crlf_checkout_does_not_change_git_blob_hash(self):
        self.bootstrap.write_bytes(self.original.replace(b'\n', b'\r\n'))
        with self.remote():
            value = template.render(self.revision)
        self.assert_pinned(value, self.revision, self.original)

    def test_older_commit_uses_its_blob_not_head(self):
        newer = self.commit(b'print("newer committed bootstrap")\n',
                            self.original_template | {'readme': 'newer-template-protocol'})
        self.assertNotEqual(newer, self.revision)
        with self.remote():
            value = template.render(self.revision)
        self.assert_pinned(value, self.revision, self.original)
        self.assertEqual(value['readme'], self.original_template['readme'])

    def test_dirty_template_cannot_change_a_pinned_generation(self):
        self.template_path.write_text('{"onstart": "dirty protocol"}')
        with self.remote():
            value = template.render(self.revision)
        self.assert_pinned(value, self.revision, self.original)
        self.assertNotIn('dirty protocol', value['onstart'])

    def test_old_archive_template_is_rejected_before_network_access(self):
        revision = self.commit(self.original, self.original_template | {
            'onstart': 'python3 bootstrap.py --archive RUNTIME_URL'})
        with self.remote() as opener, self.assertRaisesRegex(ValueError, 'unsupported template'):
            template.render(revision)
        opener.open.assert_not_called()

    def test_each_online_source_placeholder_is_required(self):
        for placeholder in template.PLACEHOLDERS:
            value = self.original_template | {
                'onstart': self.original_template['onstart'].replace(placeholder, 'missing')}
            revision = self.commit(self.original, value)
            with self.subTest(placeholder=placeholder), self.remote() as opener:
                with self.assertRaisesRegex(ValueError, 'unsupported template'):
                    template.render(revision)
                opener.open.assert_not_called()

    def test_unpublished_commit_is_refused(self):
        failure = HTTPError('https://raw.githubusercontent.com/fixture', 404, 'Not Found', {}, None)
        with self.remote(failure=failure), self.assertRaisesRegex(ValueError, 'unavailable'):
            template.render(self.revision)

    def test_unavailable_public_endpoint_is_refused(self):
        with self.remote(failure=TimeoutError()), self.assertRaisesRegex(ValueError, 'unavailable'):
            template.render(self.revision)

    def test_mismatched_public_bytes_are_refused(self):
        with self.remote(b'other content'), self.assertRaisesRegex(ValueError, 'does not match'):
            template.render(self.revision)

    def test_oversized_public_body_is_bounded_and_refused(self):
        response = io.BytesIO(b'x' * 4096)
        opener = Mock()
        opener.open.return_value = response
        with patch.object(template, 'build_opener', return_value=opener), \
                patch.object(response, 'read', wraps=response.read) as read:
            with self.assertRaisesRegex(ValueError, 'does not match'):
                template.render(self.revision)
            read.assert_called_once_with(len(self.original) + 1)

    def test_missing_commit_is_refused_before_network_access(self):
        with self.remote() as opener, self.assertRaisesRegex(ValueError, 'must contain'):
            template.render('0' * 40)
        opener.open.assert_not_called()

    def test_revision_must_be_full_commit_sha(self):
        with self.remote() as opener:
            for revision in ('main', 'a' * 39, 'A' * 40, '../revision'):
                with self.subTest(revision=revision), self.assertRaisesRegex(ValueError, 'full published'):
                    template.render(revision)
        opener.open.assert_not_called()

    def test_cli_generates_only_after_remote_verification(self):
        output = self.root / 'generated.json'
        stdout = io.StringIO()
        arguments = ['prepare_template.py', '--revision', self.revision, '--output', str(output)]
        with self.remote(), patch.object(sys, 'argv', arguments), redirect_stdout(stdout):
            template.main()
        self.assert_pinned(json.loads(output.read_text(encoding='utf-8')), self.revision, self.original)
        self.assertEqual(json.loads(stdout.getvalue()), {
            'template': str(output), 'published': False, 'remote_bootstrap_verified': True})

    def test_cli_does_not_write_an_unverified_template(self):
        output = self.root / 'not-created.json'
        arguments = ['prepare_template.py', '--revision', self.revision, '--output', str(output)]
        with self.remote(b'mismatch'), patch.object(sys, 'argv', arguments), self.assertRaises(ValueError):
            template.main()
        self.assertFalse(output.exists())


class RedirectTests(unittest.TestCase):
    def test_bootstrap_redirects_must_preserve_the_fixed_https_host(self):
        handler = template.PinnedHostRedirects()
        request = Request(template.RAW_ORIGIN + '/source')
        allowed = template.RAW_ORIGIN + '/redirected-source'
        self.assertEqual(handler.redirect_request(request, None, 302, 'Found', {}, allowed).full_url, allowed)
        for target in ('http://raw.githubusercontent.com/source', 'https://example.com/source',
                'https://raw.githubusercontent.com@example.com/source'):
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, 'HTTPS GitHub raw host'):
                handler.redirect_request(request, None, 302, 'Found', {}, target)


if __name__ == '__main__':
    unittest.main()
