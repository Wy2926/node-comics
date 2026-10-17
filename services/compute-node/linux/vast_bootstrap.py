#!/usr/bin/python3
"""Online Vast installation: pinned source, locked dependencies, cached assets."""
import argparse
import ctypes
import fcntl
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path('/opt/node')
DATA = Path('/var/lib/node-comics')
CACHE = Path('/var/cache/node-comics')
RELEASES = Path('/opt/node-releases')
CONF = Path('/etc/supervisor/conf.d/node-comics.conf')
REPOSITORY = 'https://github.com/Wy2926/node-comics.git'
UV_VERSION = '0.12.17'
UV_SHA256 = 'fa82fd8dde8e8eefdecada6aa0889666556cfceb690d06e0c3bca49eb3070a63'
FIELDS = ('NODE_CONTROL_URL', 'NODE_ID', 'NODE_TOKEN', 'NODE_RESOURCE_ID')
PACKAGES = ('ca-certificates', 'curl', 'git', 'python3-venv', 'python3-dev', 'gcc',
            'libseccomp2', 'libgl1', 'libegl1', 'libglib2.0-0t64', 'libgomp1', 'zlib1g',
            'libfontconfig1', 'libfreetype6', 'libxkbcommon0', 'libdbus-1-3')
SOURCES = ('services/classic-engine/classic_node', 'services/classic-engine/mtu_engine',
           'services/classic-engine/mtu_engine/upstream.lock.json',
           'services/classic-engine/tools/prepare_mtu.py', 'services/classic-engine/pyproject.toml',
           'services/classic-engine/uv.lock', 'services/classic-engine/LICENSE',
           'services/classic-engine/THIRD_PARTY.md', 'services/compute-node/build_support.py',
           'services/compute-node/assets.json', 'services/compute-node/toolchain.lock.json',
           *(f'services/compute-node/linux/{name}' for name in (
               'vast_bootstrap.py', 'build_assets.py', 'entrypoint.py', 'service.py', 'preflight.py',
               'verify_assets.py', 'node.example.json', 'node-comics.supervisor.conf')),
           'backend/document_files/pyproject.toml', 'backend/document_files/comic_document_files')
STAGE = 'arguments'


def event(stage, **values):
    global STAGE
    STAGE = stage
    print(json.dumps({'stage': stage, **values}), flush=True)


def atomic_write(path, content, mode=0o644):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name, delete=False) as output:
            temporary = Path(output.name)
            output.write(content)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def safe_directory(path):
    if not path.is_absolute() or '..' in path.parts or len(path.parts) < 3:
        raise ValueError('Use a dedicated absolute directory')
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Use a real deployment data/cache directory')


def ensure_account():
    try:
        group = grp.getgrnam('node-comics')
    except KeyError:
        subprocess.run(['groupadd', '--gid', '10001', 'node-comics'], check=True)
    else:
        if group.gr_gid != 10001:
            raise ValueError('Wrong node-comics GID')
    try:
        user = pwd.getpwnam('node-comics')
    except KeyError:
        subprocess.run(['useradd', '--uid', '10001', '--gid', '10001', '--no-create-home',
                        '--home-dir', '/var/lib/node-comics', '--shell', '/usr/sbin/nologin',
                        'node-comics'], check=True)
    else:
        if (user.pw_uid, user.pw_gid) != (10001, 10001):
            raise ValueError('Wrong node-comics UID/GID')


def install_dependencies():
    result = subprocess.run(['dpkg-query', '-W', '-f=$' + '{Package} $' + '{db:Status-Status}\n',
                             *PACKAGES], capture_output=True, text=True)
    installed = {line.split()[0] for line in result.stdout.splitlines() if line.endswith(' installed')}
    missing = [name for name in PACKAGES if name not in installed]
    if missing:
        subprocess.run(['apt-get', '-o', 'Acquire::Retries=5', '-o', 'DPkg::Lock::Timeout=120', 'update'], check=True)
        subprocess.run(['apt-get', '-o', 'Acquire::Retries=5', '-o', 'DPkg::Lock::Timeout=120',
                        'install', '-y', '--no-install-recommends', *missing],
                       env=dict(os.environ, DEBIAN_FRONTEND='noninteractive'), check=True)
    event('system_dependencies_ready', installed=len(missing))


