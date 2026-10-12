import base64
from contextlib import redirect_stdout
import hashlib
from io import BytesIO, StringIO
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from xml.etree import ElementTree
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import verify_extension_release as verifier


VERSIONS = {'chrome': '0.11.3', 'edge': '0.10.2', 'firefox': '0.11.3'}
TYPES = {'crx': 'application/x-chrome-extension', 'zip': 'application/zip', 'xpi': 'application/x-xpinstall'}


def package(browser='chrome', suffix='crx', key=None):
    manifest = {'version': VERSIONS[browser], 'manifest_version': 3}
    if key is not None:
        manifest['key'] = key
    if browser == 'firefox':
        manifest['browser_specific_settings'] = {'gecko': {'id': 'comics@nodelane.net'}}
    output = BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        archive.writestr('manifest.json', json.dumps(manifest))
        archive.writestr('background.js', 'const api="https://comics.nodelane.net";')
        if browser == 'firefox':
            for name in ('mozilla.rsa', 'mozilla.sf', 'manifest.mf'):
                archive.writestr('META-INF/' + name, b'signature fixture')
    data = output.getvalue()
    # Header contents need not be a real signature: the mocked official hash is
    # the trust anchor, just as the real HTTPS store response is in production.
    header = b'fixture-header'
    return b'Cr24' + struct.pack('<II', 3, len(header)) + header + data if suffix == 'crx' else data


def metadata(browser, data, *, app_changes=None, update_changes=None):
    root = ElementTree.Element('gupdate', xmlns='http://www.google.com/update2/response')
    app = ElementTree.SubElement(root, 'app', {
        'appid': verifier.CHROMIUM_STORE_IDS[browser], 'status': 'ok', **(app_changes or {}),
    })
    ElementTree.SubElement(app, 'updatecheck', {
        'version': VERSIONS[browser] + ('.0' if browser == 'edge' else ''),
        'status': 'ok', 'hash_sha256': hashlib.sha256(data).hexdigest().upper(),
        'size': str(len(data)), **(update_changes or {}),
    })
    return ElementTree.tostring(root)


class ExtensionReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def verify(self, browser='chrome', *, suffix='crx', data=None, response=None, release_changes=None, public=False):
        data = package(browser, suffix) if data is None else data
        version = VERSIONS[browser]
        filename = f'node-comics-{version}-{browser}.{suffix}'
        release = {
            'browser': browser, 'version': version, 'filename': filename,
            'path': '/downloads/' + filename, 'content_type': TYPES.get(suffix, 'application/zip'),
            'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'download_url': 'https://downloads.example.test/' + filename if public else '',
            **(release_changes or {}),
        }
        archive_path = self.root / filename
        archive_path.write_bytes(data)
        catalog_path = self.root / 'catalog.json'
        catalog_path.write_text(json.dumps({'current': version, 'releases': [release]}), encoding='utf-8')
        responses = []
        if suffix == 'crx':
            responses.append(BytesIO(response if response is not None else metadata(browser, data)))
        elif suffix == 'xpi':
            responses.append(BytesIO(json.dumps({
                'guid': 'comics@nodelane.net', 'current_version': {
                    'version': version, 'file': {'status': 'public', 'hash': 'sha256:' + release['sha256'], 'size': len(data)},
                },
            }).encode()))
        if public:
            responses.append(BytesIO(data))
        arguments = ['verify_extension_release.py', '--browser', browser, '--zip', str(archive_path), '--manifest', str(catalog_path)]
        output = StringIO()
        with patch.object(sys, 'argv', arguments), patch.object(verifier, 'urlopen', side_effect=responses) as opened, redirect_stdout(output):
            verifier.main()
        return json.loads(output.getvalue()), opened

    def test_store_crx_without_manifest_key_uses_fixed_official_endpoints(self):
        for browser, hostname in [('chrome', 'clients2.google.com'), ('edge', 'edge.microsoft.com')]:
            with self.subTest(browser=browser):
                result, opened = self.verify(browser)
                self.assertTrue(result['package_verified'])
                opened.assert_called_once()
                url = urlsplit(opened.call_args.args[0])
                self.assertEqual((url.scheme, url.hostname), ('https', hostname))
                query = parse_qs(url.query)
                self.assertEqual(parse_qs(query['x'][0])['id'], [verifier.CHROMIUM_STORE_IDS[browser]])

    def test_wrong_store_identity_or_status_is_rejected(self):
        data = package()
        for changes in ({'appid': verifier.CHROMIUM_STORE_IDS['edge']}, {'status': 'error'}):
            with self.subTest(changes=changes), self.assertRaises(AssertionError):
                self.verify(data=data, response=metadata('chrome', data, app_changes=changes))

    def test_wrong_hash_size_or_update_status_is_rejected(self):
        data = package()
        for changes in ({'hash_sha256': '0' * 64}, {'hash_sha256': ''}, {'size': str(len(data) + 1)}, {'status': 'noupdate'}):
            with self.subTest(changes=changes), self.assertRaises(AssertionError):
                self.verify(data=data, response=metadata('chrome', data, update_changes=changes))

    def test_only_trailing_zero_version_components_are_equivalent(self):
        data = package('edge')
        for version in ('0.10.3', '0.10.2.1', '00.10.2', '0.10.02', '0.10.2.00', '0.10.2-beta', ''):
            with self.subTest(version=version), self.assertRaises(AssertionError):
                self.verify('edge', data=data, response=metadata('edge', data, update_changes={'version': version}))
        self.verify('edge', data=data, response=metadata('edge', data, update_changes={'version': '0.10.2.0'}))

    def test_store_size_may_be_absent_and_codebase_is_never_fetched(self):
        data = package('edge')
        root = ElementTree.fromstring(metadata('edge', data))
        update = root[0][0]
        del update.attrib['size']
        update.set('codebase', 'http://untrusted.example.test/private?token=fixture')
        _, opened = self.verify('edge', data=data, response=ElementTree.tostring(root))
        opened.assert_called_once()

    def test_ambiguous_store_response_is_rejected(self):
        data = package()
        root = ElementTree.fromstring(metadata('chrome', data))
        root.append(ElementTree.fromstring(metadata('chrome', data))[0])
        with self.assertRaises(AssertionError):
            self.verify(data=data, response=ElementTree.tostring(root))

    def test_crx_magic_format_and_header_boundaries_are_checked(self):
        valid = package()
        invalid = [valid[:10], b'Bad!' + valid[4:], valid[:4] + struct.pack('<I', 2) + valid[8:]]
        invalid += [valid[:8] + struct.pack('<I', size) + valid[12:] for size in (0, len(valid) - 12, 0xffffffff)]
        invalid.append(package(suffix='zip'))
        for data in invalid:
            with self.subTest(prefix=data[:12]), self.assertRaises(AssertionError):
                self.verify(data=data)

    def test_crx_still_checks_the_embedded_zip_crc(self):
        data = package().replace(b'const api=', b'const bad=', 1)
        with self.assertRaises(AssertionError):
            self.verify(data=data)

    def test_wrong_suffix_content_type_and_catalog_hash_are_rejected(self):
        for changes in ({'content_type': 'application/zip'}, {'sha256': '0' * 64}, {'filename': 'node-comics-0.11.3-chrome.exe'}):
            with self.subTest(changes=changes), self.assertRaises(AssertionError):
                self.verify(release_changes=changes)
        with self.assertRaises(AssertionError):
            self.verify('firefox', suffix='crx', response=b'')

    def test_manual_zip_still_requires_its_fixed_public_key(self):
        key = base64.b64encode(b'fixture fixed public key').decode()
        identity = ''.join(chr(97 + int(char, 16)) for char in hashlib.sha256(base64.b64decode(key)).hexdigest()[:32])
        with patch.dict(verifier.CHROMIUM_STORE_IDS, {'chrome': identity}):
            result, opened = self.verify(suffix='zip', data=package(suffix='zip', key=key))
            self.assertTrue(result['package_verified'])
            opened.assert_not_called()
            for invalid_key in (None, '', base64.b64encode(b'different key').decode()):
                with self.subTest(key=invalid_key), self.assertRaises(AssertionError):
                    self.verify(suffix='zip', data=package(suffix='zip', key=invalid_key))

    def test_firefox_still_checks_public_amo_metadata_and_signature_files(self):
        result, opened = self.verify('firefox', suffix='xpi')
        self.assertTrue(result['package_verified'])
        self.assertEqual(opened.call_args.args[0], 'https://addons.mozilla.org/api/v5/addons/addon/nodelane-comics/')

    def test_public_crx_readback_reuses_the_existing_size_and_hash_check(self):
        result, opened = self.verify(public=True)
        self.assertTrue(result['public_download_verified'])
        self.assertEqual(opened.call_count, 2)
        self.assertEqual(opened.call_args.args[0].full_url, result['download_url'])


if __name__ == '__main__':
    unittest.main()
