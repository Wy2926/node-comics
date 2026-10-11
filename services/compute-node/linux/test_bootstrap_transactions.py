"""Offline fault injection for release activation; no GPU or credentials required."""
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

if sys.platform == 'linux':
    spec = importlib.util.spec_from_file_location(
        'vast_bootstrap_transactions', Path(__file__).with_name('vast_bootstrap.py'))
    boot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(boot)


@unittest.skipUnless(sys.platform == 'linux', 'Vast bootstrap requires Linux')
class BootstrapTransactionTests(unittest.TestCase):
    OLD_CONFIG = b'[program:node-comics]\nfixture=old\n'
    NEW_CONFIG = b'[program:node-comics]\nfixture=new\n'

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.base = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.root = self.base / 'node'
        self.releases = self.base / 'releases'
        self.conf = self.base / 'supervisor/node-comics.conf'
        self.conf.parent.mkdir()
        self.data = self.base / 'data'
        self.data.mkdir()
        (self.data / 'node.json').write_bytes(b'{"fixture_identity":"unchanged"}')
        (self.data / 'state').mkdir()
        (self.data / 'state/checkpoint').write_bytes(b'preserved-checkpoint')
        self.old, self.new = (self.releases / name for name in ('old', 'new'))
        for release in (self.old, self.new):
            release.mkdir(parents=True)
            (release / '.source-revision').write_text(release.name + '\n')
        for name, value in (('ROOT', self.root), ('RELEASES', self.releases),
                            ('CONF', self.conf), ('DATA', self.data), ('STAGE', 'service_activation')):
            self.stack.enter_context(patch.object(boot, name, value))
        self.events = self.stack.enter_context(patch.object(boot, 'event'))
        self.commands = []
        self.status = 'STOPPED'
        self.fail_update = False
        self.fail_start = False
        self.fail_stop = False
        self.stack.enter_context(patch.object(boot.subprocess, 'run', side_effect=self.supervisor))

    def supervisor(self, command, **kwargs):
        self.assertEqual(command[0], 'supervisorctl')
        self.commands.append(tuple(command[1:]))
        action = command[1]
        if action == 'status':
            text = 'node-comics: ERROR (no such process)' if self.status == 'ABSENT' else 'node-comics ' + self.status
            return SimpleNamespace(returncode=0, stdout=text)
        if action == 'update':
            # Supervisor autostart may have taken effect before an update fails.
            self.status = 'RUNNING' if self.conf.exists() else 'ABSENT'
            if self.fail_update:
                self.fail_update = False
                raise subprocess.CalledProcessError(1, command)
        elif action == 'start':
            self.status = 'RUNNING'
            if self.fail_start:
                raise subprocess.CalledProcessError(1, command)
        elif action == 'stop':
            if self.fail_stop:
                raise subprocess.CalledProcessError(1, command)
            self.status = 'STOPPED'
        else:
            self.assertEqual(action, 'reread')
        return SimpleNamespace(returncode=0, stdout='')

    def existing_installation(self):
        self.root.symlink_to(self.old, target_is_directory=True)
        self.conf.write_bytes(self.OLD_CONFIG)

    def assert_preserved(self):
        self.assertEqual((self.data / 'node.json').read_bytes(), b'{"fixture_identity":"unchanged"}')
        self.assertEqual((self.data / 'state/checkpoint').read_bytes(), b'preserved-checkpoint')
        self.assertTrue((self.new / '.source-revision').is_file())
        self.assertFalse(self.conf.with_name('.node-comics.next').exists())

    def test_config_prewrite_failure_does_not_switch_or_touch_supervisor(self):
        self.existing_installation()
        with patch.object(boot.os, 'fsync', side_effect=OSError('fixture disk failure')):
            with self.assertRaises(OSError):
                boot.configure_service(self.new, self.NEW_CONFIG)
        self.assertEqual(self.root.resolve(), self.old)
        self.assertEqual(self.conf.read_bytes(), self.OLD_CONFIG)
        self.assertEqual(self.commands, [])
        self.assertEqual(list(self.conf.parent.iterdir()), [self.conf])
        self.assert_preserved()

    def test_config_publish_failure_after_switch_restores_previous_link(self):
        self.existing_installation()
        original = Path.replace

        def replace(path, target):
            if path == self.conf.with_name('.node-comics.next'):
                raise OSError('fixture publish failure')
            return original(path, target)

        with patch.object(Path, 'replace', new=replace):
            with self.assertRaises(OSError):
                boot.configure_service(self.new, self.NEW_CONFIG)
        self.assertEqual(self.root.resolve(), self.old)
        self.assertEqual(self.conf.read_bytes(), self.OLD_CONFIG)
        self.assertEqual(self.commands, [])
        self.events.assert_any_call('rollback_restored', service_left_stopped=True)
        self.assert_preserved()

    def test_failed_update_stops_new_worker_and_restores_old_link_and_config(self):
        self.existing_installation()
        self.fail_update = True
        with self.assertRaises(subprocess.CalledProcessError):
            boot.configure_service(self.new, self.NEW_CONFIG)
        self.assertEqual(self.root.resolve(), self.old)
        self.assertEqual(self.conf.read_bytes(), self.OLD_CONFIG)
        self.assertEqual(self.status, 'STOPPED')
        # Stop the new worker before switching; also stop the old auto-started worker.
        self.assertEqual(self.commands.count(('stop', 'node-comics')), 2)
        self.events.assert_any_call('rollback_restored', service_left_stopped=True)
        self.assert_preserved()

    def test_failed_start_without_config_change_stops_worker_and_restores_link(self):
        self.existing_installation()
        self.fail_start = True
        with self.assertRaises(subprocess.CalledProcessError):
            boot.configure_service(self.new, self.OLD_CONFIG)
        self.assertEqual(self.root.resolve(), self.old)
        self.assertEqual(self.conf.read_bytes(), self.OLD_CONFIG)
        self.assertEqual(self.status, 'STOPPED')
        self.assertNotIn(('reread',), self.commands)
        self.assertNotIn(('update', 'node-comics'), self.commands)
        self.assert_preserved()

    def test_first_install_start_failure_removes_only_active_link_and_config(self):
        self.status = 'ABSENT'
        self.fail_update = True
        with self.assertRaises(subprocess.CalledProcessError):
            boot.configure_service(self.new, self.NEW_CONFIG)
        self.assertFalse(self.root.exists())
        self.assertFalse(self.root.is_symlink())
        self.assertFalse(self.conf.exists())
        self.assertEqual(self.status, 'ABSENT')
        self.assert_preserved()

    def test_failed_rollback_is_explicit_and_does_not_switch_under_running_worker(self):
        self.existing_installation()
        self.fail_update = self.fail_stop = True
        with self.assertRaises(subprocess.CalledProcessError):
            boot.configure_service(self.new, self.NEW_CONFIG)
        self.events.assert_any_call('rollback_failed', error_type='CalledProcessError',
                                    operator_action_required=True)
        self.assertFalse(any(call.args[0] == 'rollback_restored' for call in self.events.call_args_list))
        self.assertEqual(self.root.resolve(), self.new)
        self.assertEqual(self.conf.read_bytes(), self.NEW_CONFIG)
        self.assertEqual(self.status, 'RUNNING')
        self.assert_preserved()

    def test_same_running_version_does_not_reload_restart_or_rewrite(self):
        self.existing_installation()
        self.status = 'RUNNING'
        with patch.object(boot, 'atomic_write') as write, patch.object(boot, 'activate') as activate:
            boot.configure_service(self.old, self.OLD_CONFIG)
        write.assert_not_called()
        activate.assert_not_called()
        self.assertEqual(self.commands, [('status', 'node-comics')])
        self.assert_preserved()

    def test_same_stopped_version_starts_without_reload(self):
        self.existing_installation()
        boot.configure_service(self.old, self.OLD_CONFIG)
        self.assertEqual(self.commands, [('status', 'node-comics'), ('start', 'node-comics')])
        self.assertEqual(self.status, 'RUNNING')
        self.assert_preserved()

    def test_missing_supervisor_config_is_registered_even_for_same_running_version(self):
        self.existing_installation()
        self.conf.unlink()
        self.status = 'RUNNING'
        boot.configure_service(self.old, self.OLD_CONFIG)
        self.assertEqual(self.root.resolve(), self.old)
        self.assertEqual(self.conf.read_bytes(), self.OLD_CONFIG)
        self.assertEqual(self.commands, [('status', 'node-comics'), ('reread',),
                                        ('update', 'node-comics'), ('status', 'node-comics')])
        self.assertEqual(self.status, 'RUNNING')
        self.assert_preserved()

    def test_atomic_config_write_failure_keeps_old_file_and_removes_temporary(self):
        target = self.data / 'node.json'
        original = target.read_bytes()
        for operation in ('fsync', 'replace'):
            with self.subTest(operation=operation):
                owner = boot.os if operation == 'fsync' else Path
                with patch.object(owner, operation, side_effect=OSError('fixture disk failure')):
                    with self.assertRaises(OSError):
                        boot.atomic_write(target, b'new config', mode=0o600)
                self.assertEqual(target.read_bytes(), original)
                self.assertEqual(sorted(path.name for path in self.data.iterdir()), ['node.json', 'state'])

    def config_environment(self, directory):
        return {'PATH': '/usr/bin:/bin', 'HOME': str(directory),
                'PYTHONPATH': str(self.new / 'engine'),
                **{key: str(directory / child) for key, child in (
                    ('XDG_CACHE_HOME', 'cache'), ('XDG_CONFIG_HOME', 'config'),
                    ('YOLO_CONFIG_DIR', 'cache/ultralytics'), ('CUDA_CACHE_PATH', 'cache/cuda'))}}

    def test_config_validation_uses_venv_and_stdin_without_host_import_or_secret_environment(self):
        supplied = self.base / 'input.json'
        supplied.write_text('{"fixture": true}')
        fresh = self.base / 'fresh-data'
        identity = dict(zip(boot.FIELDS, ('https://fixture.invalid', 'fixture-node',
                                         'fixture-secret', 'fixture-resource')))
        environment = self.config_environment(fresh)

        def run(command, **kwargs):
            if command[0] == str(self.new / 'venv/bin/python'):
                (fresh / 'node.json').write_text('{"fixture": true}')
            return SimpleNamespace(returncode=0)

        with patch.object(boot, 'DATA', fresh), patch.object(boot.os, 'chown'), \
             patch.dict(boot.os.environ, {'NODE_TOKEN': 'fixture-secret', 'CONTAINER_API_KEY': 'platform-secret'}), \
             patch.object(boot, 'runtime_environment', return_value=environment), \
             patch.object(boot, 'runtime_module') as module, \
             patch.object(boot.subprocess, 'run', side_effect=run) as execute:
            result = boot.prepare_config(self.new, identity, supplied)
        self.assertEqual(result, fresh / 'node.json')
        self.assertEqual(execute.call_count, 2)
        prepare = execute.call_args_list[0]
        self.assertEqual(prepare.args[0], [str(self.new / 'venv/bin/python'),
            str(self.new / 'source/compute-node/linux/entrypoint.py'), 'prepare-config', str(fresh), str(supplied)])
        self.assertEqual(json.loads(prepare.kwargs['input']), identity)
        self.assertEqual(prepare.kwargs['env'], environment)
        for value in (*identity.values(), 'platform-secret'):
            self.assertNotIn(value, json.dumps(prepare.args[0]) + json.dumps(prepare.kwargs['env']))
        self.assertEqual(prepare.kwargs['stdout'], subprocess.DEVNULL)
        self.assertEqual(prepare.kwargs['stderr'], subprocess.DEVNULL)
        self.assertTrue(prepare.kwargs['check'])
        self.assertTrue(prepare.kwargs['text'])
        self.assertEqual(execute.call_args_list[1].args[0][:6],
                         ['runuser', '-u', 'node-comics', '--', 'mkdir', '-p'])
        self.assertEqual(result.stat().st_mode & 0o777, 0o600)
        module.assert_not_called()

    def test_failed_venv_config_validation_does_not_continue_runtime_setup(self):
        supplied = self.base / 'input.json'
        supplied.write_text('{"fixture": true}')
        fresh = self.base / 'fresh-data'
        with patch.object(boot, 'DATA', fresh), patch.object(boot.os, 'chown'), \
             patch.object(boot, 'runtime_environment', return_value=self.config_environment(fresh)), \
             patch.object(boot, 'runtime_module') as module, \
             patch.object(boot.subprocess, 'run', side_effect=subprocess.CalledProcessError(2, ['fixture'])) as execute:
            with self.assertRaises(subprocess.CalledProcessError):
                boot.prepare_config(self.new, {}, supplied)
        self.assertEqual(list(fresh.iterdir()), [])
        self.assertEqual(supplied.read_text(), '{"fixture": true}')
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(execute.call_args.args[0][0], str(self.new / 'venv/bin/python'))
        module.assert_not_called()
        self.assertEqual(self.commands, [])

    def test_completed_release_is_not_rewritten_or_rebuilt(self):
        source = self.new / 'source/classic-engine/main.py'
        source.parent.mkdir(parents=True)
        source.write_bytes(b'original-source')
        with patch.object(boot, 'uv_binary') as uv:
            result = boot.prepare_release(((Path('source/classic-engine/main.py'), b'replacement'),), 'new')
        self.assertEqual(result, self.new)
        self.assertEqual(source.read_bytes(), b'original-source')
        uv.assert_not_called()
        self.assertEqual(self.commands, [])

    def test_completed_release_identity_mismatch_is_rejected_without_rebuild(self):
        (self.new / '.source-revision').write_text('different\n')
        with self.assertRaisesRegex(ValueError, 'identity differs'):
            boot.prepare_release((), 'new')
        self.assertEqual((self.new / '.source-revision').read_text(), 'different\n')
        self.assertEqual(self.commands, [])

    def completed_install_args(self):
        source = self.base / 'checkout'
        (source / 'code').mkdir(parents=True)
        (source / 'code/main.py').write_bytes(b'pass\n')
        self.stack.enter_context(patch.object(boot, 'SOURCES', ('code',)))
        version = boot.source_version(tuple(boot.source_files(source)))
        release = self.releases / version
        config = release / 'source/compute-node/linux/node-comics.supervisor.conf'
        config.parent.mkdir(parents=True)
        config.write_bytes(self.OLD_CONFIG)
        (release / '.source-revision').write_text(version + '\n')
        self.root.symlink_to(release, target_is_directory=True)
        self.conf.write_bytes(self.OLD_CONFIG)
        self.status = 'RUNNING'
        self.identity = dict(zip(boot.FIELDS, ('https://example.invalid', 'fixture-node',
                                             'fixture-credential', 'fixture-resource')))
        self.stack.enter_context(patch.dict(boot.os.environ, self.identity, clear=True))
        for owner, name, result in ((boot.os, 'geteuid', 0), (boot.platform, 'machine', 'x86_64'),
                (boot.platform, 'freedesktop_os_release', {'ID': 'ubuntu', 'VERSION_ID': '24.04'}),
                (boot.shutil, 'which', '/usr/bin/supervisorctl')):
            self.stack.enter_context(patch.object(owner, name, return_value=result))
        self.stack.enter_context(patch.object(boot.sys, 'version_info', (3, 12, 0)))
        self.stack.enter_context(patch.object(boot, 'CACHE', self.base / 'cache'))
        for name in ('install_dependencies', 'host_preflight', 'ensure_account'):
            self.stack.enter_context(patch.object(boot, name))
        args = SimpleNamespace(source_dir=source, revision=None, config=None,
                               expected_current=version, start=True)
        return release, args

    def test_same_version_install_validates_identity_without_heavy_checks_or_restarts(self):
        release, args = self.completed_install_args()
        before = (release / '.source-revision').stat().st_mtime_ns
        with patch.object(boot, 'prepare_config', return_value=self.data / 'node.json') as config, \
             patch.object(boot, 'node_command') as node_command, \
             patch.object(boot, 'atomic_write') as write:
            boot.install(args)
        config.assert_called_once_with(release, self.identity, None)
        node_command.assert_not_called()
        write.assert_not_called()
        self.assertEqual((release / '.source-revision').stat().st_mtime_ns, before)
        self.assertEqual(self.commands, [('status', 'node-comics')])
        self.assertEqual(self.root.resolve(), release)
        self.assert_preserved()

    def test_same_version_install_cannot_bypass_identity_validation_failure(self):
        release, args = self.completed_install_args()
        with patch.object(boot, 'prepare_config', side_effect=ValueError('fixture identity mismatch')) as config, \
             patch.object(boot, 'node_command') as node_command, \
             patch.object(boot, 'atomic_write') as write:
            with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                boot.install(args)
        config.assert_called_once_with(release, self.identity, None)
        node_command.assert_not_called()
        write.assert_not_called()
        self.assertEqual(self.commands, [])
        self.assertEqual(self.root.resolve(), release)
        self.assert_preserved()

    def test_prepare_without_start_does_not_switch_or_publish_supervisor_config(self):
        previous, args = self.completed_install_args()
        args.start = False
        (args.source_dir / 'code/main.py').write_bytes(b'new_version = True\n')
        version = boot.source_version(tuple(boot.source_files(args.source_dir)))
        candidate = self.releases / version
        config = candidate / 'source/compute-node/linux/node-comics.supervisor.conf'
        config.parent.mkdir(parents=True)
        config.write_bytes(self.NEW_CONFIG)
        (candidate / '.source-revision').write_text(version + '\n')
        with patch.object(boot, 'prepare_config', return_value=self.data / 'node.json'), \
             patch.object(boot, 'ensure_drained') as drained, \
             patch.object(boot, 'node_command', return_value=['fixture-preflight']), \
             patch.object(boot.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run, \
             patch.object(boot, 'configure_service') as configure:
            boot.install(args)
        drained.assert_called_once_with()
        configure.assert_not_called()
        self.assertEqual(run.call_count, 3)
        self.assertTrue(all(call.args[0] == ['fixture-preflight'] for call in run.call_args_list))
        self.assertEqual(self.root.resolve(), previous)
        self.assertEqual(self.conf.read_bytes(), self.OLD_CONFIG)
        self.assertEqual((candidate / '.source-revision').read_text(), version + '\n')
        self.assertEqual(self.commands, [])
        self.assert_preserved()


if __name__ == '__main__':
    unittest.main()
