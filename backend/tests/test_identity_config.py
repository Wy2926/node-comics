"""Fail-closed production configuration, without a database or identity server."""
import pytest
from pydantic import ValidationError
from app.config import Settings


def production(**changes):
    values = dict(_env_file=None, app_env="production", dev_auth=False,
        database_url="postgresql+psycopg://unused:unused@database.invalid/unused",
        result_storage_backend="r2", r2_endpoint_url="https://" + "a" * 32 + ".r2.cloudflarestorage.com",
        r2_bucket="isolated-test", r2_access_key_id="unused", r2_secret_access_key="unused",
        oidc_issuer="https://identity.example.test/oidc", oidc_audience="https://comics.example.test/api",
        oidc_jwks_url="https://identity.example.test/oidc/jwks", oidc_client_id="browser-client",
        oidc_authorization_endpoint="https://identity.example.test/oidc/auth",
        oidc_token_endpoint="https://identity.example.test/oidc/token",
        cors_origins="https://comics.example.test", extension_ids="a" * 32)
    return Settings(**{**values, **changes})


def test_production_validates_complete_configuration():
    assert production().app_env == "production"
    assert production(cors_origins="").extension_ids


@pytest.mark.parametrize("field", ["oidc_issuer", "oidc_audience", "oidc_jwks_url", "oidc_client_id",
                                   "oidc_authorization_endpoint", "oidc_token_endpoint"])
def test_production_rejects_missing_identity_fields(field):
    with pytest.raises(ValidationError, match=field.upper()):
        production(**{field: ""})


@pytest.mark.parametrize("changes", [
    {"dev_auth": True}, {"database_url": "sqlite:///temporary.db"},
    {"oidc_audience": "browser-client"}, {"oidc_jwks_url": "http://identity.example.test/jwks"},
    {"oidc_issuer": "https://user:secret@identity.example.test/oidc"},
    {"oidc_token_endpoint": "https://identity.example.test/token?secret=value"},
    {"cors_origins": "*"}, {"cors_origins": "https://*.example.test"},
    {"cors_origins": "http://localhost:5173"}, {"cors_origins": "https://comics.example.test/path"},
    {"cors_origins": "https://comics.example.test/"}, {"cors_origins": "https://comics.example.test?query=yes"},
    {"cors_origins": "", "extension_ids": ""}, {"extension_ids": "all-extensions"},
    {"oidc_jwks_cache_seconds": 301}, {"oidc_jwks_cache_seconds": 0},
])
def test_production_rejects_unsafe_configuration(changes):
    with pytest.raises(ValidationError):
        production(**changes)


def test_environment_defaults_to_production(monkeypatch):
    monkeypatch.delenv("APP_ENV", raising=False)
    with pytest.raises(ValidationError, match="Production requires DEV_AUTH=false"):
        Settings(_env_file=None, dev_auth=True)


def test_development_login_requires_explicit_environment_and_signing_secret():
    assert production(app_env="development", dev_auth=True, dev_auth_secret="x" * 32)
    with pytest.raises(ValidationError, match="DEV_AUTH_SECRET"):
        production(app_env="development", dev_auth=True, dev_auth_secret="short")


def test_production_preflight_rejects_effective_development_mode(tmp_path):
    import os
    from pathlib import Path
    import subprocess
    import sys
    environment = {**os.environ, "APP_ENV": "development", "DEV_AUTH": "true",
        "DEV_AUTH_SECRET": "isolated-cli-test-signature-never-product",
        "RESULT_STORAGE_BACKEND": "local", "R2_ENDPOINT_URL": "",
        "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    response = subprocess.run([sys.executable, "-m", "app.config", "--production"],
        cwd=tmp_path, env=environment, text=True, capture_output=True, timeout=10)
    assert response.returncode == 2
    assert "effective APP_ENV=production" in response.stderr
    assert "isolated-cli-test-signature-never-product" not in response.stderr


def test_identity_validation_errors_do_not_disclose_configured_secrets():
    marker = "isolated-private-value-not-for-output"
    with pytest.raises(ValidationError) as failure:
        production(dev_auth=True, dev_auth_secret=marker, r2_secret_access_key=marker,
                   database_url=f"postgresql+psycopg://user:{marker}@database.invalid/unused")
    assert marker not in str(failure.value)
