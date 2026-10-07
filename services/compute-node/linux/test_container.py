"""Small offline checks for the container's operational contract."""
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('node_container_health', ROOT / 'healthcheck.py')
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)
asset_spec = importlib.util.spec_from_file_location('node_container_assets', ROOT / 'build_assets.py')
assets = importlib.util.module_from_spec(asset_spec)
asset_spec.loader.exec_module(assets)
sys.path.insert(0, str(ROOT.parents[1] / 'classic-engine'))
entry_spec = importlib.util.spec_from_file_location('node_container_entry', ROOT / 'entrypoint.py')
entry = importlib.util.module_from_spec(entry_spec)
entry_spec.loader.exec_module(entry)


class ContainerTests(unittest.TestCase):
    def test_asset_build_refuses_existing_bundle(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(assets, 'prepare') as prepare:
            with self.assertRaises(FileExistsError):
                assets.build(Path(directory), Path(directory) / 'cache')
            prepare.assert_not_called()

    def test_health_requires_fresh_connected_running_state(self):
        now = datetime.now(timezone.utc)
        good = {'updated_at': now.isoformat(), 'phase': 'running',
                'connected': True, 'loop_age_seconds': 1}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'status.json'
            self.assertFalse(health.healthy(path, now))
            for changes, expected in [({}, True), ({'connected': False}, False),
                ({'phase': 'starting'}, False), ({'phase': 'stopped'}, False),
                ({'loop_age_seconds': 121}, False),
                ({'updated_at': (now - timedelta(seconds=61)).isoformat()}, False),
                ({'updated_at': (now + timedelta(seconds=1)).isoformat()}, False)]:
                path.write_text(json.dumps(good | changes))
                self.assertEqual(health.healthy(path, now), expected)
            for content in ('{', '{}', 'null', '[]'):
                path.write_text(content)
                self.assertFalse(health.healthy(path, now))

    def test_example_paths_and_identity_are_not_production_credentials(self):
        value = json.loads((ROOT / 'node.example.json').read_text())
        self.assertEqual(value['state_dir'], '/data/state')
        self.assertEqual(value['protocol_version'], 3)
        for field in ('node_id', 'node_token', 'resource_id'):
            self.assertTrue(value[field].startswith('REPLACE_WITH_'))

    def test_runtime_is_nonroot_and_keeps_gpu_and_state_contract(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertIn('USER 10001:10001', dockerfile)
        self.assertIn('NVIDIA_DRIVER_CAPABILITIES=compute,utility', dockerfile)
        self.assertIn('/opt/node/source/compute-node/linux/entrypoint.py', dockerfile)
        self.assertIn('STOPSIGNAL SIGTERM', dockerfile)
        self.assertNotIn('COPY . ', dockerfile)
        compose = (ROOT / 'compose.yaml').read_text()
        self.assertIn('node-state:/data', compose)
        self.assertIn('stop_grace_period: 90s', compose)
        self.assertNotIn('ports:', compose)

    def test_runtime_does_not_copy_tests_or_local_experiments(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        runtime = dockerfile.split('FROM base AS runtime', 1)[1]
        self.assertIn('--mount=type=bind,source=.,target=/src,ro', runtime)
        self.assertNotIn('COPY services/compute-node/linux/ /', runtime)
        self.assertNotIn('COPY services/classic-engine/tools/ /', runtime)
        for line in runtime.splitlines():
            if line.startswith('COPY '):
                for forbidden in ('test_', 'benchmark', '/wsl/', '/artifacts/'):
                    self.assertNotIn(forbidden, line)

    def test_environment_bootstrap_is_private_and_preserves_identity(self):
        environ = {'NODE_CONTROL_URL': 'https://example.com', 'NODE_ID': 'node-test',
                   'NODE_TOKEN': 'test-credential', 'NODE_RESOURCE_ID': 'test:gpu:0'}
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {}, clear=True):
            root = Path(directory)
            path = entry.prepare_config(root, environ)
            config = json.loads(path.read_text())
            self.assertEqual([config[key] for key in ('local_pages', 'max_leases',
                'download_workers', 'delivery_workers')], [2, 8, 6, 6])
            self.assertEqual(config['render_workers'], 'auto')
            self.assertEqual(config['engine']['threads'], 'auto')
            self.assertEqual(config['state_dir'], str(root / 'state'))
            if sys.platform != 'win32':
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            before = path.read_bytes()
            self.assertEqual(entry.prepare_config(root, environ), path)
            self.assertEqual(entry.prepare_config(root, environ | {'NODE_CONTROL_URL': 'https://example.com/'}), path)
            self.assertEqual(entry.prepare_config(root, {}), path)
            for key in environ:
                with self.assertRaises(ValueError):
                    entry.prepare_config(root, environ | {key: 'different'})
            self.assertEqual(path.read_bytes(), before)

    def test_bootstrap_rejects_missing_identity_and_orphan_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            good = {'NODE_CONTROL_URL': 'https://example.com', 'NODE_ID': 'node-test',
                    'NODE_TOKEN': 'test-credential', 'NODE_RESOURCE_ID': 'test:gpu:0'}
            for key in good:
                for bad in ('', 'REPLACE_WITH_ID', 'value with spaces'):
                    with self.assertRaises(ValueError):
                        entry.prepare_config(root, good | {key: bad})
                    self.assertFalse((root / 'node.json').exists())
            with self.assertRaises(ValueError):
                entry.prepare_config(root, good | {'NODE_CONTROL_URL': 'http://example.com'})
            (root / 'state').mkdir()
            (root / 'state/journal.db').touch()
            with self.assertRaises(ValueError):
                entry.prepare_config(root, good)

    def test_vast_template_has_no_identity_or_exposed_ports(self):
        template = json.loads((ROOT / 'vast-template.json').read_text())
        self.assertEqual(template['runtype'], 'ssh')
        self.assertEqual(template['args_str'], '')
        self.assertIn('NODE_TOKEN=REPLACE_WITH_NODE_TOKEN', template['env'])
        self.assertNotIn('-p ', template['env'])
        self.assertTrue(template['private'])
        # Vast's editor splits at ':'; tag+digest is silently truncated on save.
        self.assertEqual(template['image'], 'vastai/base-image@sha256')
        self.assertRegex(template['tag'], r'^[a-f0-9]{64}$')
        self.assertIn('unset NODE_CONTROL_URL NODE_ID NODE_TOKEN NODE_RESOURCE_ID', template['onstart'])
        self.assertNotIn('RELEASE_BOOTSTRAP_PENDING', template['onstart'])


if __name__ == '__main__':
    unittest.main()
