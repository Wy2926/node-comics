"""Transactional OpenResty include activation. Never stops containers or migrates DBs.

Run on the proxy host. All configuration changes use one directory-wide lock.
First installation must already have working includes; normal releases retain them.
"""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request


@contextmanager
def release_lock(directory):
    with (directory / '.release.lock').open('a+b') as handle:
        if os.name == 'nt':
            import msvcrt
            handle.seek(0)
            handle.write(b'0')
            handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == 'nt':
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def atomic_write(path, content):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def probe(url, release, *, static=False):
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'Connection': 'close',
        'User-Agent': 'Mozilla/5.0 NodeComicsReleaseCheck/1.0'})
    with urllib.request.urlopen(request, timeout=5) as response:
        if static:
            if response.headers.get('X-Static-Release') != release:
                raise RuntimeError('Proxy is not serving the expected static release')
        else:
            payload = json.load(response)
            if payload.get('status') != 'ready' or payload.get('release') != release:
                raise RuntimeError('API is not ready at the expected release')


def activate(active, content, run_nginx, verify, *, verify_previous=None, preflight=None, timeout=30):
    """Restore the previous disk and running config if testing/reload/probing fails."""
    if active.is_symlink() or not active.is_file():
        raise ValueError('Active include must be an existing regular file')
    with release_lock(active.parent):
        if preflight:
            preflight()
        previous = active.read_bytes()
        atomic_write(active.with_suffix(active.suffix + '.previous'), previous)
        atomic_write(active, content)
        try:
            run_nginx('-t')
            run_nginx('-s', 'reload')
            deadline = time.monotonic() + timeout
            while True:
                try:
                    verify()
                    break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Post-reload verification timed out') from None
                    time.sleep(.25)
        except BaseException:
            atomic_write(active, previous)
            try:
                run_nginx('-t')
                run_nginx('-s', 'reload')
                if verify_previous:
                    deadline = time.monotonic() + timeout
                    while True:
                        try:
                            verify_previous()
                            break
                        except Exception:
                            if time.monotonic() >= deadline:
                                raise RuntimeError('Previous release could not be verified') from None
                            time.sleep(.25)
            except Exception:
                raise RuntimeError('Previous include restored, but proxy recovery requires operator attention') from None
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['api', 'static'])
    parser.add_argument('--active-file', type=Path, required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--previous-release', required=True)
    parser.add_argument('--probe-url', required=True, help='Uncached public/proxy endpoint, NOT the candidate port')
    parser.add_argument('--port', type=int, help='Candidate API loopback port')
    parser.add_argument('--candidate-file', type=Path, help='Prepared static include')
    proxy = parser.add_mutually_exclusive_group(required=True)
    proxy.add_argument('--openresty-container')
    proxy.add_argument('--nginx-bin', help='Native OpenResty nginx binary')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', args.release):
        parser.error('Invalid release ID')
    if args.kind == 'api':
        if not args.port or not 1024 <= args.port <= 65535:
            parser.error('API activation requires a valid --port')
        probe(f'http://127.0.0.1:{args.port}/health/ready', args.release)
        content = f'# release {args.release}\nserver 127.0.0.1:{args.port};\n'.encode()
    else:
        if not args.candidate_file:
            parser.error('Static activation requires --candidate-file')
        content = args.candidate_file.read_bytes()
    # Verify the rollback target before changing anything.
    previous_probe = lambda: probe(args.probe_url, args.previous_release, static=args.kind == 'static')
    previous_probe()
    command = ['docker', 'exec', args.openresty_container, 'openresty'] if args.openresty_container else [args.nginx_bin]

    def run_nginx(*options):
        # Configuration may include the hidden admin entry: never print the config.
        result = subprocess.run(command + list(options), capture_output=True, timeout=15)
        if result.returncode:
            raise RuntimeError('OpenResty command failed; inspect its private error log')

    activate(args.active_file, content, run_nginx,
             lambda: probe(args.probe_url, args.release, static=args.kind == 'static'),
             verify_previous=previous_probe, preflight=previous_probe)
    print(json.dumps({'active': args.release, 'previous': args.previous_release,
                      'old_processes': 'retained; drain before retirement'}))


if __name__ == '__main__':
    main()
