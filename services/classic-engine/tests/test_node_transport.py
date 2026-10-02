import hashlib
import json
from datetime import datetime, timedelta, timezone
from email.parser import BytesParser
from email.policy import default
import time

import httpx
import pytest
from classic_node.agent import Page
from classic_node.journal import Journal
from classic_node.protocol import ControlFailure, NodeFailure
from classic_node.transport import PREFIX, Transport


def config():
    return {'node_id': 'node-test', 'node_token': 'control-only-token',
            'control_url': 'https://control.example.test'}


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
