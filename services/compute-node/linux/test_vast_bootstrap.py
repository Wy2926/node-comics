"""Linux online deployment contract; no environment archive export."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

if sys.platform == 'linux':
    spec = importlib.util.spec_from_file_location('vast_bootstrap', Path(__file__).with_name('vast_bootstrap.py'))
    boot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(boot)


@unittest.skipUnless(sys.platform == 'linux', 'Vast bootstrap requires Linux')
class VastBootstrapTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('git'), 'requires Git')
    def test_pinned_git_fetch_extracts_code_only_and_reuses_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository, cache = base / 'origin', base / 'cache'
            repository.mkdir()
            cache.mkdir()
            (repository / 'code').mkdir()
            (repository / 'code/main.py').write_text('pass\n')
            (repository / '.venv').mkdir()
            (repository / '.venv/not-source').write_text('never transferred into a release')
            for command in (['init'], ['add', '.'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
                    'commit', '-m', 'fixture']):
                subprocess.run(['git', '-C', str(repository), *command], check=True, capture_output=True)
            revision = subprocess.check_output(['git', '-C', str(repository), 'rev-parse', 'HEAD'], text=True).strip()
            with patch.object(boot, 'CACHE', cache), patch.object(boot, 'REPOSITORY', str(repository)), \
                 patch.object(boot, 'SOURCES', ('code',)):
                checkout = boot.pull_source(revision)
                self.assertEqual((checkout / 'code/main.py').read_text(), 'pass\n')
                self.assertFalse((checkout / '.venv').exists())
                with patch.object(boot.subprocess, 'run') as run:
                    self.assertEqual(boot.pull_source(revision), checkout)
                    run.assert_not_called()

    def test_failed_bootstrap_keeps_platform_services_available_without_node_token(self):
        template = json.loads(Path(__file__).with_name('vast-template.json').read_text())
        start, rest = template['onstart'].split("bash -e <<'NODE_COMICS_BOOTSTRAP'\n", 1)
        _, end = rest.split('\nNODE_COMICS_BOOTSTRAP\n', 1)
        for status in (0, 23):
            script = start + "bash -e <<'NODE_COMICS_BOOTSTRAP'\nexit " + str(status) + '\nNODE_COMICS_BOOTSTRAP\n' + end
            script = script.replace('exec entrypoint.sh --no-update-portal --no-update-vast',
                'test -z "$' + '{NODE_TOKEN:-}" || exit 91\nprintf "platform-started\\n"')
            result = subprocess.run(['bash'], input=script, text=True, capture_output=True,
                                    env=dict(os.environ, NODE_TOKEN='fixture-credential'))
            self.assertEqual(result.returncode, 0)
            self.assertIn('platform-started', result.stdout)
            self.assertEqual('bootstrap failed' in result.stdout, status != 0)
            self.assertNotIn('fixture-credential', result.stdout + result.stderr)

    def test_source_snapshot_excludes_local_environments_and_private_state(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / 'code').mkdir()
            (source / 'code/main.py').write_bytes(b'print(1)\r\n')
            for name in ('.venv', '.assets', '__pycache__'):
                (source / 'code' / name).mkdir()
                (source / 'code' / name / 'private.py').write_text('excluded')
            (source / 'code/test_example.py').write_text('excluded')
            with patch.object(boot, 'SOURCES', ('code',)):
                files = list(boot.source_files(source))
                self.assertEqual(files, [(Path('code/main.py'), b'print(1)\n')])
                first = boot.source_version(files)
                (source / 'code/main.py').write_bytes(b'print(1)\n')
                self.assertEqual(boot.source_version(boot.source_files(source)), first)
                (source / 'code/main.py').write_text('print(2)\n')
                self.assertNotEqual(boot.source_version(boot.source_files(source)), first)
                # Capturing once keeps the installed bytes tied to their identity.
                self.assertEqual(boot.source_version(files), first)
                self.assertEqual(files[0][1], b'print(1)\n')

    def test_source_snapshot_rejects_links_missing_inputs_and_private_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            code = source / 'code'
            code.mkdir()
            (code / 'main.py').write_text('pass\n')
            for name in ('node.local.json', 'token.private.py', 'cache.sqlite', 'events.log'):
                (code / name).write_text('never copy')
            with patch.object(boot, 'SOURCES', ('code',)):
                self.assertEqual(list(boot.source_files(source)), [(Path('code/main.py'), b'pass\n')])
                (code / 'linked').symlink_to(source, target_is_directory=True)
                with self.assertRaises(ValueError):
                    list(boot.source_files(source))
            (source / 'linked').symlink_to(code, target_is_directory=True)
            for selected in ('linked', 'absent'):
                with patch.object(boot, 'SOURCES', (selected,)), self.assertRaises(ValueError):
                    list(boot.source_files(source))

    def test_online_prepare_uses_locked_dependencies_and_shared_download_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / 'checkout'
            (source / 'code').mkdir(parents=True)
            (source / 'code/main.py').write_text('pass\n')
            root = base / 'releases/v1'

            def run(command, **kwargs):
                if 'sync' in command:
                    (root / 'venv').mkdir()
                elif '--output' in command:
                    assets = Path(command[command.index('--output') + 1])
                    assets.mkdir(exist_ok=True)
                    (assets / 'release.json').write_text('{}')
                return SimpleNamespace(returncode=0)

            with patch.object(boot, 'SOURCES', ('code',)), patch.object(boot, 'RELEASES', base / 'releases'), \
                 patch.object(boot, 'CACHE', base / 'cache'), patch.object(boot, 'uv_binary', return_value=Path('/uv')), \
                 patch.object(boot.subprocess, 'run', side_effect=run) as execute:
                with patch.dict(os.environ, {'UV_NO_CACHE': '1'}):
                    files = tuple(boot.source_files(source))
                    self.assertEqual(boot.prepare_release(files, 'v1'), root)
                command = execute.call_args_list[0].args[0]
                self.assertIn('--locked', command)
                self.assertIn('--no-editable', command)
                env = execute.call_args_list[0].kwargs['env']
                self.assertEqual(env['UV_CACHE_DIR'], str(base / 'cache/uv'))
                self.assertEqual(env['UV_LINK_MODE'], 'hardlink')
                self.assertEqual(env['UV_NO_CACHE'], 'false')
                self.assertEqual(execute.call_args_list[1].args[0][2:5], ['--output', root, '--existing-root'])
                self.assertFalse((root / 'assets').exists())
                (root / '.source-revision').write_text('v1')
                execute.reset_mock()
                self.assertEqual(boot.prepare_release(files, 'v1'), root)
                execute.assert_not_called()

    def test_interrupted_manifest_rebuilds_unfinished_release_from_cache(self):
        for content in ('{', '{}', '{"fonts":[]}'):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                root = base / 'releases/v1'
                root.mkdir(parents=True)
                (root / 'release.json').write_text(content)
                calls = []

                def run(command, **kwargs):
                    calls.append(command)
                    if '--output' in command:
                        (root / 'release.json').write_text('{"rebuilt":true}')
                    return SimpleNamespace(returncode=0)

                files = ((Path('source/classic-engine/main.py'), b'pass\n'),)
                with patch.object(boot, 'RELEASES', base / 'releases'), \
                     patch.object(boot, 'uv_binary', return_value=Path('/uv')), \
                     patch.object(boot.subprocess, 'run', side_effect=run):
                    boot.prepare_release(files, 'v1')
                self.assertEqual(sum('--output' in call for call in calls), 1)
                self.assertTrue(json.loads((root / 'release.json').read_text())['rebuilt'])
                self.assertFalse((root / '.source-revision').exists())

    def test_atomic_upgrade_and_rollback_keep_identity_and_state(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root, releases, data = base / 'node', base / 'releases', base / 'data'
            data.mkdir()
            (data / 'identity').write_text('unchanged')
            for version in ('first', 'second'):
                path = releases / version
                path.mkdir(parents=True)
                (path / '.source-revision').write_text(version)
            with patch.object(boot, 'ROOT', root), patch.object(boot, 'RELEASES', releases):
                self.assertIsNone(boot.current_version())
                for version in ('first', 'second', 'first'):
                    boot.activate(releases / version)
                    self.assertEqual(boot.current_version(), version)
                    self.assertEqual(root.resolve(), releases / version)
            self.assertEqual((data / 'identity').read_text(), 'unchanged')
            self.assertTrue((releases / 'second').exists())

    def test_unmanaged_runtime_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'existing').write_text('keep')
            with patch.object(boot, 'ROOT', root):
                with self.assertRaises(ValueError):
                    boot.current_version()
            self.assertEqual((root / 'existing').read_text(), 'keep')

    def test_pending_workspace_blocks_upgrade_without_a_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'state/documents/job/1').mkdir(parents=True)
            (root / 'node.json').write_text(json.dumps({'state_dir': 'state'}))
            with patch.object(boot, 'DATA', root), patch.object(boot, 'CONF', root / 'absent'), \
                 patch.object(boot, 'node_command', return_value=['pending']), \
                 patch.object(boot.subprocess, 'run', return_value=SimpleNamespace(stdout='STOPPED')):
                with self.assertRaisesRegex(ValueError, 'workspaces'):
                    boot.ensure_drained()

    def test_download_resumes_and_preserves_partial_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            partial = Path(directory) / 'uv.partial'
            partial.write_bytes(b'partial')
            with patch.object(boot.subprocess, 'run', return_value=SimpleNamespace(returncode=28)) as run:
                with self.assertRaises(RuntimeError):
                    boot.download('https://example.com/uv', partial)
            self.assertEqual(partial.read_bytes(), b'partial')
            self.assertIn('--continue-at', run.call_args.args[0])

    def test_corrupt_toolchain_is_not_installed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(boot, 'CACHE', root), patch.object(boot, 'download',
                    side_effect=lambda url, path: path.write_bytes(b'corrupt')):
                with self.assertRaises(ValueError):
                    boot.uv_binary()
            self.assertEqual(list((root / 'toolchain').iterdir()), [])

    def test_managed_paths_are_specific(self):
        for path in ('/', '/opt', '/root', '/tmp/../opt/node'):
            with self.assertRaises(ValueError):
                boot.safe_directory(Path(path))
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'link'
            target.symlink_to('/tmp')
            with self.assertRaises(ValueError):
                boot.safe_directory(target / 'node')

    def test_no_cuda_driver_install_or_runtime_archive_transport(self):
        self.assertFalse(any('cuda' in package or 'nvidia' in package for package in boot.PACKAGES))
        self.assertFalse(Path(__file__).with_name('export_runtime.py').exists())
        self.assertNotIn('export_runtime.py', Path(__file__).with_name('Dockerfile').read_text())
        template = json.loads(Path(__file__).with_name('vast-template.json').read_text())
        self.assertIn('--revision REPLACE_WITH_SOURCE_COMMIT', template['onstart'])
        self.assertNotIn('RUNTIME_URL', template['onstart'])
        self.assertNotIn('--archive', template['onstart'])

    def test_node_command_does_not_inherit_platform_secrets(self):
        with patch.object(boot, 'runtime_environment', return_value={'HOME': '/data', 'PATH': '/usr/bin:/bin'}):
            command = boot.node_command('-m', 'classic_node', 'pending')
        self.assertIn('-i', command)
        self.assertNotIn('NODE_TOKEN', ' '.join(command))


if __name__ == '__main__':
    unittest.main()
