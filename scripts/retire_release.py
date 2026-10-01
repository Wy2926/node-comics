"""Retire one verified old application container without ever sending SIGKILL."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time

from switch_release import probe, release_lock


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError('Docker retirement check failed; no forced termination performed')
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('role', choices=['api', 'worker', 'maintenance'])
    parser.add_argument('--container', required=True)
    parser.add_argument('--release', required=True, help='Exact release identity of the OLD container')
    parser.add_argument('--active-dir', type=Path, required=True)
    parser.add_argument('--openresty-container')
    parser.add_argument('--port', type=int, help='Old API published loopback port')
    parser.add_argument('--active-release')
    parser.add_argument('--probe-url')
    parser.add_argument('--timeout', type=int, default=1860)
    parser.add_argument('--signal-only', action='store_true', help='Worker only: initiate drain then start its replacement')
    args = parser.parse_args()
    if args.signal_only and args.role != 'worker':
        parser.error('--signal-only is only supported for worker handover')
    if args.timeout < 1:
        parser.error('--timeout must be positive')
    if args.role == 'api' and not all((args.openresty_container, args.port, args.active_release, args.probe_url)):
        parser.error('API retirement requires proxy container, old port, active release and proxy probe URL')
    with release_lock(args.active_dir):
        info = json.loads(docker('inspect', args.container))[0]
        identity = info['Id']  # Freeze identity; never signal a reused container name.
        variables = dict(value.split('=', 1) for value in info['Config']['Env'] if '=' in value)
        role = info['Config'].get('Labels', {}).get('com.docker.compose.service')
        allowed = {'api': {'api-blue', 'api-green'}, 'worker': {'control-worker'}, 'maintenance': {'maintenance'}}
        if role not in allowed[args.role] or variables.get('RELEASE_ID') != args.release:
            raise RuntimeError('Container role/release mismatch; refusing to retire')
        if args.role == 'api':
            if args.active_release == args.release:
                raise RuntimeError('Cannot retire the active release')
            bindings = info['HostConfig']['PortBindings'].get('8000/tcp') or []
            if not any(row['HostPort'] == str(args.port) and row['HostIp'] == '127.0.0.1' for row in bindings):
                raise RuntimeError('Old API port does not match the inspected container')
            active = (args.active_dir / 'api.inc').read_text(encoding='utf-8')
            if re.search(r':' + str(args.port) + r'\s*;', active):
                raise RuntimeError('Old API is still in the active upstream')
            probe(args.probe_url, args.active_release)
            until = time.monotonic() + args.timeout
            while 'worker process is shutting down' in docker('top', args.openresty_container, '-eo', 'pid,args'):
                if time.monotonic() >= until:
                    raise RuntimeError('Proxy has not drained; old API is retained without signalling')
                time.sleep(1)
        if info['State']['Running']:
            # A signal sent with docker kill must not restart the retired process.
            docker('update', '--restart=no', identity)
            docker('kill', '--signal=TERM', identity)
        elif info['State']['ExitCode'] != 0:
            raise RuntimeError('Target is already stopped with an abnormal exit code; inspect its private logs')
        if args.signal_only:
            print('Worker drain requested; start the compatible replacement, then verify exit and settlement')
            return
        until = time.monotonic() + args.timeout
        while True:
            state = json.loads(docker('inspect', '--format', '{{json .State}}', identity))
            if not state['Running']:
                if state['ExitCode'] != 0:
                    raise RuntimeError('Retired process exited abnormally; inspect its private logs')
                break
            if time.monotonic() >= until:
                raise RuntimeError('Drain timed out; old process left running, no SIGKILL sent')
            time.sleep(1)
        print('Old container exited normally; retained for inspection, not deleted')


if __name__ == '__main__':
    main()
