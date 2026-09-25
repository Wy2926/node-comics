from datetime import datetime
import json
from pathlib import Path
from threading import Event, Thread
import time
from types import SimpleNamespace

import httpx
import pytest

from classic_node.agent import Agent
from classic_node.journal import Journal
from classic_node.operations import LOG, NetworkLog, Operations, configure_logging, report_fatal
from classic_node.protocol import ControlFailure
from classic_node.transport import Transport


def make_agent(tmp_path, handler):
    config = {'node_id': 'node-test', 'node_token': 'private-token',
              'control_url': 'https://control.example.test', 'r2_origin': 'https://r2.example.test',
              'resource_id': 'test:cpu', 'engine': {'gpu': -1}, 'local_pages': 1, 'max_leases': 1}
    transport = Transport(config, control_transport=httpx.MockTransport(handler))
    journal = Journal(tmp_path, 64 * 1024 * 1024)
    agent = Agent(config, SimpleNamespace(version='test-v2', languages=['en']), transport, journal)
    return agent, transport, journal


def registration():
    return {'protocol_version': 2, 'leases': [], 'server_time': '2026-01-01T00:00:00Z',
            'config': {'version': 1, 'request_seconds': 30, 'execution_slots': 1, 'enabled': True,
                       'heartbeat_seconds': 10, 'poll_seconds': 20}}


def test_process_survives_registration_outage_then_registers(tmp_path):
    attempts = []
    def handler(request):
        attempts.append(request.url.path)
        if len(attempts) == 1:
            raise httpx.ConnectError('private-token?signature=secret', request=request)
        return httpx.Response(200, json=registration())
    agent, transport, journal = make_agent(tmp_path, handler)
    # Interrupt the loop only after registration has actually succeeded.
    agent.poll_control = agent.stop.set
    try:
        agent.run()
        assert len(attempts) == 2
        assert agent.heartbeat_at and agent.config['version'] == 1
    finally:
        agent.close()
        transport.close()
        journal.close()


def test_startup_stop_during_outage_does_not_enter_unconfigured_loop(tmp_path):
    def handler(request):
        agent.stop.set()
        raise httpx.ConnectError('unavailable', request=request)
    agent, transport, journal = make_agent(tmp_path, handler)
    try:
        agent.run()
        assert agent.config is None
    finally:
        transport.close()
        journal.close()


def test_network_outage_does_not_refresh_heartbeat_and_same_agent_recovers(tmp_path):
    unavailable = False
    def handler(request):
        if unavailable:
            return httpx.Response(503, text='private upstream message')
        return httpx.Response(200, json=registration())
    agent, transport, journal = make_agent(tmp_path, handler)
    try:
        agent.register()
        before = agent.heartbeat_at = '2020-01-01T00:00:00Z'
        unavailable = True
        with pytest.raises(ControlFailure):
            agent.heartbeat()
        assert agent.heartbeat_at == before
        unavailable = False
        agent.heartbeat()
        assert agent.heartbeat_at != before
        assert agent.config['version'] == 1
    finally:
        agent.close()
        transport.close()
        journal.close()


def test_running_loop_retries_heartbeat_after_outage_without_restart(tmp_path):
    failed = Event()
    recovered = Event()
    def handler(request):
        reply = registration()
        reply['config'].update(heartbeat_seconds=.03, poll_seconds=.03)
        if request.url.path.endswith('/heartbeat'):
            if not failed.is_set():
                failed.set()
                return httpx.Response(503)
            recovered.set()
            agent.stop.set()
        elif request.url.path.endswith('/updates'):
            # Bound this fixture's otherwise immediate long poll.
            time.sleep(.02)
            return httpx.Response(200, json={'revision': 1})
        elif request.url.path.endswith('/claim'):
            reply['request_id'] = json.loads(request.content)['request_id']
        return httpx.Response(200, json=reply)
    agent, transport, journal = make_agent(tmp_path, handler)
    worker = Thread(target=agent.run)
    try:
        worker.start()
        assert recovered.wait(5)
        worker.join(5)
        assert not worker.is_alive() and failed.is_set()
        assert agent.heartbeat_at and not agent.pages
    finally:
        agent.stop.set()
        worker.join(5)
        transport.close()
        journal.close()


def test_log_records_status_and_exception_type_without_payload(tmp_path):
    handler = configure_logging(tmp_path)
    try:
        events = NetworkLog()
        error = ControlFailure('CONTROL_REJECTED', 403)
        events.failed('updates', error)
        events.failed('updates', error)
        events.succeeded('updates')
        try:
            raise ValueError('private-token https://r2.example.test/?signature=secret OCR text')
        except ValueError as error:
            report_fatal(error)
        output = (tmp_path / 'node.log').read_text(encoding='utf-8')
        assert output.count('event=connection_failed') == 1
        assert 'http_status=403' in output and 'failed_attempts=2' in output
        assert 'type=ValueError' in output and 'test_node_operations.py:' in output
        assert 'private-token' not in output and 'signature=' not in output and 'OCR text' not in output
        datetime.strptime(output.splitlines()[0].split()[0], '%Y-%m-%dT%H:%M:%SZ')
    finally:
        LOG.removeHandler(handler)
        handler.close()


def test_logs_rotate_with_bounded_backups(tmp_path):
    handler = configure_logging(tmp_path)
    handler.maxBytes, handler.backupCount = 180, 2
    try:
        for _ in range(30):
            LOG.info('event=heartbeat config_version=1 active_leases=0')
        assert {p.name for p in tmp_path.iterdir()} == {'node.log', 'node.log.1', 'node.log.2'}
        assert sum(p.stat().st_size for p in tmp_path.iterdir()) < 3 * 180
    finally:
        LOG.removeHandler(handler)
        handler.close()


