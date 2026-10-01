"""Synthetic GA4 transport tests: no Google requests, credentials, or real user data."""
import json
import importlib.util
import logging
from pathlib import Path
import re
import time
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
from pydantic import SecretStr
import pytest
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app import analytics, redis_state
from admission_test_utils import state_keys


URL = '/v1/analytics/events'
SECRET = 'isolated-ga4-secret-never-used-in-production'


def event(name='page_view', **params):
    return {'event_id': str(uuid4()), 'name': name, 'params': params, 'timestamp_micros': int(time.time() * 1_000_000)}


def batch(*events):
    return {'client_id': str(uuid4()), 'session_id': int(time.time()), 'events': list(events) or [event()]}


@pytest.fixture
def relay(monkeypatch):
    config = SimpleNamespace(app_env='development', ga4_enabled=True, ga4_debug_mode=False,
        ga4_extension_measurement_id='G-TEST123456', ga4_extension_api_secret=SecretStr(SECRET))
    monkeypatch.setattr(analytics, 'settings', lambda: config)
    monkeypatch.setattr(analytics, 'guard', analytics.RelayGuard())
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(204)

    monkeypatch.setattr(analytics, 'make_transport', lambda: httpx.MockTransport(respond))
    app = FastAPI()
    app.include_router(analytics.router)
    with TestClient(app) as client:
        yield client, requests, config


def test_forward_only_allowlisted_categories_and_synthetic_page(relay):
    client, requests, _ = relay
    body = batch(event(screen='reader', browser='firefox', extension_version='0.3.1', ui_language='zh-CN',
        page_location='https://private.example/comic?secret=private', page_title='Private comic title',
        user_id='private-user', email='private@example.com', session_id=123, source_type='website'),
        event('reading_summary', source_type='local', pages_viewed=2, active_ms=1234,
            engagement_time_msec=1234, progress_bucket=25, layout='private-layout'),
        event('import_result', outcome='failed', error_code='https://private.example/failure', stack='private stack',
            count=True, duration_ms=-1, success_count=1, failure_count=1, duplicate_count=1, cancelled_count=1))
    response = client.post(URL, json=body, headers={'User-Agent': 'PrivateUserAgent', 'Cookie': 'secret=private'})
    assert response.status_code == 204 and not response.content
    assert len(requests) == 1
    request = requests[0]
    assert str(request.url.copy_with(query=None)) == analytics.COLLECT_URL
    assert dict(request.url.params) == {'measurement_id': 'G-TEST123456', 'api_secret': SECRET}
    assert 'user-agent' not in request.headers and 'cookie' not in request.headers
    payload = json.loads(request.content)
    assert set(payload) == {'client_id', 'events', 'consent'}
    assert payload['consent'] == {'ad_user_data': 'DENIED', 'ad_personalization': 'DENIED'}
    assert re.fullmatch(r'\d{1,10}\.\d{1,10}', payload['client_id'])
    assert payload['client_id'] != body['client_id']
    same_batch = analytics.EventBatch.model_validate(body)
    assert payload['client_id'] == analytics.build_payload(same_batch, same_batch.events)['client_id']
    different_batch = analytics.EventBatch.model_validate(batch())
    assert payload['client_id'] != analytics.build_payload(different_batch, different_batch.events)['client_id']
    params = payload['events'][0]['params']
    assert params == {'screen': 'reader', 'browser': 'firefox', 'extension_version': '0.3.1', 'ui_language': 'zh-CN',
        'page_location': 'https://extension.nodelane.invalid/reader', 'page_title': 'NodeLane Extension - reader',
        'session_id': body['session_id']}
    assert payload['events'][1]['params'] == {'source_type': 'local', 'pages_viewed': 2, 'active_ms': 1234,
        'engagement_time_msec': 1234, 'session_id': body['session_id']}
    assert payload['events'][0]['timestamp_micros'] == body['events'][0]['timestamp_micros']
    assert payload['events'][1]['timestamp_micros'] == body['events'][1]['timestamp_micros']
    assert payload['events'][2]['params'] == {'outcome': 'failed', 'session_id': body['session_id']}
    assert 'private' not in request.content.decode().lower()


def test_purchase_refund_and_unused_or_unknown_events_are_never_relayed(relay):
    client, requests, _ = relay
    unsupported = ('purchase', 'refund', 'translation_result', 'feature_error', 'login', 'arbitrary')
    assert client.post(URL, json=batch(*(event(name) for name in unsupported))).status_code == 204
    assert requests == []
    assert client.post(URL, json=batch(event('purchase'), event('reader_open'))).status_code == 204
    assert [item['name'] for item in json.loads(requests[0].content)['events']] == ['reader_open']


