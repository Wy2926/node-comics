"""Run only a local image engine and agent against a remote HTTPS control plane.

Connection credentials live in the private node JSON. Child processes receive an
explicit environment allowlist, never database, R2, or text-provider credentials.
Create node.stop in the runtime directory to drain the agent and stop the engine.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--agent-process', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    folder = args.directory.resolve()
    stop = folder / 'node.stop'
    if args.agent_process:
        sys.path.insert(0, str(ROOT / 'services/compute-agent'))
        from agent import Agent, Config
        agent = Agent(Config.environment())

        def watch():
            while not agent.stop.wait(.5):
                if stop.exists():
                    agent.stop.set()

        threading.Thread(target=watch, daemon=True).start()
        agent.run()
        return

    config = json.loads((folder / 'node.json').read_text(encoding='utf-8'))
    if urlsplit(config['control_url']).scheme != 'https':
        raise ValueError('Remote control must use HTTPS')
    local = urlsplit(config['engine_url'])
    if local.scheme != 'http' or local.hostname != '127.0.0.1' or not local.port:
        raise ValueError('Engine URL must use http://127.0.0.1 with an explicit port')
    engine_python = ROOT / 'services/classic-engine/.venv/Scripts/python.exe'
    agent_python = ROOT / 'backend/.venv/Scripts/python.exe'
    if not engine_python.is_file() or not agent_python.is_file():
        raise RuntimeError('Prepare the existing local CUDA and backend environments first')
    import socket
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', local.port))
    allowed = {'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA',
               'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'COMSPEC', 'PATHEXT'}
    environment = {k: v for k, v in os.environ.items() if k.upper() in allowed}
    environment.update(PYTHONUNBUFFERED='1', PYTHONIOENCODING='utf-8')
    engine_environment = {**environment,
        'PYTHONPATH': os.pathsep.join([str(ROOT / 'services/classic-engine'), str(ROOT / 'engines/mit-native')]),
        'ENGINE_CONFIG_FILE': str(folder / 'engine.json'), 'ENGINE_TOKEN': config['engine_token'],
        'ENGINE_STOP_FILE': str(folder / 'engine.stop')}
    agent_environment = {**environment, 'NODE_CONFIG_FILE': str(folder / 'node.json')}
    stop.unlink(missing_ok=True)
    (folder / 'engine.stop').unlink(missing_ok=True)
    children, logs = [], []
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

    def launch(name, executable, arguments, env):
        log = (folder / (name + '.log')).open('a', encoding='utf-8')
        logs.append(log)
        child = subprocess.Popen([str(executable), *map(str, arguments)], cwd=folder,
            env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        children.append(child)
        return child

    try:
        engine = launch('engine', engine_python,
            [ROOT / 'scripts/run_local_node.py', '--engine-process', '--engine-port', local.port], engine_environment)
        import httpx
        deadline = time.monotonic() + 240
        with httpx.Client(trust_env=False, timeout=3) as client:
            while not stop.exists():
                if engine.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Engine did not become ready; inspect the private engine log')
                try:
                    health = client.get(config['engine_url'] + '/health').raise_for_status().json()
                    if health.get('ready'):
                        break
                except (httpx.HTTPError, ValueError):
                    pass
                time.sleep(1)
        if stop.exists():
            return
        agent = launch('agent', agent_python,
            [Path(__file__).resolve(), '--directory', folder, '--agent-process'], agent_environment)
        (folder / 'processes.json').write_text(json.dumps(
            {'supervisor': os.getpid(), 'engine': engine.pid, 'agent': agent.pid}, indent=2), encoding='utf-8')
        print('Local image engine and remote compute agent started', flush=True)
        while not stop.exists():
            if any(child.poll() is not None for child in children):
                raise RuntimeError('A node process exited; inspect the private runtime logs')
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        stop.touch()
        # Stop claiming first; keep the engine alive while the agent drains.
        if 'agent' in locals():
            try:
                agent.wait(timeout=960)
            except subprocess.TimeoutExpired:
                agent.terminate()
        (folder / 'engine.stop').touch()
        for child in reversed(children):
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.terminate()
                child.wait(timeout=10)
        for log in logs:
            log.close()
        (folder / 'processes.json').unlink(missing_ok=True)


if __name__ == '__main__':
    main()
