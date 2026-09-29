"""Protocol admission precedes body consumption, auth and task admission."""
import asyncio
import json
import pytest

from app.middleware import BodyLimitMiddleware


@pytest.mark.parametrize('path,method', [
    ('/v1/translations', 'GET'), ('/v1/translations/events', 'GET'),
    ('/v1/translations/id', 'PUT'), ('/v1/translations/id/input', 'PUT'),
    ('/v1/translations/id/result', 'GET'), ('/v1/translations/id', 'DELETE'),
    ('/v1/translations/id/cancel', 'POST'), ('/v1/translations/id/feedback', 'POST')])
@pytest.mark.parametrize('protocol', [None, b'full-image-v1'])
def test_old_clients_are_rejected_before_reading_body(path, method, protocol):
    async def check():
        async def forbidden(*args):
            raise AssertionError('Old protocol must not consume body or enter application')
        messages = []
        async def send(message):
            messages.append(message)
        headers = [(b'content-length', b'999999999')]
        if protocol:
            headers.append((b'x-translation-protocol', protocol))
        await BodyLimitMiddleware(forbidden)({'type': 'http', 'path': path, 'method': method,
            'headers': headers}, forbidden, send)
        assert messages[0]['status'] == 409
        error = json.loads(messages[1]['body'])['error']
        assert error['code'] == 'CLIENT_UPGRADE_REQUIRED'
        assert error['update_url'] == 'https://comics.nodelane.net/download/'
    asyncio.run(check())


def test_result_multipart_content_length_uses_the_same_limit_as_stream(client):
    from app.config import settings
    settings().cluster_max_result_bytes = 1024
    response = client.put('/internal/compute/v3/leases/missing/result', content=b'x' * 1200)
    assert response.status_code != 413
    response = client.put('/internal/compute/v3/leases/missing/result', content=b'x' * (1024 + 65536 + 4097))
    assert response.status_code == 413


def test_openapi_requires_protocol_on_every_translation_resource(client):
    schema = client.get('/openapi.json').json()
    routes = {path: methods for path, methods in schema['paths'].items()
              if path == '/v1/translations' or path.startswith('/v1/translations/')}
    assert len(routes) >= 7
    for methods in routes.values():
        for operation in methods.values():
            headers = [item for item in operation.get('parameters', []) if item['name'] == 'X-Translation-Protocol']
            assert len(headers) == 1 and headers[0]['required']
            assert headers[0]['schema']['enum'] == ['overlay-v1']
