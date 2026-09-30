"""Linux-only offline checks; not a substitute for a newly rented GPU instance."""
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

if sys.platform == 'linux':
    spec = importlib.util.spec_from_file_location('vast_bootstrap', Path(__file__).with_name('vast_bootstrap.py'))
    boot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(boot)


@unittest.skipUnless(sys.platform == 'linux', 'Vast bootstrap requires Linux')
class VastBootstrapTests(unittest.TestCase):
    def test_identity_rejects_placeholders_and_normalizes_origin(self):
        values = dict(NODE_CONTROL_URL='https://example.com/', NODE_ID='node-test',
                      NODE_TOKEN='fixture-token', NODE_RESOURCE_ID='vast:test:gpu:0')
        self.assertEqual(boot.validate_identity(values)['NODE_CONTROL_URL'], 'https://example.com')
        for key in values:
            for bad in ('', 'REPLACE_WITH_VALUE', 'a b'):
                with self.assertRaises(ValueError):
                    boot.validate_identity(values | {key: bad})
        for url in ('http://example.com', 'https://user:secret@example.com', 'https://example.com/path'):
            with self.assertRaises(ValueError):
                boot.validate_identity(values | {'NODE_CONTROL_URL': url})

    def test_archive_checksum_precedes_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'runtime.tar.gz'
            path.write_bytes(b'fixture')
            boot.verify_archive(path, hashlib.sha256(b'fixture').hexdigest())
            with self.assertRaises(ValueError):
                boot.verify_archive(path, '0' * 64)

    def test_wrong_existing_runtime_is_never_overwritten(self):
        from types import SimpleNamespace
        values = dict(NODE_CONTROL_URL='https://example.com', NODE_ID='node-test',
                      NODE_TOKEN='fixture-token', NODE_RESOURCE_ID='vast:test:gpu:0')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / '.runtime-sha256'
            marker.write_text('old-version')
            with patch.dict(os.environ, values), patch.object(boot, 'ROOT', root), \
                 patch.object(boot.os, 'geteuid', return_value=0), \
                 patch.object(boot.ctypes, 'CDLL'), patch.object(boot.shutil, 'which', return_value='/bin/supervisorctl'), \
                 patch.object(boot.platform, 'freedesktop_os_release', return_value={'ID':'ubuntu','VERSION_ID':'24.04'}):
                with self.assertRaises(ValueError):
                    boot.install(SimpleNamespace(sha256='a' * 64,
                        url='https://github.com/Wy2926/node-comics/releases/download/v1/runtime.tar.gz'))
            self.assertEqual(marker.read_text(), 'old-version')


if __name__ == '__main__':
    unittest.main()