def test_transport_retains_only_safe_network_error_type(tmp_path):
    def handler(request):
        raise httpx.ConnectError('private-token signed URL', request=request)
    agent, transport, journal = make_agent(tmp_path, handler)
    try:
        with pytest.raises(ControlFailure) as error:
            transport.post('/nodes/register', {})
        assert error.value.cause == 'ConnectError'
        assert str(error.value) == 'CONTROL_UNAVAILABLE'
    finally:
        agent.close()
        transport.close()
        journal.close()


def test_watchdog_distinguishes_outage_stall_and_operator_stop(tmp_path):
    exits = []
    operations = Operations(tmp_path, Event(), hard_exit=exits.append)
    operations.agent = SimpleNamespace(heartbeat_at=None, heartbeat_monotonic=0, pages={}, config=None)
    operations.phase = 'running'
    operations.check()
    operations.write()
    assert not exits
    assert not json.loads((tmp_path / 'status.json').read_text())['connected']
    operations.last_pulse = time.monotonic() - 121
    operations.check()
    assert exits == [1]
    operations.pulse()
    (tmp_path / 'stop').touch()
    operations.check()
    assert operations.stop.is_set() and operations.phase == 'stopping'
    operations.stopping_at = time.monotonic() - 61
    operations.check()
    assert exits == [1, 1]


def test_status_publish_retries_windows_reader_sharing_violation(tmp_path, monkeypatch):
    operations = Operations(tmp_path, Event())
    replace = Path.replace
    attempts = []
    def temporarily_locked(path, target):
        attempts.append(target)
        if len(attempts) < 3:
            raise PermissionError('reader is still closing')
        return replace(path, target)
    monkeypatch.setattr(Path, 'replace', temporarily_locked)
    operations.write()
    assert len(attempts) == 3
    assert json.loads((tmp_path / 'status.json').read_text())['phase'] == 'starting'


def test_single_owner_prevents_second_runtime_before_model_loading(tmp_path, monkeypatch):
    from classic_node import __main__ as cli
    import sys
    journal = Journal(tmp_path, 64 * 1024 * 1024)
    monkeypatch.setattr(cli, 'load', lambda _: {'state_dir': str(tmp_path), 'journal_bytes': 64 * 1024 * 1024})
    monkeypatch.setattr(sys, 'argv', ['classic_node', 'run', '--config', str(tmp_path / 'node.json')])
    try:
        assert cli.main() == 1
        assert not (tmp_path / 'logs').exists()
    finally:
        journal.close()


def test_persistent_operator_stop_prevents_restart(tmp_path, monkeypatch):
    from classic_node import __main__ as cli
    import sys
    (tmp_path / 'stop').touch()
    monkeypatch.setattr(cli, 'load', lambda _: {'state_dir': str(tmp_path)})
    monkeypatch.setattr(sys, 'argv', ['classic_node', 'run'])
    assert cli.main() == 0
    assert not (tmp_path / 'owner.sqlite3').exists()


def test_bundle_assets_resolve_independently_of_private_data(tmp_path, monkeypatch):
    from classic_node import __main__ as cli
    from classic_node import runtime
    bundle = tmp_path / '节点 程序'
    bundle.mkdir()
    (bundle / 'release.json').write_text(json.dumps({'fonts': ['fonts/font.otf']}))
    config = {'engine': {'models': 'old-machine/models', 'font': ['old-machine/font']}}
    monkeypatch.setattr(cli, 'load', lambda _: config)
    observed = {}
    class FakeRuntime:
        def __init__(self, value):
            observed.update(value['engine'])
            self.version, self.languages = 'fixture', ['en']
            self.engine = SimpleNamespace(inpainter=SimpleNamespace(backend='fixture'))
        def warmup(self):
            observed['warmup'] = True
        def close(self):
            observed['closed'] = True
    config['engine']['gpu'] = 0
    monkeypatch.setattr(runtime, 'Runtime', FakeRuntime)
    assert cli.execute(SimpleNamespace(command='check', config='elsewhere/node.json', bundle_root=bundle)) == 0
    assert observed['models'] == str(bundle / 'models')
    assert observed['font'] == [str(bundle / 'fonts/font.otf')]
    assert observed['warmup'] and observed['closed']
    (bundle / 'release.json').write_text(json.dumps({'fonts': ['../outside.otf']}))
    with pytest.raises(ValueError, match='Invalid release font paths'):
        cli.execute(SimpleNamespace(command='check', config='elsewhere/node.json', bundle_root=bundle))


@pytest.mark.parametrize('key,value', [('lease:1', {'phase': 'deliver'}), ('claim', {'request_id': 'unknown-reply'})])
def test_adoption_check_retains_pending_work(tmp_path, monkeypatch, key, value):
    from classic_node import __main__ as cli
    config = {'state_dir': str(tmp_path), 'journal_bytes': 64 * 1024 * 1024}
    monkeypatch.setattr(cli, 'load', lambda _: config)
    args = SimpleNamespace(command='pending', config='fixture')
    journal = Journal(tmp_path, config['journal_bytes'])
    journal.put(key, value)
    journal.close()
    assert cli.execute(args) == 1
    journal = Journal(tmp_path, config['journal_bytes'])
    assert journal.get(key) == value
    journal.remove(key)
    journal.close()
    assert cli.execute(args) == 0
