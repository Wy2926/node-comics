"""Build only Git-visible node sources in a fresh local Git clone and empty workdir.

The temporary snapshot repository records uncommitted source changes for testing;
it never stages, commits, pushes, or changes HEAD in the user's repository.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

REPOSITORY = Path(__file__).resolve().parents[3]


def verify(directory, version):
    directory.mkdir(parents=True, exist_ok=False)
    snapshot, checkout, work = (directory / name for name in ('snapshot', 'checkout', 'work'))
    snapshot.mkdir()
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
    # A parent PowerShell 7 module path is not a Windows PowerShell 5.1 path.
    env.pop('PSModulePath', None)
    def git(root, *args):
        return subprocess.check_output(['git', '-C', str(root), *args], env=env, encoding='utf-8').strip()
    paths = git(REPOSITORY, '-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard',
                '--', 'services/classic-engine', 'services/compute-node').splitlines()
    hashes = {}
    for relative in sorted(set(paths)):
        source = REPOSITORY / relative
        if not source.is_file():
            continue
        if source.is_symlink() or not source.resolve().is_relative_to(REPOSITORY):
            raise ValueError('Source escapes repository')
        destination = snapshot / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        hashes[relative] = hashlib.sha256(source.read_bytes()).hexdigest()
    git(snapshot, 'init', '--quiet', '-b', 'verification')
    git(snapshot, 'config', 'core.autocrlf', 'false')
    git(snapshot, 'add', '--all')
    git(snapshot, '-c', 'user.name=Build Verification', '-c', 'user.email=build-verification@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL', 'commit', '--quiet', '-m', 'Isolated source build verification')
    git(directory, 'clone', '--quiet', '--no-hardlinks', str(snapshot), str(checkout))
    assert git(checkout, 'status', '--porcelain') == ''
    for relative in ('services/classic-engine/models', 'services/classic-engine/.venv-lama', 'services/compute-node/.build'):
        assert not (checkout / relative).exists(), relative
    assert not work.exists()
    output = directory / 'release' / f'NodeComicsNode-{version}-windows-x64'
    result = {'snapshot': git(checkout, 'rev-parse', 'HEAD'), 'source_files': hashes,
              'initially_clean': True, 'initial_work_directory_empty': True, 'reused_existing_models_or_venv': False}
    (directory / 'inputs.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in result.items() if key != 'source_files'}), flush=True)
    started = time.monotonic()
    command = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
               str(checkout / 'services/compute-node/build.ps1'), '-Version', version,
               '-OutputDirectory', str(output), '-WorkDirectory', str(work)]
    with (directory / 'build.log').open('w', encoding='utf-8') as log:
        process = subprocess.Popen(command, cwd=checkout, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, encoding='utf-8', errors='replace')
        for line in process.stdout:
            print(line, end='', flush=True)
            log.write(line)
            log.flush()
        code = process.wait()
    result.update(exit_code=code, elapsed_seconds=round(time.monotonic() - started, 1),
                  source_status_after=git(checkout, 'status', '--porcelain'))
    if code == 0:
        archive = output.parent / (output.name + '.zip')
        with archive.open('rb') as stream:
            result['archive_sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
        result['archive_bytes'] = archive.stat().st_size
        result['archive'] = str(archive)
    (directory / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    if code or result['source_status_after']:
        raise RuntimeError('Clean checkout build failed; inspect build.log and result.json')
    print(json.dumps({key: value for key, value in result.items() if key != 'source_files'}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--version', default='0.1.0')
    args = parser.parse_args()
    verify(args.directory.resolve(), args.version)