@pytest.mark.parametrize('enabled,environment,expected', [
    (False, 'development', False), (True, 'development', True),
    (True, 'test', True), (True, 'production', False),
])
def test_debug_mode_is_added_only_by_enabled_development_server(relay, enabled, environment, expected):
    client, requests, config = relay
    config.ga4_debug_mode = enabled
    config.app_env = environment
    body = batch(event(screen='reader', debug_mode=True), event('reader_open', debug_mode=False))
    assert client.post(URL, json=body).status_code == 204
    payload = json.loads(requests[0].content)
    assert all(('debug_mode' in item['params']) is expected for item in payload['events'])
    if expected:
        assert all(item['params']['debug_mode'] is True for item in payload['events'])


@pytest.mark.parametrize('field,value', [
    ('ga4_enabled', False), ('ga4_extension_measurement_id', ''), ('ga4_extension_api_secret', SecretStr('')),
])
def test_disabled_or_incomplete_configuration_never_contacts_google(relay, field, value):
    client, requests, config = relay
    setattr(config, field, value)
    assert client.post(URL, json=batch()).status_code == 204
    assert requests == []


@pytest.mark.parametrize('mutate', [
    lambda body: body.update(client_id='private@example.com'),
    lambda body: body.update(client_id=42),
    lambda body: body.update(user_id='private-account'),
    lambda body: body.update(session_id=True),
    lambda body: body.update(session_id=int(time.time()) + 1000),
    lambda body: body.update(events=[]),
    lambda body: body.update(events=[event() for _ in range(21)]),
    lambda body: body['events'][0].update(event_id='private-path'),
    lambda body: body['events'][0].update(timestamp_micros=1.1),
    lambda body: body['events'][0].update(params=['private']),
    lambda body: body['events'][0].update(extra='private-input'),
])
def test_invalid_envelopes_are_rejected_without_echoing_private_input(relay, mutate):
    client, requests, _ = relay
    body = batch()
    mutate(body)
    response = client.post(URL, json=body)
    assert response.status_code == 422
    assert 'private' not in response.text
    assert requests == []


def test_request_body_size_and_content_type_are_bounded(relay):
    client, requests, _ = relay
    assert client.post(URL, json=batch(event(private='x' * analytics.MAX_BODY_BYTES))).status_code == 413
    # Missing Content-Length must not bypass the streaming size limit.
    assert client.post(URL, content=iter([b'x' * 9000, b'x' * 9000]), headers={'Content-Type': 'application/json'}).status_code == 413
    assert client.post(URL, content='{}', headers={'Content-Type': 'text/plain'}).status_code == 415
    assert client.post(URL, content='private malformed', headers={'Content-Type': 'application/json'}).status_code == 422
    assert requests == []


def test_stale_and_far_future_events_dropped_preserving_valid_event_time(relay):
    client, requests, _ = relay
    old = event('reader_open')
    old['timestamp_micros'] -= (analytics.MAX_AGE_SECONDS + 5) * 1_000_000
    future = event('reader_open')
    future['timestamp_micros'] += 600 * 1_000_000
    valid = event('reading_summary', active_ms=30000)
    valid['timestamp_micros'] -= 60 * 1_000_000
    assert client.post(URL, json=batch(old, future, valid)).status_code == 204
    payload = json.loads(requests[0].content)
    assert len(payload['events']) == 1
    assert payload['events'][0]['timestamp_micros'] == valid['timestamp_micros']


def test_replayed_and_duplicate_events_are_deduplicated_per_client(relay):
    client, requests, _ = relay
    item = event('reader_open')
    body = batch(item, item)
    for _ in range(2):
        assert client.post(URL, json=body).status_code == 204
    assert len(requests) == 1
    assert len(json.loads(requests[0].content)['events']) == 1
    body['client_id'] = str(uuid4())
    assert client.post(URL, json=body).status_code == 204
    assert len(requests) == 2


def test_client_request_limit_and_refill(relay, monkeypatch):
    client, requests, _ = relay
    now = time.time()
    monkeypatch.setattr(analytics.time, 'time', lambda: now)
    monkeypatch.setattr(redis_state, '_clock_ms', lambda: int(now * 1000))
    body = batch()
    for _ in range(30):
        assert client.post(URL, json=body).status_code == 204
    denied = client.post(URL, json=body)
    assert denied.status_code == 429 and denied.headers['Retry-After'] == '10'
    now += 60
    assert client.post(URL, json=body).status_code == 204
    assert len(requests) == 1