def host_preflight():
    libc = ctypes.CDLL(None, use_errno=True)
    abi = libc.syscall(444, 0, 0, 1)
    event('host_preflight', landlock_abi=max(0, abi))
    # File parsing is an optional capability, probed by node preflight and
    # registration. Older hosts can still install and run ordinary image jobs.
    driver = ctypes.CDLL('libcuda.so.1')
    version = ctypes.c_int()
    if driver.cuInit(0) or driver.cuDriverGetVersion(ctypes.byref(version)) or version.value < 12000:
        raise ValueError('A working NVIDIA CUDA 12 driver is required')


def download(url, partial):
    command = ['curl', '--fail', '--location', '--silent', '--show-error', '--proto', '=https',
               '--proto-redir', '=https', '--retry', '5', '--retry-all-errors', '--connect-timeout', '30',
               '--max-time', '7200', '--continue-at', '-', '--output', str(partial), url]
    result = subprocess.run(command, stderr=subprocess.DEVNULL)
    if result.returncode == 33:
        partial.unlink(missing_ok=True)
        subprocess.run(command, check=True, stderr=subprocess.DEVNULL)
    elif result.returncode:
        raise RuntimeError('Download failed; partial cache retained')


def uv_binary():
    target = CACHE / 'toolchain' / ('uv-' + UV_VERSION)
    if target.is_file():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    archive = target.with_suffix('.tar.gz.partial')
    download(f'https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz', archive)
    with archive.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != UV_SHA256:
            archive.unlink()
            raise ValueError('uv archive checksum mismatch')
    with tarfile.open(archive) as package, package.extractfile('uv-x86_64-unknown-linux-gnu/uv') as source:
        temporary = target.with_suffix('.partial')
        with temporary.open('wb') as output:
            shutil.copyfileobj(source, output)
    temporary.chmod(0o755)
    temporary.replace(target)
    archive.unlink()
    return target


def pull_source(revision):
    """Fetch code only; no environment archives or model uploads."""
    repository = CACHE / 'repository.git'
    checkout = CACHE / 'checkouts' / revision
    if checkout.is_dir():
        return checkout
    if not repository.exists():
        subprocess.run(['git', 'init', '--bare', str(repository)], check=True, stdout=subprocess.DEVNULL)
    command = ['git', '--git-dir=' + str(repository)]
    subprocess.run([*command, 'fetch', '--depth=1', REPOSITORY, revision], check=True)
    actual = subprocess.check_output([*command, 'rev-parse', 'FETCH_HEAD'], text=True).strip()
    if actual != revision:
        raise ValueError('Fetched commit does not match the pinned revision')
    checkout.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.checkout-', dir=checkout.parent) as temporary:
        proc = subprocess.Popen([*command, 'archive', revision, *SOURCES], stdout=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=proc.stdout, mode='r|') as archive:
                archive.extractall(temporary, filter='data')
        finally:
            proc.stdout.close()
            result = proc.wait()
        if result:
            raise RuntimeError('Could not extract the pinned source')
        Path(temporary).rename(checkout)
    return checkout


