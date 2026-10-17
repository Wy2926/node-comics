"""Optional file capability must not block a healthy image-only node."""
from contextlib import ExitStack
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('node_preflight', Path(__file__).with_name('preflight.py'))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


@unittest.skipUnless(sys.platform == 'linux', 'Target preflight requires Linux file permissions')
class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.path = self.root / 'node.json'
        self.path.write_text('{}')
        self.path.chmod(0o600)
        self.state = self.root / 'state'
        config = ModuleType('classic_node.config')
        config.load = Mock(return_value={'state_dir': str(self.state), 'document_spool_bytes': 6 * 1024 ** 3,
            'engine': {'gpu': 0}, 'control_url': 'https://example.invalid'})
        documents = ModuleType('comic_document_files')
        self.probe = documents.check_parser_sandbox = Mock(return_value=True)
        self.stack.enter_context(patch.dict(sys.modules, {
            'classic_node.config': config, 'comic_document_files': documents}))
        self.stack.enter_context(patch.object(preflight.os, 'geteuid', return_value=10001, create=True))
        self.stack.enter_context(patch.object(preflight.shutil, 'disk_usage',
            return_value=SimpleNamespace(free=16 * 1024 ** 3)))
        self.stack.enter_context(patch.object(preflight.subprocess, 'run',
            return_value=SimpleNamespace(stdout='NVIDIA GeForce RTX 3080,580.159.03,10240')))
        driver = Mock()
        driver.cuInit.return_value = 0
        def version(pointer):
            pointer._obj.value = 12060
            return 0
        driver.cuDriverGetVersion.side_effect = version
        self.stack.enter_context(patch.object(preflight.ctypes, 'CDLL', return_value=driver))
        self.stack.enter_context(patch.object(preflight, 'host_security',
            side_effect=lambda: {'landlock_abi': 1, 'landlock_errno': 0, 'seccomp': '2'}))

    def test_unavailable_sandbox_allows_image_only_node(self):
        self.probe.side_effect = RuntimeError('private sandbox diagnostic')
        result = preflight.check(self.path, local_only=True)
        self.assertTrue(result['ready'])
        self.assertNotIn('code', result)
        security = result['checks']['security']
        self.assertIsNone(security['document_protocol'])
        self.assertFalse(security['denial_probe'])
        self.assertEqual(security['code'], 'NODE_PARSER_SANDBOX_UNAVAILABLE')
        self.assertNotIn('private sandbox diagnostic', str(result))
        self.probe.assert_called_once_with(self.state, require_sandbox=True)

    def test_supported_sandbox_keeps_document_protocol(self):
        result = preflight.check(self.path, local_only=True)
        self.assertTrue(result['ready'])
        security = result['checks']['security']
        self.assertEqual(security['document_protocol'], 2)
        self.assertTrue(security['denial_probe'])
        self.assertEqual(security['parser'], 'landlock-seccomp')

    def test_lost_sandbox_with_existing_file_work_still_blocks_start(self):
        (self.state / 'documents/job/1').mkdir(parents=True)
        self.probe.side_effect = RuntimeError('sandbox unavailable')
        result = preflight.check(self.path, local_only=True)
        self.assertFalse(result['ready'])
        self.assertEqual(result['code'], 'NODE_PARSER_SANDBOX_UNAVAILABLE')
        self.assertTrue((self.state / 'documents/job/1').is_dir())

    def test_image_only_node_still_requires_control_tls(self):
        self.probe.side_effect = RuntimeError('sandbox unavailable')
        with patch.object(preflight.socket, 'create_connection', side_effect=OSError('unreachable')):
            result = preflight.check(self.path)
        self.assertFalse(result['ready'])
        self.assertEqual(result['code'], 'NODE_CONTROL_TLS_UNREACHABLE')


if __name__ == '__main__':
    unittest.main()
