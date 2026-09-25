import argparse
from contextlib import ExitStack
import json
import logging
from pathlib import Path
import signal
import sys
from threading import Event

from .config import load
from .operations import LOG, Operations, configure_logging, report_fatal


def main():
    parser = argparse.ArgumentParser(description='NCNN/Vulkan whole-page compute v2 node')
    parser.add_argument('command', choices=['check', 'run', 'pending'])
    parser.add_argument('--config', default='node.local.json')
    parser.add_argument('--bundle-root')
    args = parser.parse_args()
    try:
        return execute(args)
    except Exception as error:
        # Config/ownership failures happen before the normal state log exists.
        # The config directory is known even when its contents are unreadable.
        handler = configure_logging(Path(args.config).resolve().parent / 'startup-logs')
        try:
            report_fatal(error)
        finally:
            LOG.removeHandler(handler)
            handler.close()
        return 1


def execute(args):
    config = load(args.config)
    if getattr(args, 'bundle_root', None):
        root = Path(args.bundle_root).resolve()
        manifest = json.loads((root / 'release.json').read_text(encoding='utf-8'))
        fonts = [(root / name).resolve() for name in manifest['fonts']]
        if not fonts or any(not font.is_relative_to(root / 'fonts') for font in fonts):
            raise ValueError('Invalid release font paths')
        config['engine']['models'] = str(root / 'models')
        config['engine']['font'] = list(map(str, fonts))
    if args.command == 'pending':
        from .journal import Journal
        journal = Journal(config['state_dir'], config['journal_bytes'])
        try:
            return 1 if journal.leases() or journal.get('claim') else 0
        finally:
            journal.close()
    # Delay heavy imports so environment/dependency failures reach the log.
    if args.command == 'check':
        from .runtime import Runtime
        runtime = Runtime(config)
        try:
            runtime.warmup()
            print(json.dumps({'protocol_version': 2, 'version': runtime.version,
                'languages': runtime.languages, 'ready': True, 'gpu': config['engine']['gpu'],
                'inpainting_backend': runtime.engine.inpainter.backend}))
        finally:
            runtime.close()
        return 0

    directory = Path(config['state_dir'])
    directory.mkdir(parents=True, exist_ok=True)
    if (directory / 'stop').exists():
        return 0  # Operator stop persists across OS recovery triggers.
    from .journal import Journal
    # Own the state BEFORE loading GPU models or opening the rotating log.
    with ExitStack() as resources:
        journal = Journal(directory, config['journal_bytes'])
        resources.callback(journal.close)
        handler = configure_logging(directory / 'logs')
        resources.callback(handler.close)
        resources.callback(LOG.removeHandler, handler)
        logging.getLogger('httpx').setLevel(logging.WARNING)
        stop = Event()
        operations = Operations(directory, stop)
        for name in (signal.SIGINT, signal.SIGTERM):
            signal.signal(name, lambda *_: stop.set())
        operations.start()
        failed = True
        try:
            LOG.info('event=starting python=%s', sys.version.split()[0])
            from .runtime import Runtime
            from .transport import Transport
            from .agent import Agent
            with ExitStack() as runtime_resources:
                runtime = Runtime(config)
                runtime_resources.callback(runtime.close)
                runtime_resources.callback(operations.stopping)
                LOG.info('event=models_loaded engine_version=%s', runtime.version)
                runtime.warmup()
                LOG.info('event=warmup_complete')
                if not stop.is_set():
                    transport = Transport(config)
                    runtime_resources.callback(transport.close)
                    agent = Agent(config, runtime, transport, journal, stop=stop, operations=operations)
                    operations.attach(agent)
                    agent.run()
            failed = False
            LOG.info('event=stopped')
            return 0
        except Exception as error:
            report_fatal(error)
            return 1
        finally:
            operations.close(failed)


if __name__ == '__main__':
    sys.exit(main())
