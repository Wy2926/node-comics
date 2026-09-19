import argparse
import json
import logging
import signal
from .config import load
from .runtime import Runtime
from .transport import Transport
from .journal import Journal
from .agent import Agent


def main():
    parser = argparse.ArgumentParser(description='NCNN/Vulkan whole-page compute v2 node')
    parser.add_argument('command', choices=['check', 'run'])
    parser.add_argument('--config', default='node.local.json')
    args = parser.parse_args()
    config = load(args.config)
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    logging.getLogger('httpx').setLevel(logging.WARNING)
    runtime = Runtime(config)
    try:
        runtime.warmup()
        if args.command == 'check':
            print(json.dumps({'protocol_version': 2, 'version': runtime.version,
                'languages': runtime.languages, 'ready': True, 'gpu': config['engine']['gpu']}))
            return
        transport = Transport(config)
        journal = Journal(config['state_dir'], config['journal_bytes'])
        try:
            agent = Agent(config, runtime, transport, journal)
            for name in (signal.SIGINT, signal.SIGTERM):
                signal.signal(name, lambda *_: agent.stop.set())
            agent.run()
        finally:
            transport.close()
            journal.close()
    finally:
        runtime.close()


if __name__ == '__main__':
    main()
