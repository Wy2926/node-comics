"""No network: a sandbox acceptance command must not duplicate uncertain writes."""
import importlib.util
import json
from pathlib import Path

import httpx
import pytest


@pytest.fixture
def acceptance(tmp_path, monkeypatch):
    path = Path(__file__).resolve().parents[2] / 'scripts/creem_sandbox_acceptance.py'
    spec = importlib.util.spec_from_file_location('isolated_creem_acceptance', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, 'PRIVATE', tmp_path)
    monkeypatch.setattr(module, 'ROOT', tmp_path)
    monkeypatch.setattr(module, 'dotenv_values', lambda _: {'CREEM_API_KEY': 'creem_test_synthetic'})
    return module


def test_live_key_cannot_reach_transport(acceptance, monkeypatch):
    monkeypatch.setattr(acceptance, 'dotenv_values', lambda _: {'CREEM_API_KEY': 'creem_live_synthetic'})
    monkeypatch.setattr(acceptance.httpx, 'request', lambda *a, **k: pytest.fail('Live-key dispatch forbidden'))
    with pytest.raises(RuntimeError, match='live keys are forbidden'):
        acceptance.remote('GET', '/products/search')


def test_unknown_post_keeps_dispatch_receipt_and_never_repeats(acceptance, monkeypatch):
    calls = []
    def timeout(method, url, **kwargs):
        calls.append(url)
        journal = json.loads((acceptance.PRIVATE / 'operations/test-write.json').read_text())
        assert journal['status'] == 'dispatched'
        raise httpx.ReadTimeout('synthetic lost response')
    monkeypatch.setattr(acceptance.httpx, 'request', timeout)
    with pytest.raises(RuntimeError, match='outcome unknown'):
        acceptance.remote('POST', '/refunds', body={'transaction_id': 'tran_fixture'}, operation='test-write')
    with pytest.raises(RuntimeError, match='Previous dispatch'):
        acceptance.remote('POST', '/refunds', body={'transaction_id': 'tran_fixture'}, operation='test-write')
    assert calls == ['https://test-api.creem.io/v1/refunds']


def test_received_post_replays_only_identical_body(acceptance, monkeypatch):
    calls = []
    def received(method, url, **kwargs):
        calls.append(url)
        assert kwargs['follow_redirects'] is False
        return httpx.Response(200, json={'status': 'succeeded'})
    monkeypatch.setattr(acceptance.httpx, 'request', received)
    body = {'transaction_id': 'tran_fixture'}
    expected = acceptance.remote('POST', '/refunds', body=body, operation='test-write')
    assert acceptance.remote('POST', '/refunds', body=body, operation='test-write') == expected
    with pytest.raises(RuntimeError, match='body changed'):
        acceptance.remote('POST', '/refunds', body={'transaction_id': 'tran_other'}, operation='test-write')
    assert len(calls) == 1


def test_rejected_post_retains_private_diagnostic_without_automatic_retry(acceptance, monkeypatch):
    calls = []
    def rejected(method, url, **kwargs):
        calls.append(url)
        return httpx.Response(400, json={'message': 'synthetic private reason'})
    monkeypatch.setattr(acceptance.httpx, 'request', rejected)
    with pytest.raises(RuntimeError, match='HTTP 400; response omitted') as error:
        acceptance.remote('POST', '/refunds', body={}, operation='test-write')
    assert 'private reason' not in str(error.value)
    journal = json.loads((acceptance.PRIVATE / 'operations/test-write.json').read_text())
    assert journal['http_status'] == 400 and 'private reason' in journal['private_response']
    with pytest.raises(RuntimeError, match='Previous dispatch'):
        acceptance.remote('POST', '/refunds', body={}, operation='test-write')
    assert len(calls) == 1


def test_non_test_resource_response_fails_closed(acceptance, monkeypatch):
    monkeypatch.setattr(acceptance.httpx, 'request', lambda *a, **k: httpx.Response(200, json={'mode': 'prod'}))
    with pytest.raises(RuntimeError, match='non-test resource'):
        acceptance.remote('GET', '/products/prod_fixture')


@pytest.mark.parametrize('path', ['https://api.creem.io/v1/products', '/https://api.creem.io/v1/products'])
def test_remote_url_cannot_override_test_host(acceptance, monkeypatch, path):
    monkeypatch.setattr(acceptance.httpx, 'request', lambda *a, **k: pytest.fail('Unapproved host dispatch'))
    with pytest.raises(RuntimeError, match='Invalid test API path'):
        acceptance.remote('GET', path)
