"""Target-host checks. JSON diagnostics contain no identity, URL or credential."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def host_security():
    libc = ctypes.CDLL(None, use_errno=True)
    abi = libc.syscall(444, 0, 0, 1)
    status = Path('/proc/self/status').read_text()
    return {'landlock_abi': max(0, abi), 'landlock_errno': ctypes.get_errno() if abi < 0 else 0,
            'seccomp': next((s.split(':')[1].strip() for s in status.splitlines() if s.startswith('Seccomp:')), '?')}


def check(config_path, *, local_only=False):
    from classic_node.config import load
    from comic_document_files import check_parser_sandbox
    code = 'NODE_CONFIG_INVALID'
    result = {'ready': False, 'checks': {}}
    try:
        if os.geteuid() == 0:
            raise ValueError('Node must run unprivileged')
        if config_path.stat().st_mode & 0o077:
            raise ValueError('Config must be private')
        config = load(config_path)
        state = Path(config['state_dir'])
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        code = 'NODE_STATE_DISK_LOW'
        free = shutil.disk_usage(state).free
        # Existing workspaces must remain recoverable even when the remaining
        # free space is below a fresh full spool allocation.
        existing = state / 'documents'
        reserve = 2 * 1024 ** 3 if existing.exists() and any(existing.iterdir()) else config['document_spool_bytes'] + 2 * 1024 ** 3
        if free < reserve:
            raise ValueError('Insufficient spool reserve')
        result['checks']['disk'] = {'free_bytes': free, 'spool_budget': config['document_spool_bytes'],
                                    'shm_free_bytes': shutil.disk_usage('/dev/shm').free}
        code = 'NODE_GPU_DRIVER_UNAVAILABLE'
        gpu = subprocess.run(['nvidia-smi', f'--id={config["engine"]["gpu"]}',
            '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, check=True, timeout=20).stdout.strip().split(',')
        driver = ctypes.CDLL('libcuda.so.1')
        version = ctypes.c_int()
        if driver.cuInit(0) or driver.cuDriverGetVersion(ctypes.byref(version)) or version.value < 12000:
            raise ValueError('CUDA 12 driver required')
        result['checks']['gpu'] = {'name': gpu[0].strip(), 'driver': gpu[1].strip(),
            'memory_mib': int(gpu[2]), 'driver_cuda': version.value, 'model_warmup': 'pending'}
        code = 'NODE_PARSER_SANDBOX_UNAVAILABLE'
        result['checks']['security'] = host_security()
        try:
            check_parser_sandbox(state, require_sandbox=True)
        except Exception:
            result['checks']['security'].update(document_protocol=None, denial_probe=False,
                                               code=code)
            # Do not silently abandon file work after a host capability loss.
            if existing.exists() and any(existing.iterdir()):
                raise
        else:
            result['checks']['security'].update(parser='landlock-seccomp', document_protocol=2,
                                               denial_probe=True)
        if not local_only:
            code = 'NODE_CONTROL_TLS_UNREACHABLE'
            from classic_node.transport import control_client
            with control_client(config, timeout=15) as client:
                # Any HTTP status proves TLS connectivity; do not require a
                # public health route, follow redirects or send node identity.
                client.head('/')
            result['checks']['control_tls'] = True
        result['ready'] = True
    except Exception:
        result['code'] = code
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--local-only', action='store_true')
    args = parser.parse_args()
    result = check(args.config, local_only=args.local_only)
    print(json.dumps(result), flush=True)
    return 0 if result['ready'] else 1


if __name__ == '__main__':
    sys.exit(main())
