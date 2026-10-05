#!/usr/bin/python3
"""Install a checksummed runtime into the pinned Vast base, before its entrypoint."""
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
from urllib.parse import urlsplit

ROOT = Path('/opt/node')
DATA = Path('/var/lib/node-comics')
CONF = Path('/etc/supervisor/conf.d/node-comics.conf')
FIELDS = ('NODE_CONTROL_URL', 'NODE_ID', 'NODE_TOKEN', 'NODE_RESOURCE_ID')


def validate_identity(environ):
    values = {key: environ.get(key, '').strip() for key in FIELDS}
    if any(not v or v.startswith('REPLACE_') or any(c.isspace() for c in v)
           for v in values.values()):
        raise ValueError('Supply all four per-instance NODE_* identity fields')
    url = urlsplit(values['NODE_CONTROL_URL'])
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ('', '/')):
        raise ValueError('NODE_CONTROL_URL must be an HTTPS origin')
    values['NODE_CONTROL_URL'] = values['NODE_CONTROL_URL'].rstrip('/')
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,120}', values['NODE_RESOURCE_ID']):
        raise ValueError('Invalid resource ID')
    return values


def verify_archive(path, checksum):
    with path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != checksum:
            raise ValueError('Runtime checksum mismatch')


def ensure_account():
    try:
        group = grp.getgrnam('node-comics')
    except KeyError:
        # Refuse unrelated UID/GID collisions; never take over an existing account.
        try:
            grp.getgrgid(10001)
        except KeyError:
            subprocess.run(['groupadd', '--gid', '10001', 'node-comics'], check=True)
        else:
            raise ValueError('GID 10001 is already occupied')
    else:
        if group.gr_gid != 10001:
            raise ValueError('Wrong node-comics GID')
    try:
        user = pwd.getpwnam('node-comics')
    except KeyError:
        try:
            pwd.getpwuid(10001)
        except KeyError:
            subprocess.run(['useradd', '--uid', '10001', '--gid', '10001',
                            '--no-create-home', '--home-dir', str(DATA),
                            '--shell', '/usr/sbin/nologin', 'node-comics'], check=True)
        else:
            raise ValueError('UID 10001 is already occupied')
    else:
        if (user.pw_uid, user.pw_gid, user.pw_dir, user.pw_shell) != (
                10001, 10001, str(DATA), '/usr/sbin/nologin'):
            raise ValueError('Unexpected node-comics account')


def install(args):
    identity = validate_identity(os.environ)  # Fail before the large download.
    os.environ.pop('NODE_TOKEN', None)  # Never let legacy env override config validation.
    if os.geteuid() != 0 or platform.machine() != 'x86_64' or sys.version_info[:2] != (3, 12):
        raise ValueError('Requires root, x86_64 and system Python 3.12')
    release = platform.freedesktop_os_release()
    if (release['ID'], release['VERSION_ID']) != ('ubuntu', '24.04'):
        raise ValueError('Requires Ubuntu 24.04')
    if not shutil.which('supervisorctl'):
        raise ValueError('Vast Supervisor is missing')
    for library in ('libcudart.so.12', 'libcudnn.so.9', 'libGL.so.1', 'libfontconfig.so.1', 'libxkbcommon.so.0', 'libdbus-1.so.3'):
        ctypes.CDLL(library)
    if not re.fullmatch(r'[a-f0-9]{64}', args.sha256):
        raise ValueError('A pinned SHA-256 is required')
    if not args.url.startswith('https://github.com/Wy2926/node-comics/releases/download/'):
        raise ValueError('Use the versioned official runtime release')
    if ROOT.is_symlink() or DATA.is_symlink() or CONF.is_symlink():
        raise ValueError('Refusing symlinked installation paths')
    marker = ROOT / '.runtime-sha256'
    if ROOT.exists():
        if not marker.is_file() or marker.read_text().strip() != args.sha256:
            raise ValueError('Existing runtime differs; drain and explicitly upgrade it')
    else:
        if DATA.exists() or CONF.exists():
            raise ValueError('Existing identity/service has no runtime; operator recovery required')
        print('Node Comics: downloading versioned runtime', flush=True)
        with tempfile.TemporaryDirectory(prefix='node-comics-install-', dir='/opt') as temporary:
            staging = Path(temporary)
            archive = staging / 'runtime.tar.gz'
            subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error',
                            '--proto', '=https', '--proto-redir', '=https', '--retry', '5',
                            '--connect-timeout', '30', '--max-time', '1800',
                            '--output', str(archive), args.url], check=True)
            verify_archive(archive, args.sha256)
            bundle = staging / 'bundle'
            bundle.mkdir(mode=0o755)
            with tarfile.open(archive, 'r:gz') as source:
                # SHA-verified publisher archive; absolute venv Python symlinks are intentional.
                source.extractall(bundle, filter='tar')
            (bundle / '.runtime-sha256').write_text(args.sha256 + '\n')
            (bundle / '.runtime-sha256').chmod(0o644)
            bundle.rename(ROOT)
        print('Node Comics: runtime checksum verified and installed', flush=True)
    ensure_account()
    DATA.mkdir(mode=0o700, exist_ok=True)
    os.chown(DATA, 10001, 10001)
    DATA.chmod(0o700)
    sys.path.insert(0, str(ROOT / 'engine'))
    entry_path = ROOT / 'source/compute-node/linux/entrypoint.py'
    spec = importlib.util.spec_from_file_location('node_entry', entry_path)
    entry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entry)
    config = entry.prepare_config(DATA, identity)
    os.chown(config, 10001, 10001)
    config.chmod(0o600)
    subprocess.run(['runuser', '-u', 'node-comics', '--', 'env',
                    'PYTHONPATH=/opt/node/engine', 'PYTHONDONTWRITEBYTECODE=1',
                    str(ROOT / 'venv/bin/python'),
                    str(ROOT / 'source/compute-node/linux/verify_assets.py')], check=True)
    desired = (ROOT / 'source/compute-node/linux/node-comics.supervisor.conf').read_bytes()
    if CONF.exists() and CONF.read_bytes() != desired:
        raise ValueError('Existing service config differs; operator review required')
    if not CONF.exists():
        with tempfile.NamedTemporaryFile(dir=CONF.parent, delete=False) as output:
            temp = Path(output.name)
            output.write(desired)
        try:
            temp.chmod(0o644)
            os.link(temp, CONF)
        finally:
            temp.unlink()
    print('Node Comics: identity ready; Vast Supervisor will start GPU warmup and registration', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        with open('/run/node-comics-install.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            install(args)
    except Exception:
        # Exception messages can contain identity values; never emit them or a traceback.
        print('Node Comics bootstrap failed: check identity, pinned runtime SHA, base libraries, '
              'disk space and existing installation. Existing state was preserved.', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
