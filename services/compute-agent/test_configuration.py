"""Concurrent stage draining and polling must not interrupt current output."""
import json
import threading
from unittest.mock import patch
import httpx
from agent import Agent, Config


def document(version=1, slots=2):
    return {'node_id': 'test-node', 'version': version, 'enabled': True, 'config': {
        'schema_version': 1, 'execution_slots': slots, 'poll_seconds': .01,
        'heartbeat_seconds': .1, 'config_poll_seconds': .02, 'request_seconds': 1,
        'stage_seconds': 10, 'input_cache_bytes': 1024, 'input_cache_ttl_seconds': 10, 'engine': {}}}


def test_live_update_waits_for_all_current_slots_and_keeps_polling():
    active, applied = [], []
    desired = [document()]
    gate, started, fetched, done = [threading.Event() for _ in range(4)]
    guard = threading.Lock()
    runtime = {'languages': ['en'], 'torch_threads': 4}
    def route(request):
        path = request.url.path
        if path == '/health':
            return httpx.Response(200, json={'ready': True, 'instance_id': 'instance', 'version': 'v1', 'device': 'cpu',
                'resource_id': 'test:cpu', 'capabilities': ['analyze', 'inpaint', 'render'], 'runtime': runtime})
        if path == '/internal/config':
            with guard:
                assert not active
                applied.append(desired[0]['version'])
            return httpx.Response(200, json={'runtime': runtime, 'supported_languages': ['en']})
        if path.endswith('/applied'):
            return httpx.Response(200, json={'accepted': True})
        if desired[0]['version'] == 2:
            fetched.set()
        return httpx.Response(200, json=desired[0])
    agent = Agent(Config('https://control.example', 'token', 'test-node', 'http://engine', 'engine-token',
                         poll_seconds=.01), transport=httpx.MockTransport(route))
    def work():
        with guard:
            active.append(threading.get_ident())
            if len(active) == 2:
                started.set()
        try:
            if agent.applied_version == 1:
                assert gate.wait(3)
            else:
                assert len(active) == 1
                done.set()
                agent.stop.set()
        finally:
            with guard:
                active.remove(threading.get_ident())
        return True
    agent.run_once = work
    thread = threading.Thread(target=agent.run, daemon=True)
    thread.start()
    try:
        assert started.wait(3)
        desired[0] = document(2, 1)
        assert fetched.wait(3)
        assert applied == [1]
        gate.set()
        assert done.wait(3)
        assert applied == [1, 2]
    finally:
        gate.set(); agent.stop.set(); thread.join(3)
    assert not thread.is_alive()


def test_bootstrap_file_contains_distinct_node_identity(tmp_path):
    path = tmp_path / 'node.json'
    path.write_text(json.dumps({'schema_version': 1, 'control_url': 'https://control.example',
        'node_id': 'node-unique', 'node_token': 'private-node-secret', 'engine_url': 'http://engine',
        'engine_token': 'different-local-secret', 'allow_http': False}), encoding='utf-8')
    with patch.dict('os.environ', {'NODE_CONFIG_FILE': str(path)}):
        config = Config.environment()
    assert config.node_id == 'node-unique' and config.token != config.engine_token
