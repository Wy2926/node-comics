"""Credential-clean service loop; bounded retry survives a boot-time outage."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from threading import Event
import time


def environment(home):
    # Do not inherit Vast CONTAINER_API_KEY, account-level tokens, proxy URLs,
    # NODE_TOKEN or Python injection settings from Supervisor's environment.
    return {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'PYTHONPATH': '/opt/node/engine',
            'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUNBUFFERED': '1', 'PYTHONUTF8': '1',
            'QT_QPA_PLATFORM': 'offscreen', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
            'XDG_CACHE_HOME': str(home / 'cache'), 'XDG_CONFIG_HOME': str(home / 'config'),
            'YOLO_CONFIG_DIR': str(home / 'cache/ultralytics'),
            'CUDA_CACHE_PATH': str(home / 'cache/cuda')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    os.environ.clear()
    os.environ.update(environment(args.config.parent))
    from preflight import check
    from classic_node.config import load
    state = Path(load(args.config)['state_dir'])
    stop = Event()
    child = None

    def shutdown(*_):
        stop.set()
        if child and child.poll() is None:
            child.terminate()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    libc, parent = ctypes.CDLL(None, use_errno=True), os.getpid()

    def own_worker():
        # This supervisor loop is single-threaded. A killed wrapper must not
        # leave an orphan GPU worker outside Supervisor's process group.
        if libc.prctl(1, signal.SIGTERM, 0, 0, 0) or os.getppid() != parent:
            os._exit(1)

    delay = 5
    while not stop.is_set() and not (state / 'stop').exists():
        result = check(args.config)
        print(json.dumps({'event': 'preflight', **result}), flush=True)
        if result['ready'] and not stop.is_set():
            started = time.monotonic()
            # Native node logs are bounded and sanitized. Third-party stderr can
            # contain private OCR text; never forward it to the instance console.
            child = subprocess.Popen([sys.executable, '-m', 'classic_node', 'run',
                '--config', str(args.config), '--bundle-root', '/opt/node'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                preexec_fn=own_worker)
            status = child.wait()
            child = None
            if status == 0 or stop.is_set():
                return 0
            print(json.dumps({'event': 'worker_exit', 'exit_code': status, 'restart_seconds': delay}), flush=True)
            if time.monotonic() - started > 120:
                delay = 5
        stop.wait(delay)
        delay = min(60, delay * 2)
    return 0


if __name__ == '__main__':
    sys.exit(main())
