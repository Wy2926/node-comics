"""Exercise the Windows cleanup script only in disposable synthetic repositories."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'remove-obsolete-artifacts.ps1'
POWERSHELL = shutil.which('powershell.exe')


@unittest.skipUnless(os.name == 'nt' and POWERSHELL, 'Windows PowerShell is required')
class ArtifactCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='node-comics-cleanup-')
        self.base = Path(self.temporary.name)
        self.repo = self.base / 'repo with spaces 漫画'
        self.repo.mkdir()
        subprocess.run(['git', 'init', '-q', self.repo], check=True)
        self.write('apps/extension/wxt.config.ts', 'fixture')
        self.write('scripts/remove-obsolete-artifacts.ps1', SCRIPT.read_text(encoding='utf-8'))
        self.write('.gitignore', 'artifacts/\n')

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, content='fixture'):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        return path

    def run_cleanup(self, *args):
        return subprocess.run(
            [POWERSHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
             self.repo / 'scripts/remove-obsolete-artifacts.ps1', *args],
            cwd=self.base, capture_output=True, text=True, errors='replace', timeout=90,
        )

    def junction(self, link, target):
        link.parent.mkdir(parents=True, exist_ok=True)
        helper = self.base / 'junction.ps1'
        helper.write_text('param($Link, $Target)\nNew-Item -ItemType Junction -Path $Link -Target $Target | Out-Null\n')
        result = subprocess.run(
            [POWERSHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
             str(link), str(target)], capture_output=True, text=True, errors='replace',
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_preview_apply_preservation_and_repeat(self):
        obsolete = self.write('artifacts/node-clean-02/deep/readonly.txt')
        os.chmod(obsolete, 0o444)
        preserved = [self.write(name) for name in [
            'artifacts/node-clean-03/release/current.zip',
            'artifacts/marketing/2026-09-24/screenshots/image.png',
            'services/classic-engine/artifacts/production-node/node.json',
            'services/compute-node/artifacts/distribution/current.zip',
            'artifacts/unlisted/data.txt', 'output/asset.png', 'data/node.json', 'models/weight.bin',
        ]]
        self.write('artifacts/node-clean-03/work/build.txt')
        preview = self.run_cleanup()
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertTrue(obsolete.exists())
        self.assertIn('Preview only', preview.stdout)
        applied = self.run_cleanup('-Apply')
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertFalse((self.repo / 'artifacts/node-clean-02').exists())
        self.assertFalse((self.repo / 'artifacts/node-clean-03/work').exists())
        self.assertTrue(all(path.exists() for path in preserved))
        repeated = self.run_cleanup('-Apply')
        self.assertEqual(repeated.returncode, 0, repeated.stderr)

    def test_tracked_content_aborts_before_any_removal(self):
        untouched = self.write('artifacts/admin-completion/result.json')
        tracked = self.write('artifacts/node-clean-02/keep.txt')
        subprocess.run(['git', '-C', self.repo, 'add', '-f', tracked], check=True)
        result = self.run_cleanup('-Apply')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Refusing tracked content', result.stderr)
        self.assertTrue(untouched.exists() and tracked.exists())

    def test_nested_junction_removes_link_only(self):
        target = self.base / 'outside'
        target.mkdir()
        sentinel = target / 'keep.txt'
        sentinel.write_text('keep')
        link = self.repo / 'artifacts/node-clean-02/link'
        self.junction(link, target)
        result = self.run_cleanup('-Apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(link.exists())
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_running_target_aborts_before_any_removal(self):
        untouched = self.write('artifacts/admin-completion/result.json')
        worker = self.write('artifacts/node-clean-02/worker.py',
                            'from pathlib import Path\nimport sys, time\n'
                            'Path(sys.argv[1]).touch()\ntime.sleep(60)\n')
        ready = self.base / 'worker-ready'
        process = subprocess.Popen([sys.executable, worker, ready],
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            deadline = time.monotonic() + 10
            while not ready.exists() and time.monotonic() < deadline and process.poll() is None:
                time.sleep(0.05)
            self.assertTrue(ready.exists(), 'Synthetic worker did not start')
            result = self.run_cleanup('-Apply')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Close process', result.stderr)
            self.assertTrue(untouched.exists() and worker.exists())
        finally:
            process.terminate()
            process.wait(timeout=10)

    def test_linked_artifact_root_is_rejected(self):
        target = self.base / 'outside'
        target.mkdir()
        (target / 'node-clean-02').mkdir()
        sentinel = target / 'node-clean-02/keep.txt'
        sentinel.write_text('keep')
        link = self.repo / 'artifacts'
        self.junction(link, target)
        try:
            result = self.run_cleanup('-Apply')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Ancestor is a junction', result.stderr)
            self.assertTrue(sentinel.exists())
        finally:
            os.rmdir(link)


if __name__ == '__main__':
    unittest.main()
