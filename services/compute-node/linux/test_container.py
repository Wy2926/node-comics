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
    def test_asset_build_uses_linux_converters_and_excludes_build_only_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            host, engine = root / 'compute-node', root / 'classic-engine'
            host.mkdir()
            (engine / 'manhua_engine').mkdir(parents=True)
            asset = {'url': 'https://example.com/fixture', 'sha256': 'fixture'}
            (host / 'toolchain.lock.json').write_text(json.dumps({
                'ocr_source': asset, 'ocr_checkpoint': asset}))
            (host / 'assets.json').write_text(json.dumps({'fonts': [{
                **asset, 'name': 'font.otf', 'notice': 'OFL',
                'notice_url': asset['url'], 'notice_sha256': asset['sha256']}]}))
            (engine / 'manhua_engine/models.json').write_text(json.dumps({'models': [
                dict(asset, name='detector.bin'), dict(asset, name='checkpoint', build_only=True),
                dict(asset, name='ppocr/v6-small.onnx', language='auto'),
                dict(asset, name='ppocr/v6-small.yml', language='auto'),
                dict(asset, name='ppocr/ko.onnx', language='ko')]}))

            def download(url, checksum, target):
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'fixture')
                return target

            def run(command, **kwargs):
                self.assertIn('.venv/bin/python', command[0].as_posix())
                if '--source-file' in command:
                    self.assertEqual(command[command.index('--source-file') + 1].suffix, '.py')
                    out = command[command.index('--output') + 1]
                    out.mkdir(parents=True)
                    for name in ('backbone.ncnn.bin', 'decoder.onnx', 'build.json', 'ocr.onnx'):
                        (out / name).write_bytes(b'fixture')
                else:
                    out = command[-1] / 'lama-onnx'
                    out.mkdir()
                    (out / 'lama-large-512.onnx').write_bytes(b'fixture')

            with patch.object(assets, 'ROOT', host), patch.object(assets, 'ENGINE', engine), \
                 patch.object(assets, 'download', download), patch.object(assets, 'run', run):
                output = root / 'bundle'
                assets.build(output, root / 'cache')
                self.assertFalse((output / 'models/checkpoint').exists())
                self.assertFalse((output / 'models/ocr-fp32/ocr.onnx').exists())
                manifest = json.loads((output / 'release.json').read_text())
                self.assertEqual(manifest['fonts'], ['fonts/font.otf'])
                self.assertIn('models/lama-onnx/lama-large-512.onnx', manifest['files'])
                for name in ('v6-small.onnx','v6-small.yml','ko.onnx'):
                    self.assertIn('models/ppocr/'+name, manifest['files'])
                with self.assertRaises(FileExistsError):
                    assets.build(output, root / 'cache')

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
        self.assertIn('NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics', dockerfile)
        self.assertIn('/opt/node/source/compute-node/linux/entrypoint.py', dockerfile)
        self.assertIn('STOPSIGNAL SIGTERM', dockerfile)
        self.assertNotIn('COPY . ', dockerfile)
        compose = (ROOT / 'compose.yaml').read_text()
        self.assertIn('node-state:/data', compose)
        self.assertIn('stop_grace_period: 90s', compose)
        self.assertNotIn('ports:', compose)

    def test_runtime_builds_and_checks_the_pinned_gil_releasing_ncnn(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertIn('AS ncnn-wheel', dockerfile)
        self.assertIn('282f0f4a1beec1f5212aa0d22c00737418645055f33c2d2082922931cdbdc537', dockerfile)
        self.assertIn('patch --batch --fuzz=0', dockerfile)
        self.assertIn('COPY --from=ncnn-wheel /wheels/', dockerfile)
        self.assertIn('/opt/node/venv/bin/python /tmp/test_ncnn_gil.py', dockerfile)
        self.assertIn('/opt/node/source/ncnn/', dockerfile)
        self.assertIn('1.0.20260526+nodegil1', (ROOT / 'verify_assets.py').read_text())

    def test_runtime_does_not_copy_tests_or_local_experiments(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        runtime = dockerfile.split('FROM base AS runtime', 1)[1]
        self.assertIn('--mount=type=bind,source=.,target=/src,ro', runtime)
        self.assertNotIn('COPY services/compute-node/linux/ /', runtime)
        self.assertNotIn('COPY services/classic-engine/tools/ /', runtime)
        self.assertNotIn('COPY services/compute-node/linux/ncnn/ /', dockerfile)
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
            self.assertEqual(config['render_workers'], 1)
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
