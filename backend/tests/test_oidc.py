"""Isolated JWT verification; no live Logto users or tokens are used."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec


@pytest.fixture
def oidc(client, monkeypatch):
    from app import auth
    from app.config import settings

    monkeypatch.setenv("DEV_AUTH", "false")
    monkeypatch.setenv("RESULT_STORAGE_BACKEND", "r2")
    monkeypatch.setenv("R2_ENDPOINT_URL", "https://" + "a" * 32 + ".r2.cloudflarestorage.com")
    monkeypatch.setenv("R2_BUCKET", "isolated-oidc-test")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "isolated-not-real")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "isolated-not-real")
    monkeypatch.setenv("OIDC_ISSUER", "https://identity.example.test/oidc")
    monkeypatch.setenv("OIDC_AUDIENCE", "https://comics.example.test/api")
    monkeypatch.setenv("OIDC_JWKS_URL", "https://identity.example.test/oidc/jwks")
    settings.cache_clear()
    private_key = ec.generate_private_key(ec.SECP384R1())
    monkeypatch.setattr(auth, "jwks_client", lambda: SimpleNamespace(
        get_signing_key_from_jwt=lambda token: SimpleNamespace(key=private_key.public_key())
    ))
    claims = {"iss": settings().oidc_issuer, "aud": settings().oidc_audience,
              "sub": "reader-one", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}
    return client, private_key, claims


def headers(key, claims):
    return {"Authorization": "Bearer " + jwt.encode(claims, key, algorithm="ES384")}


def test_es384_login_is_stable_and_users_are_separate(oidc):
    client, key, claims = oidc
    first = client.get("/v1/me", headers=headers(key, claims))
    assert first.status_code == 200, first.text
    repeated = client.get("/v1/me", headers=headers(key, claims))
    other = client.get("/v1/me", headers=headers(key, {**claims, "sub": "reader-two"}))
    assert repeated.status_code == other.status_code == 200
    assert first.json()["user"]["id"] == repeated.json()["user"]["id"]
    assert first.json()["user"]["id"] != other.json()["user"]["id"]
    assert first.json()["user"]["role"] == "user"
    assert client.post("/v1/auth/dev", json={"username": "admin"}).status_code == 404


def test_new_users_get_persisted_brand_random_names(oidc, monkeypatch):
    from app import auth
    from app.db import session_factory
    from app.models import User

    client, key, claims = oidc
    suffixes = iter(['7a2c9f10', '8b3d0e21'])
    monkeypatch.setattr(auth.secrets, 'token_hex', lambda size: next(suffixes) if size == 4 else None)
    first = client.get('/v1/me', headers=headers(key, {**claims, 'name': 'Identity provider name'})).json()['user']
    assert first['name'] == 'NodeLane_7a2c9f10'
    repeated = client.get('/v1/me', headers=headers(key, {**claims, 'name': 'Changed provider name'})).json()['user']
    assert repeated['name'] == first['name']
    other = client.get('/v1/me', headers=headers(key, {**claims, 'sub': 'reader-two'})).json()['user']
    assert other['name'] == 'NodeLane_8b3d0e21'
    with session_factory()() as db:
        db.get(User, first['id']).name = 'Existing reader'
        db.commit()
    assert client.get('/v1/me', headers=headers(key, claims)).json()['user']['name'] == 'Existing reader'


@pytest.mark.parametrize("changes", [
    {"iss": "https://other.example.test/oidc"},
    {"aud": "another-application"},
    {"exp": 1},
])
def test_es384_rejects_invalid_claims(oidc, changes):
    client, key, claims = oidc
    response = client.get("/v1/me", headers=headers(key, {**claims, **changes}))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "TOKEN_INVALID"


def test_es384_rejects_wrong_signature(oidc):
    client, _, claims = oidc
    other_key = ec.generate_private_key(ec.SECP384R1())
    assert client.get("/v1/me", headers=headers(other_key, claims)).status_code == 401


def test_oidc_rejects_symmetric_algorithm(oidc):
    client, _, claims = oidc
    token = jwt.encode(claims, "isolated-test-secret-at-least-32-bytes", algorithm="HS256")
    assert client.get("/v1/me", headers={"Authorization": "Bearer " + token}).status_code == 401


@pytest.fixture
def rotating_jwks(client, monkeypatch):
    """Exercise PyJWT's real cache and HTTP decoder, with an isolated HTTP source."""
    import json
    from io import BytesIO
    from urllib.error import URLError
    import urllib.request
    from app import auth
    from app.config import settings

    cfg = settings()
    cfg.dev_auth = False
    cfg.oidc_issuer = "https://identity.example.test/oidc"
    cfg.oidc_audience = "https://comics.example.test/api"
    cfg.oidc_jwks_url = cfg.oidc_issuer + "/jwks"
    cfg.oidc_jwks_cache_seconds = 30
    old = ec.generate_private_key(ec.SECP384R1())
    new = ec.generate_private_key(ec.SECP384R1())

    def jwk(key, kid):
        return {**jwt.algorithms.ECAlgorithm.to_jwk(key.public_key(), as_dict=True), "kid": kid, "use": "sig", "alg": "ES384"}

    clock = [1000.0]
    state = {"keys": [jwk(old, "old")], "requests": 0, "unavailable": False}

    class Opener:
        def open(self, request, timeout):
            assert request.full_url == cfg.oidc_jwks_url
            # The production identity proxy rejects urllib's default user agent.
            assert request.get_header("User-agent") == "NodeComics/0.3"
            state["requests"] += 1
            if state["unavailable"]:
                raise URLError("isolated outage")
            return BytesIO(json.dumps({"keys": state["keys"]}).encode())

    # Replace each module's time binding, leaving pytest's real timeout clock alone.
    monkeypatch.setattr(jwt.jwk_set_cache, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(jwt.api_jwk, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(jwt.jwks_client, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(urllib.request, "build_opener", lambda *args: Opener())
    auth.jwks_client.cache_clear()
    claims = {"iss": cfg.oidc_issuer, "aud": cfg.oidc_audience, "sub": "rotation-reader",
              "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}

    def token_headers(key, kid):
        token = jwt.encode(claims, key, algorithm="ES384", headers={"kid": kid})
        return {"Authorization": "Bearer " + token}

    yield client, state, clock, jwk, old, new, token_headers
    auth.jwks_client.cache_clear()


def test_revoked_signing_key_expires_and_rotated_key_is_accepted(rotating_jwks):
    client, state, clock, jwk, old, new, token_headers = rotating_jwks
    assert client.get("/v1/me", headers=token_headers(old, "old")).status_code == 200
    state["keys"] = [jwk(new, "new")]
    clock[0] += 29
    assert client.get("/v1/me", headers=token_headers(old, "old")).status_code == 200
    assert state["requests"] == 1
    clock[0] += 2
    assert client.get("/v1/me", headers=token_headers(old, "old")).status_code == 401
    assert client.get("/v1/me", headers=token_headers(new, "new")).status_code == 200
    assert state["requests"] == 2


def test_expired_jwks_does_not_accept_stale_key_during_outage(rotating_jwks):
    client, state, clock, _, old, _, token_headers = rotating_jwks
    assert client.get("/v1/me", headers=token_headers(old, "old")).status_code == 200
    state["unavailable"] = True
    clock[0] += 31
    assert client.get("/v1/me", headers=token_headers(old, "old")).status_code == 401
    assert state["requests"] == 2


@pytest.mark.parametrize("subject", ["", 123, "x" * 255])
def test_oidc_rejects_invalid_subject(oidc, subject):
    client, key, claims = oidc
    assert client.get("/v1/me", headers=headers(key, {**claims, "sub": subject})).status_code == 401
