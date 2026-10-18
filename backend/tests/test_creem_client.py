"""Failure diagnostics never contain provider payloads or change retry semantics."""
import httpx
import pytest


@pytest.fixture(autouse=True)
def creem_config(monkeypatch):
    from app.config import settings
    for key, value in {'CREEM_ENABLED': 'true', 'CREEM_ENVIRONMENT': 'test',
        'CREEM_API_KEY': 'creem_test_private_diagnostic_fixture',
        'CREEM_WEBHOOK_SECRET': 'creem_fixture_webhook',
        'CREEM_RETURN_URL': 'https://comics.example/account/'}.items():
        monkeypatch.setenv(key, value)
    settings.cache_clear()


@pytest.mark.parametrize('outcome,uncertain,failure', [
    (400, False, 'CREEM_UNAVAILABLE'),
    (408, True, 'CREEM_UNAVAILABLE'),
    (409, True, 'CREEM_UNAVAILABLE'),
    (429, True, 'CREEM_UNAVAILABLE'),
    (500, True, 'CREEM_UNAVAILABLE'),
    (502, True, 'CREEM_UNAVAILABLE'),
    (503, True, 'CREEM_UNAVAILABLE'),
    ('timeout', True, 'ReadTimeout'),
    ('connection', True, 'ConnectError'),
    ('non-json', True, 'JSONDecodeError'),
    ('non-object', False, 'CREEM_INVALID_RESPONSE'),
])
def test_checkout_failure_has_safe_diagnostic(monkeypatch, caplog, outcome, uncertain, failure):
    from app import creem_client as creem
    from app.billing_providers import BillingError
    intent = '11111111-2222-4333-8444-555555555555'
    private = 'private-email@example.test https://example.test/?signature=private-token'
    calls = []

    def transport(method, url, **kwargs):
        calls.append((method, url))
        assert kwargs['headers']['x-api-key'] == 'creem_test_private_diagnostic_fixture'
        if outcome == 'timeout':
            raise httpx.ReadTimeout(private)
        if outcome == 'connection':
            raise httpx.ConnectError(private)
        if outcome == 'non-object':
            return httpx.Response(200, json=[private])
        return httpx.Response(outcome if isinstance(outcome, int) else 200, text=private)

    monkeypatch.setattr(httpx, 'request', transport)
    with pytest.raises(BillingError) as error:
        creem.call('POST', '/checkouts', body={'request_id': intent, 'customer': private})
    assert len(calls) == 1
    assert error.value.code == ('CREEM_INVALID_RESPONSE' if outcome == 'non-object' else 'CREEM_UNAVAILABLE')
    assert error.value.uncertain is uncertain
    records = [record for record in caplog.records if record.name == 'app.creem_client']
    assert len(records) == 1 and records[0].exc_info is None
    status = outcome if isinstance(outcome, int) else None if outcome in ('timeout', 'connection') else 200
    assert records[0].getMessage() == (
        f'Creem checkout creation failed intent={intent} http_status={status} failure={failure}')
    assert private not in caplog.text and 'creem_test_private_diagnostic_fixture' not in caplog.text


@pytest.mark.parametrize('intent', [None, 123, {}, 'customer@example.test\nforged log', 'x' * 10000],
    ids=['missing', 'number', 'object', 'injection', 'oversize'])
def test_checkout_diagnostic_only_accepts_local_uuid(monkeypatch, caplog, intent):
    from app import creem_client as creem
    from app.billing_providers import BillingError
    monkeypatch.setattr(httpx, 'request', lambda *args, **kwargs: httpx.Response(503))
    with pytest.raises(BillingError):
        creem.call('POST', '/checkouts', body={'request_id': intent})
    records = [record for record in caplog.records if record.name == 'app.creem_client']
    assert len(records) == 1
    assert records[0].getMessage() == (
        'Creem checkout creation failed intent=None http_status=503 failure=CREEM_UNAVAILABLE')


def test_successful_checkout_does_not_log_payload(monkeypatch, caplog):
    from app import creem_client as creem
    result = {'id': 'ch_fixture', 'checkout_url': 'private-checkout-url'}
    monkeypatch.setattr(httpx, 'request', lambda *args, **kwargs: httpx.Response(200, json=result))
    assert creem.call('POST', '/checkouts', body={'request_id': 'private-value'}) == result
    assert not [record for record in caplog.records if record.name == 'app.creem_client']
