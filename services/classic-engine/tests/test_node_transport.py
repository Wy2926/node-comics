import hashlib
import json
from datetime import datetime, timedelta, timezone
from email.parser import BytesParser
from email.policy import default
import time

import httpx
import pytest
from classic_node.agent import Agent, Page
from classic_node.journal import Journal
from classic_node.protocol import ControlFailure, NodeFailure
from classic_node.transport import PREFIX, Transport


def config():
    return {'node_id': 'node-test', 'node_token': 'control-only-token',
            'control_url': 'https://control.example.test'}


@pytest.mark.parametrize('proxy', [None, 'http://user:secret@localhost:7890'])
def test_control_document_and_preflight_clients_use_native_proxy_options(monkeypatch, tmp_path, proxy):
    from types import SimpleNamespace
    from unittest.mock import Mock
    from classic_node.document_runner import DocumentRunner
    from classic_node.transport import control_client
    constructor = Mock()
    monkeypatch.setattr(httpx, 'Client', constructor)
    local = config() | {'proxy_url': proxy, 'state_dir': str(tmp_path)}
    node = Transport(local)
    documents = DocumentRunner(SimpleNamespace(local=local))
    try:
        control_client(local, timeout=15).close()
        center, objects, probe = [call.kwargs for call in constructor.call_args_list]
        for options in (center, objects, probe):
            assert options['trust_env'] is True and options['proxy'] == proxy
            assert options['follow_redirects'] is False and options.get('verify', True) is True
        assert center['headers']['Authorization'] == 'Bearer control-only-token'
        assert not objects.get('headers') and not probe['headers'] and probe['timeout'] == 15
    finally:
        node.close()
        documents.objects.close()
        documents.control.shutdown(wait=True)


def test_document_control_uses_v2_and_keeps_authorization_on_center():
    body = {'lease_token': 'lease-secret', 'workspace_generation': 2, 'error': 'LEASE_STOPPED'}
    def center(request):
        assert request.url.host == 'control.example.test'
        assert request.url.path == '/internal/documents/compute/v2/leases/test/complete'
        assert request.headers['authorization'] == 'Bearer control-only-token'
        assert json.loads(request.content) == body
        return httpx.Response(200, json={'status': 'terminal'})
    client = Transport(config(), control_transport=httpx.MockTransport(center))
    try:
        assert client.document_post('/leases/test/complete', body) == {'status': 'terminal'}
    finally:
        client.close()