def test_proxy_ip_limit_cannot_be_bypassed_by_rotating_forwarded_headers_and_client_ids(relay, monkeypatch):
    client, requests, _ = relay
    now = time.time()
    monkeypatch.setattr(analytics.time, 'time', lambda: now)
    monkeypatch.setattr(redis_state, '_clock_ms', lambda: int(now * 1000))
    template = (Path(__file__).resolve().parents[2] / 'deploy/openresty.comics.conf').read_text(encoding='utf-8')
    assert 'include /www/node-comics/openresty.api.inc;' in template
    proxy_config = (Path(__file__).resolve().parents[2] / 'deploy/openresty.api.inc').read_text(encoding='utf-8')
    directive = re.search(r'^\s*proxy_set_header\s+X-Forwarded-For\s+(\S+)\s*;', proxy_config, re.M)
    assert directive, 'API proxy must explicitly set X-Forwarded-For'

    # Resolve the template's Nginx variable, then exercise the actual Uvicorn
    # trust policy and HTTP endpoint. Restoring the append behavior must fail.
    app = ProxyHeadersMiddleware(client.app, trusted_hosts='*')
    with TestClient(app, client=('172.30.0.1', 50000)) as proxy:
        def post(remote_addr, forged_address):
            variables = {
                '$remote_addr': remote_addr,
                '$proxy_add_x_forwarded_for': f'{forged_address}, {remote_addr}',
            }
            forwarded_for = variables[directive.group(1)]
            return proxy.post(URL, json=batch(), headers={'X-Forwarded-For': forwarded_for})

        for index in range(120):
            assert post('203.0.113.10', f'198.51.100.{index + 1}').status_code == 204
        denied = post('203.0.113.10', '198.51.100.121')
        assert denied.status_code == 429
        assert denied.headers['Retry-After'] == '10'
        assert post('203.0.113.11', '198.51.100.122').status_code == 204

    assert len(requests) == 121
    assert redis_state.client().zcard(redis_state.key('analytics-slots')) == 0
    assert '203.0.113.10' not in repr(state_keys('analytics-ip'))


def test_rate_limited_client_does_not_exhaust_other_clients_global_budget(monkeypatch):
    guard = analytics.RelayGuard()
    now = time.time()
    monkeypatch.setattr(redis_state, '_clock_ms', lambda: int(now * 1000))
    client_id = str(uuid4())
    for _ in range(15):
        body = batch(*[event('reader_open') for _ in range(20)])
        body['client_id'] = client_id
        request = analytics.EventBatch.model_validate(body)
        accepted, token = guard.admit(request, '203.0.113.10', now)
        assert accepted
        guard.release(token)

    # This client's event budget is exhausted, while the shared budget still
    # has capacity. Repeated rejected requests must preserve that capacity.
    for _ in range(15):
        with pytest.raises(HTTPException) as failure:
            guard.admit(request, '203.0.113.10', now)
        assert failure.value.status_code == 429

    other_client = analytics.EventBatch.model_validate(batch())
    accepted, token = guard.admit(other_client, '203.0.113.11', now)
    assert accepted
    guard.release(token)


def test_guard_cache_and_in_flight_capacity_are_bounded(monkeypatch):
    guard = analytics.RelayGuard()
    guard.max_seen = 3
    now = time.time()
    monkeypatch.setattr(redis_state, '_clock_ms', lambda: int(now * 1000))
    tokens = []
    for index in range(8):
        accepted, token = guard.admit(analytics.EventBatch.model_validate(batch()), str(index), now)
        assert accepted
        tokens.append(token)
    assert guard.admit(analytics.EventBatch.model_validate(batch()), 'next', now) == ([], None)
    assert redis_state.client().zcard(redis_state.key('analytics-seen')) == 3
    assert redis_state.client().zcard(redis_state.key('analytics-slots')) == 8
    assert all(0 < redis_state.client().pttl(key) <= 60000 for key in state_keys('analytics-ip'))
    for token in tokens:
        guard.release(token)
    assert redis_state.client().zcard(redis_state.key('analytics-slots')) == 0
    now += guard.dedupe_seconds + 1
    accepted, token = guard.admit(analytics.EventBatch.model_validate(batch()), 'after', now)
    assert accepted and redis_state.client().zcard(redis_state.key('analytics-seen')) == 1
    guard.release(token)


@pytest.mark.parametrize('failure', ['transport', 'timeout', 'status', 'success'])
def test_transport_outcomes_never_log_secret_query_or_private_payload(relay, monkeypatch, caplog, failure):
    client, _, _ = relay

    def respond(request):
        if failure == 'transport':
            raise httpx.ConnectError('private failure ' + str(request.url), request=request)
        if failure == 'timeout':
            raise TimeoutError('private failure ' + str(request.url))
        return httpx.Response(503 if failure == 'status' else 204, text='private upstream body ' + SECRET)

    monkeypatch.setattr(analytics, 'make_transport', lambda: httpx.MockTransport(respond))
    with caplog.at_level(logging.INFO):
        response = client.post(URL, json=batch(event('reader_open')))
    assert response.status_code == 204
    assert redis_state.client().zcard(redis_state.key('analytics-slots')) == 0
    assert SECRET not in caplog.text and 'api_secret' not in caplog.text and 'private' not in caplog.text
    assert SECRET not in response.text and not response.content


