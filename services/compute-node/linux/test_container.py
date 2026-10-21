"""Small offline checks for the container's operational contract."""
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
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
    def test_source_template_uses_a_pinned_commit_and_small_bootstrap(self):
        spec = importlib.util.spec_from_file_location('prepare_template', ROOT / 'prepare_template.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        revision = 'a' * 40
        checksum = 'b' * 64
        url = f'{module.RAW_ORIGIN}/Wy2926/node-comics/{revision}/{module.BOOTSTRAP_PATH}'
        with patch.object(module, 'published_bootstrap', return_value=(url, checksum)), \
                patch.object(module, 'git_blob', return_value=(ROOT / 'vast-template.json').read_bytes()):
            value = module.render(revision)
            self.assertIn('--revision ' + revision, value['onstart'])
            self.assertIn(checksum, value['onstart'])
            self.assertIn(url, value['onstart'])
            self.assertNotIn('REPLACE_WITH_SOURCE', value['onstart'])
            self.assertIn('REPLACE_WITH_NODE_TOKEN', value['env'])
            self.assertNotIn('RUNTIME', value['onstart'])

    def test_service_environment_has_no_inherited_credentials(self):
        spec = importlib.util.spec_from_file_location('node_service', ROOT / 'service.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with patch.dict('os.environ', {'NODE_TOKEN': 'secret', 'CONTAINER_API_KEY': 'secret', 'LLM_KEY': 'secret',
                                      'PYTHONPATH': 'secret', 'HTTPS_PROXY': 'http://user:secret@proxy.test:8080'}, clear=True):
            env = module.environment(Path('/data'))
            running = module.environment(Path('/data'), inherit_proxy=True)
        self.assertEqual(running.pop('HTTPS_PROXY'), 'http://user:secret@proxy.test:8080')
        self.assertNotIn('secret', json.dumps(env) + json.dumps(running))
        self.assertEqual(env['HF_HUB_OFFLINE'], '1')

    def test_asset_build_refuses_existing_bundle(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(assets, 'prepare') as prepare:
            with self.assertRaises(FileExistsError):
                assets.build(Path(directory), Path(directory) / 'cache')
            prepare.assert_not_called()

    def test_online_asset_preparation_preserves_existing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'engine').mkdir()
            source = root / 'engine/main.py'
            source.write_text('keep')

            def prepare(output, cache):
                (output / 'licenses').mkdir()
                (output / 'licenses/font-sources.json').write_text('{"fonts": []}')
                return {'upstream': 'fixture', 'files': {}}

            with patch.object(assets, 'prepare', side_effect=prepare):
                assets.build(root, root / 'cache', existing_root=True)
            self.assertEqual(source.read_text(), 'keep')
            self.assertEqual(json.loads((root / 'release.json').read_text())['protocol_version'], 3)

    def test_asset_manifest_publish_failure_preserves_previous_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'licenses').mkdir()
            (root / 'licenses/font-sources.json').write_text('{"fonts": []}')
            (root / 'release.json').write_bytes(b'previous-manifest')
            with patch.object(assets, 'prepare', return_value={'upstream': 'fixture', 'files': {}}), \
                 patch.object(assets.os, 'fsync', side_effect=OSError('fixture write failure')):
                with self.assertRaises(OSError):
                    assets.build(root, root / 'cache', existing_root=True)
            self.assertEqual((root / 'release.json').read_bytes(), b'previous-manifest')
            self.assertEqual(list(root.glob('.release-*')), [])

    def test_asset_build_refuses_completed_release(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(assets, 'prepare') as prepare:
            root = Path(directory)
            (root / '.source-revision').write_text('validated')
            with self.assertRaises(ValueError):
                assets.build(root, root / 'cache', existing_root=True)
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

    def supplied_config(self, path, **changes):
        value = json.loads((ROOT / 'node.example.json').read_text())
        value.update(control_url='https://example.com', node_id='node-test',
                     node_token='test-credential', resource_id='test:gpu:0', state_dir='state')
        value.update(changes)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')
        return value

    def test_supplied_config_fsync_failure_never_publishes_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, data = root / 'input/node.json', root / 'data'
            self.supplied_config(source)
            with patch.object(entry.os, 'fsync', side_effect=OSError('fixture')):
                with self.assertRaises(OSError):
                    entry.prepare_config(data, {}, supplied_path=source)
            self.assertEqual(list(data.iterdir()), [])

    def test_supplied_relative_ca_is_validated_at_destination_before_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, data = root / 'input/node.json', root / 'data'
            self.supplied_config(source, control_ca='ca.pem')
            ca = source.with_name('ca.pem')
            ca.write_text('fixture trust bundle')
            with self.assertRaisesRegex(ValueError, 'control_ca'):
                entry.prepare_config(data, {}, supplied_path=source)
            self.assertEqual(list(data.iterdir()), [])
            # A correction must be retryable; the failed attempt published nothing.
            self.supplied_config(source, control_ca=str(ca))
            self.assertEqual(entry.prepare_config(data, {}, supplied_path=source), data / 'node.json')

    def test_supplied_relative_ca_can_resolve_only_at_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, data = root / 'input/node.json', root / 'data'
            self.supplied_config(source, control_ca='ca.pem')
            data.mkdir()
            (data / 'ca.pem').write_text('fixture trust bundle')
            self.assertFalse(source.with_name('ca.pem').exists())
            entry.prepare_config(data, {}, supplied_path=source)
            self.assertEqual(json.loads((data / 'node.json').read_text())['control_ca'], 'ca.pem')

    def test_supplied_identity_conflicts_never_publish_and_existing_config_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, data = root / 'input/node.json', root / 'data'
            value = self.supplied_config(source)
            for env in entry.IDENTITY:
                conflict = 'https://different.example' if env == 'NODE_CONTROL_URL' else 'different'
                with self.subTest(env=env), self.assertRaisesRegex(ValueError, 'identity differs'):
                    entry.prepare_config(data, {env: conflict}, supplied_path=source)
                self.assertEqual(list(data.iterdir()), [])
            identity = {env: value[field] for env, field in entry.IDENTITY.items()}
            path = entry.prepare_config(data, identity, supplied_path=source)
            before = path.read_bytes()
            self.assertEqual(entry.prepare_config(data, identity, supplied_path=source), path)
            self.supplied_config(source, node_token='different')
            with self.assertRaisesRegex(ValueError, 'Existing config differs'):
                entry.prepare_config(data, {}, supplied_path=source)
            self.assertEqual(path.read_bytes(), before)

    def test_supplied_config_checks_the_actual_custom_state_for_orphans(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, data = root / 'input/node.json', root / 'data'
            for state_dir in ('custom-state', str(root / 'external-state')):
                state = data / state_dir
                state.mkdir(parents=True)
                (state / 'journal.db').write_text('existing recovery state')
                self.supplied_config(source, state_dir=state_dir)
                with self.subTest(state_dir=state_dir), self.assertRaisesRegex(ValueError, 'restore its original config'):
                    entry.prepare_config(data, {}, supplied_path=source)
                self.assertFalse((data / 'node.json').exists())
                self.assertEqual((state / 'journal.db').read_text(), 'existing recovery state')

    def test_invalid_supplied_config_never_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, data = root / 'input/node.json', root / 'data'
            self.supplied_config(source)
            for value in (None, [], {'node_id': 'invalid'}):
                source.write_text(json.dumps(value), encoding='utf-8')
                with self.subTest(value=value), self.assertRaises(ValueError):
                    entry.prepare_config(data, {}, supplied_path=source)
                self.assertFalse((data / 'node.json').exists())

    def prepare_config_cli(self, data, payload, source=None):
        command = [sys.executable, str(ROOT / 'entrypoint.py'), 'prepare-config', str(data)]
        if source:
            command.append(str(source))
        environment = {'PATH': os.defpath, 'PYTHONPATH': str(ROOT.parents[1] / 'classic-engine'),
                       'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
        if 'SystemRoot' in os.environ:
            environment['SystemRoot'] = os.environ['SystemRoot']
        return subprocess.run(command, input=payload, text=True, encoding='utf-8', env=environment,
                              capture_output=True, timeout=15)

    def test_prepare_config_cli_creates_private_identity_from_stdin_without_output(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'data'
            identity = {'NODE_CONTROL_URL': 'https://example.com', 'NODE_ID': 'node-test',
                        'NODE_TOKEN': 'fixture-private-credential', 'NODE_RESOURCE_ID': 'test:gpu:0'}
            result = self.prepare_config_cli(data, json.dumps(identity))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout + result.stderr, '')
            path = data / 'node.json'
            config = json.loads(path.read_text())
            self.assertEqual(config['node_token'], identity['NODE_TOKEN'])
            self.assertFalse((data / 'state').exists())
            if sys.platform != 'win32':
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(identity['NODE_TOKEN'], str(result.args))

    def test_prepare_config_cli_supports_private_source_and_preserves_identity_on_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data, source = root / 'data', root / 'input/node.json'
            original = self.supplied_config(source)
            result = self.prepare_config_cli(data, '{}', source)
            self.assertEqual(result.returncode, 0, result.stderr)
            path = data / 'node.json'
            before = path.read_bytes()
            conflict = 'fixture-conflicting-secret'
            result = self.prepare_config_cli(data, json.dumps({'NODE_TOKEN': conflict}), source)
            self.assertEqual(result.returncode, 2)
            self.assertIn('Node bootstrap failed', result.stderr)
            self.assertNotIn(conflict, result.stdout + result.stderr)
            self.assertNotIn(original['node_token'], result.stdout + result.stderr)
            self.assertNotIn('Traceback', result.stderr)
            self.assertEqual(path.read_bytes(), before)

    def test_prepare_config_cli_rejects_malformed_or_incomplete_input_without_leaking_it(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'data'
            secret = 'fixture-hidden-malformed-credential'
            for payload in ('{"NODE_TOKEN":"' + secret + '"', json.dumps({'NODE_TOKEN': secret})):
                with self.subTest(payload=payload):
                    result = self.prepare_config_cli(data, payload)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn('Node bootstrap failed', result.stderr)
                    self.assertNotIn(secret, result.stdout + result.stderr)
                    self.assertNotIn('Traceback', result.stderr)
                    self.assertFalse((data / 'node.json').exists())

    def test_prepare_config_mode_never_imports_or_starts_the_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            source, data = Path(directory) / 'input/node.json', Path(directory) / 'data'
            self.supplied_config(source)
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(entry.sys, 'argv', ['entrypoint.py', 'prepare-config', str(data), str(source)]), \
                    patch.object(entry.sys, 'stdin', io.StringIO('{}')), patch.object(entry.os, 'umask'), \
                    patch.dict(sys.modules, {'classic_node.__main__': None, 'classic_node.operations': None}), \
                    redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(entry.main(), 0)
            self.assertEqual(stdout.getvalue() + stderr.getvalue(), '')
            self.assertTrue((data / 'node.json').is_file())

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
