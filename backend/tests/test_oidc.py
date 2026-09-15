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