def test_router_is_mounted_in_backend_and_disabled_by_default(client, monkeypatch):
    monkeypatch.setenv('GA4_ENABLED', 'false')
    from app.config import settings
    settings.cache_clear()
    assert client.post(URL, json=batch()).status_code == 204


def test_extension_and_backend_event_contracts_match():
    """Read the actual client contract so adding an enum/event cannot silently lose telemetry."""
    source = (Path(__file__).resolve().parents[2] / 'apps/extension/src/analytics/schema.ts').read_text(encoding='utf-8')
    categories = re.search(r'export const parameterValues = \{(.*?)\} as const;', source, re.S)
    events = re.search(r'export const eventParameters = \{(.*?)\} as const', source, re.S)
    assert categories and events, 'Client contract structure changed; update the cross-language reader'
    quoted = lambda text: set(re.findall(r"'([^']+)'", text))
    lists = lambda text: dict(re.findall(r'(\w+)\s*:\s*\[([^\]]*)\]', text))
    actual_enums = {name: quoted(values) for name, values in lists(categories.group(1)).items()}
    assert actual_enums == analytics.ENUMS
    shared = {name: quoted(values) for name, values in re.findall(r'const (\w+)\s*=\s*\[([^\]]*)\] as const;', source)}
    actual_events = {}
    for name, fields in lists(events.group(1)).items():
        values = quoted(fields)
        for spread in re.findall(r'\.\.\.(\w+)', fields):
            assert spread in shared, 'Unknown shared client event fields: ' + spread
            values |= shared[spread]
        actual_events[name] = values
    assert actual_events == {name: fields | analytics.COMMON_PARAMS for name, fields in analytics.EVENT_PARAMS.items()}
    for client_name, backend_values in [('counters', analytics.COUNTS), ('durations', analytics.DURATIONS)]:
        declaration = re.search(r'const\s+' + client_name + r'\s*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]\s*\)', source)
        assert declaration and quoted(declaration.group(1)) == backend_values


def test_openapi_documents_bounded_anonymous_batch_without_dangling_refs(relay):
    client, _, _ = relay
    operation = client.get('/openapi.json').json()['paths'][URL]['post']
    assert operation['security'] == []
    schema = operation['requestBody']['content']['application/json']['schema']
    assert schema['additionalProperties'] is False
    assert schema['properties']['events']['maxItems'] == 20
    assert schema['properties']['events']['items']['properties']['event_id']['pattern'] == analytics.UUID_PATTERN
    assert '$ref' not in json.dumps(schema)
    assert set(operation['responses']) == {'204', '408', '413', '415', '422', '429'}


@pytest.fixture
def validation_tool():
    path = Path(__file__).resolve().parents[2] / 'scripts/validate_analytics.py'
    spec = importlib.util.spec_from_file_location('validate_analytics', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_real_validation_tool_uses_only_non_collecting_endpoint_and_all_current_events(validation_tool):
    def respond(request):
        assert request.url.scheme == 'https' and request.url.host == 'www.google-analytics.com'
        assert request.url.path == '/debug/mp/collect'
        payload = json.loads(request.content)
        assert payload['validation_behavior'] == 'ENFORCE_RECOMMENDATIONS'
        assert {event['name'] for event in payload['events']} == set(analytics.EVENT_PARAMS)
        assert all(event['timestamp_micros'] > 0 for event in payload['events'])
        assert all('session_id' in event['params'] for event in payload['events'])
        assert not {'user_id', 'ip_override', 'user_data'} & payload.keys()
        return httpx.Response(200, json={'validationMessages': []})

    result = validation_tool.validate('G-TEST123456', SECRET, httpx.MockTransport(respond))
    assert result['valid'] and result['event_count'] == len(analytics.EVENT_PARAMS)
    assert SECRET not in json.dumps(result) and 'api_secret' not in json.dumps(result)


@pytest.mark.parametrize('failure', ['transport', 'http', 'invalid', 'message'])
def test_validation_tool_does_not_disclose_secret_or_request_url(validation_tool, failure):
    def respond(request):
        if failure == 'transport':
            raise httpx.ConnectError(str(request.url), request=request)
        if failure == 'http':
            return httpx.Response(503, text=str(request.url))
        if failure == 'invalid':
            return httpx.Response(200, text=str(request.url))
        return httpx.Response(200, json={'validationMessages': [{'fieldPath': 'events',
            'description': 'Injected ' + SECRET + ' URL ' + str(request.url), 'validationCode': 'VALUE_INVALID'}]})

    result = validation_tool.validate('G-TEST123456', SECRET, httpx.MockTransport(respond))
    assert not result['valid']
    assert SECRET not in json.dumps(result) and 'api_secret' not in json.dumps(result)
