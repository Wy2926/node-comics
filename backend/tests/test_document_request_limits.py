"""Only v2 page completion accepts bounded OCR text, never file byte ingress."""
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from app.middleware import BodyLimitMiddleware


@pytest.mark.parametrize('path,size,expected', [
    ('/internal/documents/compute/v2/leases/test/complete', 2 * 1024 * 1024, 200),
    ('/internal/documents/compute/v2/leases/test/complete', 4 * 1024 * 1024 + 4097, 413),
    ('/internal/documents/compute/v2/leases/test/uploads', 65537, 413),
    ('/internal/documents/compute/v2/nodes/test/sync', 65537, 413),
    ('/v1/documents', 65537, 413),
])
@pytest.mark.parametrize('chunked', [False, True])
def test_metadata_ingress_limits(monkeypatch, path, size, expected, chunked):
    monkeypatch.setattr('app.middleware.settings', lambda: SimpleNamespace(
        cluster_max_result_bytes=88 * 1024 * 1024, max_upload_bytes=32 * 1024 * 1024))

    async def endpoint(scope, receive, send):
        while (await receive()).get('more_body'):
            pass
        await send({'type': 'http.response.start', 'status': 200, 'headers': []})
        await send({'type': 'http.response.body', 'body': b'ok'})

    def chunks():
        remaining = size
        while remaining:
            count = min(65536, remaining)
            yield b'x' * count
            remaining -= count

    client = TestClient(BodyLimitMiddleware(endpoint))
    response = client.post(path, content=chunks() if chunked else b'x' * size)
    assert response.status_code == expected