def metadata(data=b'image', path=PREFIX + '/leases/test/input'):
    return {'path': path, 'byte_size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def test_input_uses_center_node_and_current_lease_credentials():
    observed = []
    def center(request):
        observed.append(request)
        assert request.url.host == 'control.example.test'
        assert request.headers['authorization'] == 'Bearer control-only-token'
        assert request.headers['x-node-id'] == 'node-test'
        assert request.headers['x-lease-token'] == 'lease-secret'
        assert request.url.path == PREFIX + '/leases/test/input' and request.method == 'GET'
        return httpx.Response(200, content=b'image')
    client = Transport(config(), control_transport=httpx.MockTransport(center))
    try:
        assert client.download('test', 'lease-secret', metadata()) == b'image'
        assert len(observed) == 1
    finally:
        client.close()


def input_page(data):
    now = datetime.now(timezone.utc)
    return Page({'lease_id': 'test', 'lease_token': 'lease-secret', 'status': 'active',
                 'expires_at': (now + timedelta(seconds=300)).isoformat(), 'input': metadata(data)},
                now.isoformat(), time.monotonic())


def input_agent(client):
    # Run the real per-page retry/download path without starting GPU or scheduler pools.
    agent = object.__new__(Agent)
    agent.transport = client
    return agent


def test_input_download_checks_cancellation_without_waiting_for_a_full_chunk():
    data = b'image'
    page, partial = input_page(data), bytearray()

    class Body(httpx.SyncByteStream):
        def __iter__(self):
            yield data[:1]
            page.stopped = True
            yield data[1:2]
            pytest.fail('Cancelled download continued reading')

    client = Transport(config(), control_transport=httpx.MockTransport(
        lambda _: httpx.Response(200, stream=Body())))
    try:
        with pytest.raises(NodeFailure, match='LEASE_STOPPED'):
            client.download('test', 'lease-secret', metadata(data), page.check, partial=partial)
        assert partial == data[:1]
    finally:
        client.close()


@pytest.mark.parametrize('outcome', ['range', 'ignored', 'truncated', 'slow', 'complete_then_error'])
def test_input_retry_preserves_partial_bytes_and_verifies_the_complete_image(monkeypatch, outcome):
    import classic_node.transport as transport
    data = bytes(range(256)) * 1024 + b'tail'
    offset = len(data) if outcome == 'complete_then_error' else 73
    observed, clock = [], [0.]
    monkeypatch.setattr(transport, 'monotonic', lambda: clock[0])

    class Body(httpx.SyncByteStream):
        def __iter__(self):
            if outcome == 'slow':
                clock[0] = 11.
            yield data[:offset]
            if outcome == 'truncated':
                return
            if outcome == 'slow':
                pytest.fail('Low-speed response was not interrupted')
            raise httpx.ReadError('private connection details')

    def center(request):
        observed.append(request)
        if len(observed) == 1:
            assert 'range' not in request.headers
            return httpx.Response(200, stream=Body())
        assert request.headers['range'] == f'bytes={offset}-'
        assert request.headers['if-range'] == f'"{metadata(data)["sha256"]}"'
        if len(observed) == 2:
            return httpx.Response(503)  # An outage must not erase the downloaded prefix.
        if outcome == 'ignored':
            return httpx.Response(200, content=data)
        return httpx.Response(206, headers={'Content-Range': f'bytes {offset}-{len(data) - 1}/{len(data)}'},
                              content=data[offset:])

    client = Transport(config(), control_transport=httpx.MockTransport(center))
    try:
        assert input_agent(client).input_bytes(input_page(data))[0] == data
        assert len(observed) == (1 if outcome == 'complete_then_error' else 3)
    finally:
        client.close()


@pytest.mark.parametrize('invalid', ['start', 'end', 'total', 'length', 'encoding', 'hash'])
def test_input_resume_rejects_inconsistent_ranges_and_corrupt_bytes(invalid):
    data = b'complete image'
    partial = bytearray(data[:3])
    size = len(data)
    headers = {'Content-Range': f'bytes 3-{size - 1}/{size}', 'Content-Length': str(size - 3)}
    headers.update({
        'start': {'Content-Range': f'bytes 2-{size - 1}/{size}'},
        'end': {'Content-Range': f'bytes 3-{size - 2}/{size}'},
        'total': {'Content-Range': f'bytes 3-{size - 1}/{size + 1}'},
        'length': {'Content-Length': str(size)},
        'encoding': {'Content-Encoding': 'gzip'},
        'hash': {},
    }[invalid])

    class Body(httpx.SyncByteStream):
        def __iter__(self):
            yield b'X' * (size - 3) if invalid == 'hash' else data[3:]

    client = Transport(config(), control_transport=httpx.MockTransport(
        lambda _: httpx.Response(206, headers=headers, stream=Body())))
    try:
        with pytest.raises(NodeFailure, match='INPUT_HASH_MISMATCH' if invalid == 'hash' else 'INPUT_INVALID'):
            client.download('test', 'lease-secret', metadata(data), partial=partial)
    finally:
        client.close()


def test_input_stalled_socket_times_out_and_resumes_without_changing_control_timeout(monkeypatch):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Event, Thread
    import classic_node.transport as transport

    monkeypatch.setattr(transport, 'INPUT_READ_SECONDS', .1)
    data = bytes(range(256)) * 1024 + b'tail'
    release, observed = Event(), []

    class Center(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_):
            pass

        def do_GET(self):
            observed.append(self.headers.get('Range'))
            first = len(observed) == 1
            self.send_response(200 if first else 206)
            self.send_header('Content-Length', str(len(data) if first else len(data) - 73))
            if not first:
                self.send_header('Content-Range', f'bytes 73-{len(data) - 1}/{len(data)}')
            self.end_headers()
            self.wfile.write(data[:73] if first else data[73:])
            self.wfile.flush()
            if first:
                release.wait(5)
                self.close_connection = True

    server = ThreadingHTTPServer(('127.0.0.1', 0), Center)
    thread = Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
    thread.start()
    client = Transport(config() | {'control_url': f'http://127.0.0.1:{server.server_port}'})
    before = client.control.timeout.as_dict()
    started = time.monotonic()
    try:
        assert input_agent(client).input_bytes(input_page(data))[0] == data
        assert observed == [None, 'bytes=73-']
        assert time.monotonic() - started < 3
        assert client.control.timeout.as_dict() == before
    finally:
        release.set()
        client.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize('path', ['http://control.example.test/input', 'https://other.example.test/input',
    '//other.example.test/input', PREFIX + '/leases/other/input', PREFIX + '/leases/test/input?token=private',
    PREFIX + '/leases/test/input#fragment', PREFIX + '/leases/test/../other/input'])
def test_exact_relative_lease_route_is_required_before_any_credentialed_request(path):
    client = Transport(config(), control_transport=httpx.MockTransport(lambda _: pytest.fail('unexpected request')))
    try:
        with pytest.raises(NodeFailure, match='INPUT_INVALID'):
            client.download('test', 'lease-secret', metadata(path=path))
    finally:
        client.close()


@pytest.mark.parametrize('response,code', [(httpx.Response(302, headers={'Location': 'https://evil.test'}), 'CONTROL_REJECTED'),
    (httpx.Response(404), 'CONTROL_REJECTED'), (httpx.Response(403), 'CONTROL_REJECTED'),
    (httpx.Response(409, json={'error': {'code': 'LEASE_EXPIRED'}}), 'LEASE_EXPIRED'),
    (httpx.Response(200, content=b'longer-than-declared'), 'INPUT_INVALID'),
    (httpx.Response(200, content=b'wrong'), 'INPUT_HASH_MISMATCH')])
def test_download_is_bounded_no_redirect_and_errors_are_redacted(response, code):
    client = Transport(config(), control_transport=httpx.MockTransport(lambda _: response))
    try:
        with pytest.raises(NodeFailure, match=code) as error:
            client.download('test', 'lease-secret', metadata())
        assert 'private' not in str(error.value)
    finally:
        client.close()


def test_journal_survives_reopen_freezes_binary_atomically_and_is_single_process(tmp_path):
    journal = Journal(tmp_path)
    pending = {'request_id': 'same-request', 'config_version': 1, 'count': 4}
    completion = {'completion': {'result': 'same-result'}}
    output = b'RIFF\x00\x01' * 100
    journal.put('claim', pending)
    journal.freeze('lease:test', completion, output)
    import sqlite3
    with pytest.raises(sqlite3.OperationalError):
        Journal(tmp_path)
    journal.close()
    journal = Journal(tmp_path)
    assert journal.get('claim') == pending
    assert journal.leases() == {'test': completion}
    assert journal.output('lease:test') == output
    assert journal.db.execute("SELECT typeof(data) FROM outputs").fetchone()[0] == 'blob'
    journal.remove('lease:test')
    assert journal.leases() == {} and journal.output('lease:test') is None
    journal.close()


def test_late_heartbeat_cannot_resurrect_local_deadline():
    now = datetime.now(timezone.utc)
    reply = {'status': 'active', 'expires_at': (now + timedelta(seconds=30)).isoformat()}
    page = Page(reply, now.isoformat(), time.monotonic())
    page.deadline = time.monotonic() - 1
    page.update(reply, now.isoformat(), time.monotonic())
    with pytest.raises(NodeFailure, match='LEASE_STOPPED'):
        page.check()


def test_binary_freeze_failure_rolls_back_completion_together_with_bytes(tmp_path):
    import sqlite3
    journal = Journal(tmp_path)
    original = {'lease': {'lease_id': 'test'}}
    journal.put('lease:test', original)
    journal.db.execute("""CREATE TRIGGER reject_output BEFORE INSERT ON outputs
        BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END""")
    try:
        with pytest.raises(sqlite3.IntegrityError, match='simulated write failure'):
            journal.freeze('lease:test', {'completion': {'result': 'new'}}, b'x' * 128 * 1024)
        assert journal.get('lease:test') == original
        assert journal.output('lease:test') is None
    finally:
        journal.close()


def test_acknowledged_output_reclaims_space_without_losing_pending_delivery(tmp_path):
    journal = Journal(tmp_path)
    completed = {'completion': {'result': 'acknowledged'}}
    pending = {'completion': {'result': 'awaiting-receipt'}}
    output = b'x' * (65 * 1024 * 1024)
    try:
        journal.freeze('lease:completed', completed, output)
        journal.freeze('lease:pending', pending, b'keep until acknowledged')
        expanded = (tmp_path / 'journal.sqlite3').stat().st_size
        journal.remove('lease:completed')
        assert (tmp_path / 'journal.sqlite3').stat().st_size < expanded // 2
        assert journal.leases() == {'pending': pending}
    finally:
        journal.close()
    journal = Journal(tmp_path)
    try:
        assert journal.leases() == {'pending': pending}
        assert journal.output('lease:pending') == b'keep until acknowledged'
    finally:
        journal.close()


def upload_fixture():
    data = b'webp result'
    info = {'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data), 'mime': 'image/webp'}
    body = {'lease_token': 'lease-secret', 'result': {'representation': 'overlay-v1', 'output': info}}
    return data, body


def multipart(request):
    message = BytesParser(policy=default).parsebytes(
        ('Content-Type: ' + request.headers['content-type'] + '\r\n\r\n').encode() + request.content)
    return {part.get_param('name', header='content-disposition'): part.get_payload(decode=True)
            for part in message.iter_parts()}


@pytest.mark.parametrize('representation', ['overlay-v1', 'overlay-tiles-v1', 'original'])
def test_one_multipart_result_uses_node_auth_and_binary_not_base64(representation):
    data, body = upload_fixture()
    if representation == 'overlay-tiles-v1':
        body['result']['representation'] = representation
        body['result']['output']['mime'] = 'application/vnd.nodelane.overlay-tiles'
    if representation == 'original':
        data = None
        body['result'] = {'representation': 'original', 'output': None, 'bbox': None}
    def center(request):
        assert request.method == 'PUT' and request.url.path == PREFIX + '/leases/test/result'
        assert request.headers['authorization'] == 'Bearer control-only-token'
        assert request.headers['x-node-id'] == 'node-test'
        parts = multipart(request)
        assert json.loads(parts['metadata']) == body
        assert parts.get('output') == data
        assert set(parts) == ({'metadata', 'output'} if data is not None else {'metadata'})
        return httpx.Response(200, json={'status': 'terminal'})
    client = Transport(config(), control_transport=httpx.MockTransport(center))
    try:
        assert client.deliver('test', body, data)['status'] == 'terminal'
    finally:
        client.close()


@pytest.mark.parametrize('change', ['length', 'sha256', 'mime', 'missing'])
def test_result_rejects_corrupt_frozen_bytes_before_network(change):
    data, body = upload_fixture()
    if change == 'missing':
        data = None
    else:
        body['result']['output'][{'length': 'byte_size'}.get(change, change)] = 1 if change == 'length' else 'wrong'
    client = Transport(config(), control_transport=httpx.MockTransport(lambda _: pytest.fail('unexpected PUT')))
    try:
        with pytest.raises(NodeFailure, match='INPUT_INVALID'):
            client.deliver('test', body, data)
    finally:
        client.close()


def test_input_download_is_bounded_by_center_descriptor_not_a_node_byte_limit():
    data = b'x' * (25 * 1024 * 1024)
    client = Transport(config(), control_transport=httpx.MockTransport(lambda _: httpx.Response(200, content=data)))
    try:
        assert client.download('test', 'lease-secret', metadata(data)) == data
        wrong = metadata(data)
        wrong['byte_size'] -= 1
        with pytest.raises(NodeFailure, match='INPUT_INVALID'):
            client.download('test', 'lease-secret', wrong)
    finally:
        client.close()


def test_result_transport_does_not_use_mask_byte_limit(monkeypatch):
    import classic_node.transport as transport
    import classic_node.protocol as protocol
    data, body = upload_fixture()
    monkeypatch.setattr(protocol, 'MAX_MASK_BYTES', 1)
    client = Transport(config(), control_transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json={'status': 'terminal'})))
    try:
        assert len(data) > protocol.MAX_MASK_BYTES
        assert client.deliver('test', body, data)['status'] == 'terminal'
        monkeypatch.setattr(transport, 'MAX_RESULT_BYTES', len(data) - 1)
        with pytest.raises(NodeFailure, match='INPUT_INVALID'):
            client.deliver('test', body, data)
    finally:
        client.close()


def test_lost_result_reply_replays_exact_metadata_and_bytes():
    data, body = upload_fixture()
    submissions = []
    def center(request):
        submissions.append(multipart(request))
        if len(submissions) == 1:
            raise httpx.ReadError('lost committed response')
        return httpx.Response(200, json={'status': 'terminal', 'completion_digest': 'stable'})
    client = Transport(config(), control_transport=httpx.MockTransport(center))
    try:
        with pytest.raises(ControlFailure, match='CONTROL_UNAVAILABLE'):
            client.deliver('test', body, data)
        assert client.deliver('test', body, data)['completion_digest'] == 'stable'
        assert submissions[0] == submissions[1]
    finally:
        client.close()