def source_files(source):
    for name in SOURCES:
        path = source / name
        if any(p.is_symlink() for p in (path, *path.parents) if p.is_relative_to(source)):
            raise ValueError('Source snapshot must not traverse links')
        if not path.exists():
            raise ValueError('Required deployment source is missing')
        for item in sorted(path.rglob('*')) if path.is_dir() else (path,):
            if item.is_symlink():
                raise ValueError('Source snapshot must contain regular files')
            if not item.is_file() or any(part.startswith(('.', '__pycache__')) for part in item.relative_to(source).parts):
                continue
            if (path.is_dir() and item.suffix != '.py') or item.name.startswith('test_'):
                continue
            if '.private.' in item.name or '.local.' in item.name:
                continue
            relative = item.relative_to(source)
            destination = Path('source') / relative.relative_to('services') if relative.parts[0] == 'services' else relative
            yield destination, item.read_bytes().replace(b'\r\n', b'\n')


def source_version(files, revision=None):
    if revision:
        return revision
    digest = hashlib.sha256()
    for relative, data in files:
        digest.update(relative.as_posix().encode() + b'\0' + data + b'\0')
    return 'local-' + digest.hexdigest()[:24]


def runtime_module(root, name, filename):
    spec = importlib.util.spec_from_file_location(name, root / 'source/compute-node/linux' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def runtime_environment(root=ROOT):
    env = runtime_module(root, 'node_service_environment', 'service.py').environment(DATA)
    env['PYTHONPATH'] = str(root / 'engine')
    return env


def node_command(*args, root=ROOT):
    return ['runuser', '-u', 'node-comics', '--', 'env', '-i',
            *(f'{key}={value}' for key, value in runtime_environment(root).items()),
            str(root / 'venv/bin/python'), *map(str, args)]


def current_version():
    if not ROOT.exists() and not ROOT.is_symlink():
        return None
    if not ROOT.is_symlink() or ROOT.resolve().parent != RELEASES.resolve():
        raise ValueError('Existing /opt/node is not a managed online installation; preserve it before adoption')
    version = (ROOT / '.source-revision').read_text().strip()
    if not version or version != ROOT.resolve().name:
        raise ValueError('Active release completion marker is invalid; preserve it for recovery')
    return version


def ensure_drained():
    result = subprocess.run(['supervisorctl', 'status', 'node-comics'], capture_output=True, text=True)
    if CONF.exists() and not any(word in result.stdout.split() for word in ('STOPPED', 'EXITED', 'FATAL')):
        raise ValueError('Stop and drain the service before switching versions')
    subprocess.run(node_command('-m', 'classic_node', 'pending', '--config', DATA / 'node.json'),
                   cwd=DATA, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    config = json.loads((DATA / 'node.json').read_text())
    documents = (DATA / config.get('state_dir', 'state')).resolve() / 'documents'
    if documents.exists() and any(documents.iterdir()):
        raise ValueError('Document workspaces must be terminal before switching versions')


def prepare_release(files, version):
    root = RELEASES / version
    if (root / '.source-revision').is_file():
        if (root / '.source-revision').read_text().strip() != version:
            raise ValueError('Completed release identity differs')
        return root
    event('source_prepare', version=version)
    root.mkdir(parents=True, exist_ok=True)
    for relative, content in files:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    if not (root / 'engine').exists():
        (root / 'engine').symlink_to('source/classic-engine', target_is_directory=True)
    env = dict(os.environ, UV_CACHE_DIR=str(CACHE / 'uv'), UV_PYTHON_DOWNLOADS='never',
        UV_PROJECT_ENVIRONMENT=str(root / 'venv'), UV_LINK_MODE='hardlink', UV_NO_CONFIG='1',
        UV_NO_CACHE='false',
        UV_HTTP_RETRIES='5', UV_HTTP_TIMEOUT='120', UV_CONCURRENT_DOWNLOADS='4')
    event('python_dependencies')
    subprocess.run([str(uv_binary()), 'sync', '--locked', '--no-dev', '--no-install-project',
                    '--no-editable', '--python', '/usr/bin/python3'],
                   cwd=root / 'source/classic-engine', env=env, check=True)
    # Only the validated completion marker permits reuse. An interrupted asset
    # manifest is not a completed release; rebuild this inactive target from cache.
    event('model_font_download')
    subprocess.run(['/usr/bin/python3', root / 'source/compute-node/linux/build_assets.py',
                    '--output', root, '--existing-root', '--cache', CACHE / 'downloads'], env=env, check=True)
    return root


def prepare_config(root, identity, supplied_path):
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    DATA.chmod(0o700)
    os.chown(DATA, 10001, 10001)
    environment = runtime_environment(root)
    # Bootstrap is stdlib-only. Config validation imports runtime dependencies
    # (e.g. psutil), which belong to the locked venv, not Vast's system Python.
    command = [str(root / 'venv/bin/python'), str(root / 'source/compute-node/linux/entrypoint.py'),
               'prepare-config', str(DATA)]
    if supplied_path:
        command.append(str(supplied_path.resolve(strict=True)))
    subprocess.run(command, input=json.dumps(identity), text=True, env=environment,
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    config = DATA / 'node.json'
    config.chmod(0o600)
    os.chown(config, 10001, 10001)
    subprocess.run(['runuser', '-u', 'node-comics', '--', 'mkdir', '-p',
        *(environment[key] for key in ('XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'YOLO_CONFIG_DIR', 'CUDA_CACHE_PATH'))],
        check=True)
    return config


def activate(root):
    temporary = ROOT.with_name('.node-next')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(root, target_is_directory=True)
    temporary.replace(ROOT)


def service_status():
    result = subprocess.run(['supervisorctl', 'status', 'node-comics'], capture_output=True, text=True)
    fields = result.stdout.split()
    if len(fields) >= 2 and fields[0] == 'node-comics' and fields[1] in (
            'STOPPED', 'STARTING', 'RUNNING', 'BACKOFF', 'STOPPING', 'EXITED', 'FATAL'):
        return fields[1]
    if 'no such process' in result.stdout:
        return 'ABSENT'
    raise RuntimeError('Cannot determine the managed service state')


def start_service(config_changed):
    status = service_status()
    if config_changed or status == 'ABSENT':
        subprocess.run(['supervisorctl', 'reread'], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['supervisorctl', 'update', 'node-comics'], check=True, stdout=subprocess.DEVNULL)
        status = service_status()
    if status not in ('RUNNING', 'STARTING'):
        subprocess.run(['supervisorctl', 'start', 'node-comics'], check=True, stdout=subprocess.DEVNULL)


def configure_service(root, desired):
    previous = ROOT.resolve() if ROOT.exists() else None
    old_config = CONF.read_bytes() if CONF.exists() else None
    changed = old_config != desired
    pending = CONF.with_name('.node-comics.next')
    # All fallible preparation happens before publishing the active link.
    if changed:
        atomic_write(pending, desired)
    switched = previous != root
    attempted_start = False
    try:
        if switched:
            activate(root)
        if changed:
            pending.replace(CONF)
        attempted_start = True
        start_service(changed)
    except Exception:
        failed_stage = STAGE
        try:
            # Never point a running new worker at old code. Unknown Supervisor
            # state stops rollback rather than risking two versions/identities.
            if attempted_start and service_status() not in ('ABSENT', 'STOPPED', 'EXITED', 'FATAL'):
                subprocess.run(['supervisorctl', 'stop', 'node-comics'], check=True, stdout=subprocess.DEVNULL)
            if switched:
                if previous is None:
                    ROOT.unlink(missing_ok=True)
                else:
                    activate(previous)
            if changed:
                if old_config is None:
                    CONF.unlink(missing_ok=True)
                else:
                    atomic_write(CONF, old_config)
                if attempted_start:
                    subprocess.run(['supervisorctl', 'reread'], check=True, stdout=subprocess.DEVNULL)
                    subprocess.run(['supervisorctl', 'update', 'node-comics'], check=True, stdout=subprocess.DEVNULL)
                    if service_status() not in ('ABSENT', 'STOPPED', 'EXITED', 'FATAL'):
                        subprocess.run(['supervisorctl', 'stop', 'node-comics'], check=True, stdout=subprocess.DEVNULL)
            event('rollback_restored', service_left_stopped=True)
        except Exception as error:
            event('rollback_failed', error_type=type(error).__name__, operator_action_required=True)
        event(failed_stage)
        raise
    finally:
        pending.unlink(missing_ok=True)


def install(args):
    identity = {key: os.environ.pop(key, '') for key in FIELDS}
    if not any(identity.values()) and not (DATA / 'node.json').is_file() and not args.config:
        raise ValueError('Provide a per-node identity or private config')
    event('platform_preflight')
    if os.geteuid() != 0 or platform.machine() != 'x86_64' or sys.version_info[:2] != (3, 12):
        raise ValueError('Requires root, x86_64 and Python 3.12')
    release = platform.freedesktop_os_release()
    if (release['ID'], release['VERSION_ID']) != ('ubuntu', '24.04') or not shutil.which('supervisorctl'):
        raise ValueError('Requires the Ubuntu 24.04 Vast template with Supervisor')
    for path in (DATA, CACHE, RELEASES, CONF):
        safe_directory(path)
    install_dependencies()
    host_preflight()
    ensure_account()
    current = current_version()
    previous_umask = os.umask(0o022)
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        RELEASES.mkdir(parents=True, exist_ok=True)
        RELEASES.chmod(0o755)
        source = args.source_dir.resolve(strict=True) if args.source_dir else pull_source(args.revision)
        files = tuple(source_files(source))
        version = source_version(files, args.revision)
        if current and current != version:
            if args.expected_current != current:
                raise ValueError('Confirm the current version with --expected-current before switching')
            event('upgrade_drain_check')
            ensure_drained()
        elif args.expected_current and args.expected_current != current:
            raise ValueError('Current version changed')
        root = prepare_release(files, version)
    finally:
        os.umask(previous_umask)
    config = prepare_config(root, identity, args.config)
    if current != version:
        event('node_preflight')
        subprocess.run(node_command(root / 'source/compute-node/linux/preflight.py', '--config', config,
                                    '--local-only', root=root), cwd=DATA, check=True)
        event('asset_verification')
        subprocess.run(node_command(root / 'source/compute-node/linux/verify_assets.py',
                                    '--bundle-root', root, root=root), check=True,
                       cwd=DATA, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        event('gpu_warmup')
        subprocess.run(node_command('-m', 'classic_node', 'check', '--config', config,
                                    '--bundle-root', root, root=root), check=True,
                       cwd=DATA, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        atomic_write(root / '.source-revision', (version + '\n').encode())
    if args.start:
        desired = (root / 'source/compute-node/linux/node-comics.supervisor.conf').read_text().replace(
            '/var/lib/node-comics', str(DATA)).encode()
        if CONF.exists() and CONF.read_bytes() != desired and current == version:
            raise ValueError('Existing Supervisor configuration differs')
        event('service_activation')
        configure_service(root, desired)
    event('ready' if args.start else 'prepared', version=version,
          service_start_requested=args.start, state_preserved=True)


def main():
    global DATA
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--revision', help='Full published Git commit to pull on this server')
    source.add_argument('--source-dir', type=Path, help='Use an existing source checkout; environment is still installed online')
    parser.add_argument('--config', type=Path)
    parser.add_argument('--data-dir', type=Path, default=DATA)
    parser.add_argument('--expected-current')
    parser.add_argument('--start', action='store_true', help='Activate and start; omit to prepare and validate only')
    args = parser.parse_args()
    if args.revision and not re.fullmatch(r'[0-9a-f]{40}', args.revision):
        parser.error('--revision must be a full commit SHA')
    DATA = args.data_dir
    os.umask(0o077)
    try:
        with open('/run/node-comics-install.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            install(args)
    except Exception as error:
        event('failed', failed_stage=STAGE, error_type=type(error).__name__,
              exit_code=getattr(error, 'returncode', None), state_preserved=True)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
