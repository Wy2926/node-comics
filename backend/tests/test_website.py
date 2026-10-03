"""Static website cache, route precedence and private-file boundaries, no external I/O."""
from pathlib import Path
from types import SimpleNamespace
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.website import WebsiteFiles


@pytest.fixture
def website(tmp_path, monkeypatch):
    from app import website as module
    monkeypatch.setattr(module, 'settings', lambda: SimpleNamespace(oidc_token_endpoint='https://identity.example/token'))
    for name in ['index.html', 'pricing/index.html', 'en/pricing/index.html', 'uninstall/index.html', 'en/uninstall/index.html', 'account/index.html', 'auth/callback/index.html', 'payment/success/index.html', 'en/payment/success/index.html', 'translate/index.html', 'en/translate/index.html', '404.html']:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('<!doctype html><h1>Public website</h1><script>window.site=true;</script>', encoding='utf-8')
    (tmp_path / '_astro').mkdir()
    (tmp_path / '_astro' / 'page.abc.js').write_text('export{}', encoding='utf-8')
    (tmp_path / '.env').write_text('DO_NOT_SERVE', encoding='utf-8')
    (tmp_path / 'source.map').write_text('DO_NOT_SERVE', encoding='utf-8')
    for locale in ('zh-tw', 'en', 'ja', 'ko', 'fr', 'es', 'pt-br', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id'):
        translated_error = tmp_path / locale / '404' / 'index.html'
        translated_error.parent.mkdir(parents=True)
        translated_error.write_text('<!doctype html><h1>Localized error page</h1>', encoding='utf-8')
    app = FastAPI()

    @app.get('/v1/me')
    def me():
        return {'api': True}

    @app.get('/private-console/')
    def console():
        return {'admin': True}

    app.mount('/', WebsiteFiles(tmp_path))
    return TestClient(app)


def test_public_pages_and_existing_api_precedence(website):
    for path in ['/', '/pricing/', '/en/pricing/']:
        result = website.get(path)
        assert result.status_code == 200
        assert result.headers['cache-control'] == 'public, max-age=0, must-revalidate'
        assert "'sha256-" in result.headers['content-security-policy']
        assert "script-src 'self' 'unsafe-inline'" not in result.headers['content-security-policy']
    assert website.get('/v1/me').json() == {'api': True}
    assert website.get('/private-console/').json() == {'admin': True}
    assert website.get('/pricing', follow_redirects=False).status_code in {307, 308}


def test_private_pages_and_hashed_assets(website):
    for path in ['/uninstall/', '/en/uninstall/', '/account/', '/auth/callback/?code=private-code&state=private-state', '/payment/success/', '/en/payment/success/', '/translate/', '/en/translate/']:
        result = website.get(path)
        assert result.status_code == 200
        assert result.headers['cache-control'] == 'private, no-store'
        assert result.headers['x-robots-tag'] == 'noindex, nofollow'
        assert result.headers['referrer-policy'] == 'no-referrer'
        assert 'private-code' not in result.text
    assert 'immutable' in website.get('/_astro/page.abc.js').headers['cache-control']


def test_challenge_and_blob_policy_is_confined_to_workbench(website):
    for path in ['/translate/', '/en/translate/']:
        csp = website.get(path).headers['content-security-policy']
        assert 'frame-src https://challenges.cloudflare.com' in csp
        assert "img-src 'self' data: blob:" in csp
        assert "worker-src 'self'" in csp
    for path in ['/', '/account/']:
        csp = website.get(path).headers['content-security-policy']
        assert 'challenges.cloudflare.com' not in csp and 'blob:' not in csp
        assert "frame-src 'none'" in csp


def test_canonical_redirects_and_localized_real_404(website):
    redirect = website.get('/en/pricing/index.html?source=guide', follow_redirects=False)
    assert redirect.status_code == 308
    assert redirect.headers['location'] == '/en/pricing/?source=guide'
    for locale in ('zh-tw', 'en', 'ja', 'ko', 'fr', 'es', 'pt-br', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id'):
        for suffix in ('missing/', '404/'):
            response = website.get('/' + locale + '/' + suffix)
            assert response.status_code == 404
            assert 'Localized error page' in response.text
            assert response.headers['cache-control'] == 'private, no-store'
            assert response.headers['x-robots-tag'] == 'noindex, nofollow'


def test_no_spa_fallback_or_private_source_disclosure(website):
    for path in ['/missing/', '/.env', '/source.map', '/%2e%2e/.env', '/_astro/../../.env']:
        result = website.get(path)
        assert result.status_code == 404
        assert 'DO_NOT_SERVE' not in result.text


def test_unbuilt_website_does_not_break_api(tmp_path):
    app = FastAPI()
    app.mount('/', WebsiteFiles(tmp_path / 'not-built'))
    with TestClient(app) as client:
        assert client.get('/').status_code == 404


def test_extension_download_redirects_to_published_permanent_url(website, monkeypatch):
    from app import website as module
    releases = [dict(row, download_url='https://packages.example/' + row['filename']) for row in module.RELEASES]
    monkeypatch.setattr(module, 'RELEASES', releases)
    for release in releases:
        for method in (website.get, website.head):
            response = method(release['path'] + '?key=private-image&expires=99999', follow_redirects=False)
            assert response.status_code == 308
            assert response.headers['location'] == release['download_url']
            assert response.headers['referrer-policy'] == 'no-referrer'
        assert website.post(release['path']).status_code == 405
    assert website.get('/downloads/private-image.zip').status_code == 404


@pytest.mark.parametrize('url', ['', 'http://packages.example/a.zip', 'https://user:secret@packages.example/a.zip',
    'https://packages.example/a.zip?X-Amz-Signature=temporary', 'https://packages.example/a.zip#fragment'])
def test_extension_download_rejects_unconfigured_or_non_permanent_url(website, monkeypatch, url):
    from app import website as module
    release = dict(module.RELEASES[-1], download_url=url)
    monkeypatch.setattr(module, 'RELEASES', [release])
    response = website.get(release['path'], follow_redirects=False)
    assert response.status_code == 503
    assert response.headers['retry-after'] == '60'
    assert response.headers['cache-control'] == 'private, no-store'


def test_real_api_guard_does_not_make_private_routes_public(client, tmp_path, monkeypatch):
    from conftest import login
    from app.main import app
    (tmp_path / 'index.html').write_text('<h1>Public home</h1>', encoding='utf-8')
    route = next(route for route in app.routes if getattr(route, 'name', None) == 'website')
    monkeypatch.setattr(route, 'app', WebsiteFiles(tmp_path))
    public = client.get('/')
    assert public.status_code == 200
    assert public.headers['cache-control'] == 'public, max-age=0, must-revalidate'
    response = client.get('/v1/me', headers=login(client))
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'private, no-store'
    assert client.get('/v1/auth/config').headers['cache-control'] == 'private, no-store'
