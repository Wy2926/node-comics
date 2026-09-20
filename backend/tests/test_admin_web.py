"""Hidden entry and callback routing; no external identity or storage requests."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app.admin_web import create_router
from test_identity_config import production


@pytest.mark.parametrize("path", ["/admin/", "/Admin/", "/v1/", "/health/", "/docs/", "/", "//other/",
    "/console", "/a/b/", "/entry/?x=1", "/entry/#x", "/%61dmin/", "/../", "/entry\\x/", " /entry/"])
def test_invalid_entry_rejected(path):
    with pytest.raises(ValidationError, match="ADMIN_WEB_PATH"):
        production(admin_web_path=path)


def test_configured_entry_and_callback(client):
    response = client.get('/console-test?code=test-code&state=test-state', follow_redirects=False)
    assert response.status_code == 307
    assert response.headers['location'] == '/console-test/?code=test-code&state=test-state'
    # The public homepage may be built locally; it must not reveal or redirect
    # to the private console. Missing admin aliases still return a real 404.
    homepage = client.get('/', follow_redirects=False)
    assert homepage.status_code in (200, 404)
    assert 'location' not in homepage.headers
    assert '/console-test/' not in homepage.text
    for path in ['/admin', '/admin/', '/admin/?code=test&state=test', '/admin/assets/app.js', '/console-other/']:
        response = client.get(path, follow_redirects=False)
        assert response.status_code == 404
        assert 'location' not in response.headers
        assert '/console-test/' not in response.text
    assert '/console-test/' not in client.get('/openapi.json').text
    assert '/console-test/' not in client.get('/v1/auth/config').text


def test_disabled_entry_registers_no_routes():
    assert production(admin_web_path='').admin_web_path == ''
    app = FastAPI()
    app.include_router(create_router(''))
    with TestClient(app) as client:
        for path in ['/admin', '/admin/', '/console-test/']:
            assert client.get(path).status_code == 404


def test_entry_can_change_without_rebuilding(monkeypatch, tmp_path):
    from app import admin_web
    from types import SimpleNamespace
    monkeypatch.setattr(admin_web, 'settings', lambda: SimpleNamespace(oidc_token_endpoint='https://identity.example/token'))
    monkeypatch.setattr(admin_web, 'ROOT', tmp_path)
    (tmp_path / 'index.html').write_text('<script src="./assets/app.js"></script>', encoding='utf-8')
    (tmp_path / 'assets').mkdir()
    (tmp_path / 'assets/app.js').write_text('/* same build */', encoding='utf-8')
    for entry in ['/console-first/', '/console-second/']:
        app = FastAPI()
        app.include_router(create_router(entry))
        with TestClient(app) as client:
            assert client.get(entry + '?code=callback&state=state').status_code == 200
            assert client.get(entry + 'assets/app.js').status_code == 200
            assert client.get(entry + 'assets/private.env').status_code == 404
            assert client.get('/admin/').status_code == 404
