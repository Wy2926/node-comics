import hashlib
from datetime import datetime, timedelta, timezone
import time

import httpx
import pytest
from classic_node.agent import Page
from classic_node.journal import Journal
from classic_node.protocol import NodeFailure
from classic_node.transport import Transport


def config():
    return {'node_id': 'node-test', 'node_token': 'control-only-token',
            'control_url': 'https://control.example.test', 'r2_origin': 'https://r2.example.test'}


def metadata(data=b'image', url='https://r2.example.test/bucket/input?signature=private'):
    return {'url': url, 'byte_size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def test_r2_client_never_receives_control_credentials_or_cookies():
    observed = []
    def control(request):
        assert request.headers['authorization'] == 'Bearer control-only-token'
        return httpx.Response(200, json={}, headers={'Set-Cookie': 'secret=control; Domain=example.test'})
    def storage(request):
        observed.append(request)
        assert 'authorization' not in request.headers
        assert 'x-node-id' not in request.headers
        assert 'cookie' not in request.headers
        return httpx.Response(200, content=b'image')
    client = Transport(config(), control_transport=httpx.MockTransport(control), storage_transport=httpx.MockTransport(storage))
    try:
        client.post('/nodes/register', {})
        assert client.download(metadata()) == b'image'
        assert len(observed) == 1
    finally:
        client.close()


@pytest.mark.parametrize('url', ['http://r2.example.test/input', 'https://other.example.test/input',
    'https://r2.example.test.evil.test/input', 'https://user:pass@r2.example.test/input',
    'https://r2.example.test:444/input', 'https://r2.example.test/input#fragment'])
def test_exact_https_r2_origin_is_required(url):
    client = Transport(config(), storage_transport=httpx.MockTransport(lambda _: pytest.fail('unexpected request')))
    try:
        with pytest.raises(NodeFailure, match='STORAGE_AUTH_FAILED'):
            client.download(metadata(url=url))
    finally:
        client.close()


@pytest.mark.parametrize('response,code', [(httpx.Response(302, headers={'Location': 'https://evil.test'}), 'INPUT_INVALID'),
    (httpx.Response(404), 'INPUT_INVALID'), (httpx.Response(403), 'STORAGE_AUTH_FAILED'),
    (httpx.Response(200, content=b'longer-than-declared'), 'INPUT_INVALID'),
    (httpx.Response(200, content=b'wrong'), 'INPUT_HASH_MISMATCH')])
def test_download_is_bounded_no_redirect_and_errors_are_redacted(response, code):
    client = Transport(config(), storage_transport=httpx.MockTransport(lambda _: response))
    try:
        with pytest.raises(NodeFailure, match=code) as error:
            client.download(metadata())
        assert 'private' not in str(error.value)
    finally:
        client.close()


def test_journal_survives_reopen_and_is_single_process(tmp_path):
    journal = Journal(tmp_path, 64 * 1024 * 1024)
    pending = {'request_id': 'same-request', 'config_version': 1, 'count': 4}
    journal.put('claim', pending)
    journal.put('lease:test', {'completion': {'result': 'same-result'}})
    import sqlite3
    with pytest.raises(sqlite3.OperationalError):
        Journal(tmp_path, 64 * 1024 * 1024)
    journal.close()
    journal = Journal(tmp_path, 64 * 1024 * 1024)
    assert journal.get('claim') == pending
    assert journal.leases() == {'test': {'completion': {'result': 'same-result'}}}
    journal.remove('lease:test')
    assert journal.leases() == {}
    journal.close()


def test_late_heartbeat_cannot_resurrect_local_deadline():
    now = datetime.now(timezone.utc)
    reply = {'status': 'active', 'expires_at': (now + timedelta(seconds=30)).isoformat()}
    page = Page(reply, now.isoformat(), time.monotonic())
    page.deadline = time.monotonic() - 1
    page.update(reply, now.isoformat(), time.monotonic())
    with pytest.raises(NodeFailure, match='LEASE_STOPPED'):
        page.check()
