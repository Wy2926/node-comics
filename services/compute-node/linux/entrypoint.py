"""Start a credential-free image using per-instance identity or a mounted config."""
import json
import logging
import os
from pathlib import Path
import re
import sys
import tempfile

IDENTITY = {'NODE_CONTROL_URL': 'control_url', 'NODE_ID': 'node_id',
            'NODE_TOKEN': 'node_token', 'NODE_RESOURCE_ID': 'resource_id'}


def prepare_config(directory, environ):
    from classic_node.config import load, origin
    path = Path(directory) / 'node.json'
    supplied = {field: environ.get(env, '').strip() for env, field in IDENTITY.items()}
    if supplied['control_url']:
        supplied['control_url'] = origin(supplied['control_url'])
    if path.is_file():
        existing = load(path)
        # Never silently reuse recovery state for a different node/center/resource.
        for env, field in IDENTITY.items():
            if supplied[field] and supplied[field] != existing[field]:
                raise ValueError('Existing identity differs: ' + env)
        return path
    for env, field in IDENTITY.items():
        value = supplied[field]
        if not value or value.startswith('REPLACE_') or any(char.isspace() for char in value):
            raise ValueError('Set per-instance ' + env)
    supplied['control_url'] = origin(supplied['control_url'])
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,120}', supplied['resource_id']):
        raise ValueError('Invalid NODE_RESOURCE_ID')
    value = json.loads(Path(__file__).with_name('node.example.json').read_text())
    value.update(supplied)
    value['state_dir'] = str(Path(directory) / 'state')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # A nonempty state directory without its identity requires operator recovery.
    state = Path(value['state_dir'])
    if state.exists() and any(state.iterdir()):
        raise ValueError('Existing state has no identity; restore its original config')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix='.node-', delete=False) as output:
            temporary = Path(output.name)
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        load(temporary)
        os.link(temporary, path)  # Atomic no-clobber publish; mode remains 0600.
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return path


def main():
    os.umask(0o077)
    args = sys.argv[1:]
    try:
        if not args:
            # Do not let the legacy NODE_TOKEN override hide an identity mismatch.
            supplied = dict(os.environ)
            os.environ.pop('NODE_TOKEN', None)
            path = prepare_config('/data', supplied)
            args = ['run', '--config', str(path), '--bundle-root', '/opt/node']
    except (OSError, ValueError, KeyError):
        # Neither a traceback nor exception text may disclose identity values.
        print('Node bootstrap failed: supply all four NODE_* identity fields, check /data permissions, '
              'and do not change identity on an existing state directory.', file=sys.stderr, flush=True)
        return 2
    from classic_node.__main__ import main as node_main
    from classic_node.operations import LOG
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    LOG.addHandler(handler)  # Existing node logs contain sanitized operational events only.
    sys.argv = ['classic_node', *args]
    try:
        return node_main()
    finally:
        LOG.removeHandler(handler)


if __name__ == '__main__':
    sys.exit(main())
