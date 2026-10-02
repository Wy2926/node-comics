"""Server configuration. Secrets are read from environment, never returned to clients."""
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
import re
from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore", hide_input_in_errors=True)
    app_env: Literal["production", "development", "test"] = "production"
    release_id: str = Field(default='development', pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')
    serve_static: bool = True  # Local fixtures only; production Compose disables it.
    database_url: str = "sqlite:///./node-comics.db"
    redis_url: SecretStr = SecretStr('redis://127.0.0.1:6379/0')
    redis_namespace: str = Field(default='node-comics', pattern=r'^[A-Za-z0-9_-]{1,80}$')

    @field_validator('redis_url')
    @classmethod
    def valid_redis_url(cls, value):
        try:
            parsed = urlsplit(value.get_secret_value())
            valid = parsed.scheme in {'redis', 'rediss'} and bool(parsed.hostname) and parsed.port != 0
        except ValueError:
            valid = False
        if not valid:
            raise ValueError('REDIS_URL must be a redis:// or rediss:// server URL')
        return value
    storage_path: Path = Path("./private-data")
    dev_auth: bool = False
    dev_auth_secret: str = ""
    dev_admin_username: str = "admin"
    admin_web_path: str = ""
    oidc_issuer: str = ""
    oidc_audience: str = ""
    oidc_jwks_url: str = ""
    oidc_authorization_endpoint: str = ""
    oidc_token_endpoint: str = ""
    oidc_client_id: str = ""
    oidc_admin_role: str = "node-comics-admin"
    oidc_jwks_cache_seconds: int = Field(default=300, ge=1, le=300)
    oidc_jwks_timeout_seconds: int = Field(default=10, ge=1, le=30)
    cors_origins: str = "http://localhost:18080,http://127.0.0.1:18080,http://localhost:5173,http://127.0.0.1:5173"
    extension_ids: str = ""
    guest_enabled: bool = False
    guest_origin: str = "https://comics.nodelane.net"
    turnstile_site_key: str = ""
    turnstile_secret_key: SecretStr = SecretStr("")
    guest_hash_secret: SecretStr = SecretStr("")
    guest_daily_limit: int = Field(default=5, ge=1, le=100)
    guest_network_daily_limit: int = Field(default=100, ge=1, le=1000)
    guest_global_daily_limit: int = Field(default=10000, ge=1, le=100000)
    guest_global_concurrency: int = Field(default=4, ge=1, le=100)

    @field_validator('guest_origin')
    @classmethod
    def valid_guest_origin(cls, value):
        parsed = urlsplit(value)
        if (parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment or '*' in value
                or (parsed.scheme == 'http' and parsed.hostname not in ('127.0.0.1', 'localhost', 'testserver'))):
            raise ValueError('GUEST_ORIGIN must be an exact HTTPS origin (HTTP loopback only for tests)')
        return value
    @model_validator(mode='after')
    def validate_guest_configuration(self):
        if self.guest_enabled:
            if not self.turnstile_site_key or not self.turnstile_secret_key.get_secret_value() or len(self.guest_hash_secret.get_secret_value()) < 32:
                raise ValueError('Guest trials require Turnstile site/secret keys and a GUEST_HASH_SECRET of at least 32 characters')
            if self.app_env == 'production':
                if not self.guest_origin.startswith('https://'):
                    raise ValueError('Production guest trials require an HTTPS origin')
                # Cloudflare publishes these prefixes for its always-pass/fail test keys.
                test_prefixes = ('1x00000000000000000000','2x00000000000000000000','3x00000000000000000000')
                if self.turnstile_site_key.startswith(test_prefixes) or self.turnstile_secret_key.get_secret_value().startswith(test_prefixes):
                    raise ValueError('Turnstile test keys are forbidden in production')
        return self

    ga4_enabled: bool = False
    ga4_debug_mode: bool = False
    ga4_extension_measurement_id: str = Field(default="", pattern=r"^(G-[A-Z0-9]{4,20})?$")
    ga4_extension_api_secret: SecretStr = SecretStr("")
    free_daily_pages: int = Field(default=30, ge=0, le=1_000_000)
    plus_monthly_redraw_pages: int = Field(default=300, ge=0, le=1_000_000)
    stripe_enabled: bool = False
    stripe_environment: Literal['test', 'live'] = 'test'
    stripe_secret_key: SecretStr = SecretStr('')
    stripe_webhook_secret: SecretStr = SecretStr('')
    stripe_return_url: str = ''
    stripe_portal_configuration_id: str = Field(default='', pattern=r'^(bpc_[A-Za-z0-9]+)?$')
    creem_enabled: bool = False
    creem_environment: Literal['test', 'live'] = 'test'
    creem_api_key: SecretStr = SecretStr('')
    creem_webhook_secret: SecretStr = SecretStr('')
    creem_return_url: str = ''
    quota_timezone: str = "Asia/Shanghai"
    max_upload_bytes: int = 128 * 1024 * 1024
    max_dimension: int = 100_000
    translation_requests_per_minute: int = Field(default=300, ge=1, le=10000)
    translation_request_burst: int = Field(default=30, ge=1, le=1000)
    translation_request_concurrency: int = Field(default=4, ge=1, le=32)
    translation_request_lease_seconds: int = Field(default=60, ge=10, le=300)
    translation_max_body_bytes: int = Field(default=65536, ge=1024, le=1048576)
    free_images_per_minute: int = Field(default=10, ge=1, le=10000)
    plus_images_per_minute: int = Field(default=100, ge=1, le=10000)
    feedback_requests_per_minute: int = Field(default=30, ge=1, le=1000)
    feedback_request_burst: int = Field(default=10, ge=1, le=100)
    feedback_receipts_per_day: int = Field(default=100, ge=1, le=10000)
    upload_user_concurrency: int = Field(default=10, ge=1, le=32)
    upload_global_concurrency: int = Field(default=16, ge=1, le=128)
    upload_idle_timeout_seconds: float = Field(default=15, ge=0.1, le=120)
    upload_body_timeout_seconds: float = Field(default=120, ge=0.1, le=900)
    upload_ingress_lease_seconds: int = Field(default=45, ge=15, le=300)
    upload_session_ttl_seconds: int = Field(default=900, ge=30, le=3600)
    upload_session_max_lifetime_seconds: int = Field(default=3600, ge=60, le=86400)
    cluster_lease_seconds: int = Field(default=90, ge=10, le=600)
    cluster_node_timeout_seconds: int = Field(default=120, ge=10, le=600)
    cluster_stage_attempts: int = Field(default=3, ge=1, le=10)
    cluster_text_slots: int = Field(default=4, ge=1, le=100)
    cluster_upload_slots: int = Field(default=2, ge=1, le=32)
    cluster_redraw_slots: int = Field(default=4, ge=1, le=100)
    cluster_result_ingress_concurrency: int = Field(default=4, ge=1, le=64)
    cluster_max_result_bytes: int = Field(default=88 * 1024 * 1024, ge=1024, le=128 * 1024 * 1024)
    unknown_release_seconds: int = 3600
    dispatch_interval_seconds: int = 2
    openai_base_url: str = "https://api.openai.com/v1"
    openai_api_key: str = ""
    openai_model: str = "gpt-image-2"
    openai_user_agent: str = "NodeComics/0.1"
    providers_json: str = ""
    provider_timeout_seconds: int = 600
    allow_private_providers: bool = False
    classic_enabled: bool = False
    classic_timeout_seconds: int = Field(default=900, ge=30, le=3600)

    @model_validator(mode="after")
    def validate_analytics(self):
        if self.app_env == "production" and self.ga4_debug_mode:
            raise ValueError("GA4_DEBUG_MODE requires an isolated development/test service")
        return self

    @model_validator(mode="after")
    def validate_billing(self):
        if self.creem_enabled:
            if self.app_env == 'production' and self.creem_environment != 'live':
                raise ValueError('Test billing requires an isolated development/test service')
            key = self.creem_api_key.get_secret_value()
            if not key.startswith('creem_') or key.startswith('creem_test_') != (self.creem_environment == 'test'):
                raise ValueError('Creem API key does not match the environment')
            if not self.creem_webhook_secret.get_secret_value():
                raise ValueError('Creem webhook secret is required')
            url = urlsplit(self.creem_return_url)
            if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
                raise ValueError('Creem return URL must be an HTTPS page without credentials or query')
        if self.creem_enabled and self.stripe_enabled and self.creem_environment != self.stripe_environment:
            raise ValueError('Payment channels must use the same environment and isolated database')
        if self.stripe_enabled:
            if self.app_env == 'production' and self.stripe_environment != 'live':
                raise ValueError('Test billing requires an isolated development/test service')
            prefix = 'sk_live_' if self.stripe_environment == 'live' else 'sk_test_'
            if not self.stripe_secret_key.get_secret_value().startswith(prefix):
                raise ValueError('Stripe secret key does not match the environment')
            if not self.stripe_webhook_secret.get_secret_value().startswith('whsec_'):
                raise ValueError('Stripe webhook secret is required')
            url = urlsplit(self.stripe_return_url)
            if (url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment):
                raise ValueError('Stripe return URL must be an HTTPS page without credentials or query')
        return self

    @model_validator(mode="after")
    def validate_admin_web_path(self):
        if self.admin_web_path and (not re.fullmatch(r"/[A-Za-z0-9][A-Za-z0-9_-]{1,79}/", self.admin_web_path)
                or self.admin_web_path.strip("/").lower() in {
                    "admin", "v1", "internal", "health", "docs", "redoc", "api", "openapi",
                    "account", "auth", "features", "pricing", "download", "guides", "faq", "help", "translate",
                    "about", "changelog", "privacy", "terms", "refund", "zh-tw", "en", "ja", "ko"}):
            raise ValueError("ADMIN_WEB_PATH must be empty (disabled) or a non-reserved /name/ path using letters, digits, hyphens or underscores")
        return self

    @model_validator(mode="after")
    def validate_identity(self):
        if self.app_env == "production":
            if self.dev_auth:
                raise ValueError("Production requires DEV_AUTH=false; passwordless development login is forbidden")
            from sqlalchemy.engine import make_url
            if make_url(self.database_url).get_backend_name() != "postgresql":
                raise ValueError("Production requires a PostgreSQL DATABASE_URL")
            required = ("oidc_issuer", "oidc_audience", "oidc_jwks_url", "oidc_client_id",
                        "oidc_authorization_endpoint", "oidc_token_endpoint")
            missing = [name.upper() for name in required if not getattr(self, name).strip()]
            if missing:
                raise ValueError("Production identity configuration is missing: " + ", ".join(missing))
            if self.oidc_audience == self.oidc_client_id:
                raise ValueError("OIDC_AUDIENCE must identify the API resource, not OIDC_CLIENT_ID")
            for name in ("oidc_issuer", "oidc_jwks_url", "oidc_authorization_endpoint", "oidc_token_endpoint"):
                value = getattr(self, name)
                url = urlsplit(value)
                if (value != value.strip() or url.scheme != "https" or not url.hostname
                        or url.username or url.password or url.query or url.fragment):
                    raise ValueError(name.upper() + " must be an absolute HTTPS URL without credentials, query or fragment")
            origins = [value.strip() for value in self.cors_origins.split(",") if value.strip()]
            extension_ids = [value.strip() for value in self.extension_ids.split(",") if value.strip()]
            if not origins and not extension_ids:
                raise ValueError("Production requires explicit CORS_ORIGINS or EXTENSION_IDS")
            for value in origins:
                url = urlsplit(value)
                if (url.scheme != "https" or not url.hostname or "*" in value or url.username or url.password
                        or url.path or url.query or url.fragment):
                    raise ValueError("Production CORS_ORIGINS must contain exact HTTPS origins without paths or wildcards")
            if any(not re.fullmatch(r"[a-p]{32}", value) for value in extension_ids):
                raise ValueError("EXTENSION_IDS must contain exact 32-character Chrome extension IDs")
        elif self.dev_auth and len(self.dev_auth_secret) < 32:
            raise ValueError("DEV_AUTH_SECRET must contain at least 32 characters when DEV_AUTH is enabled")
        return self

    @model_validator(mode="after")
    def validate_storage(self):
        from zoneinfo import ZoneInfo
        ZoneInfo(self.quota_timezone)

        return self


@lru_cache
def settings() -> Settings:
    return Settings()


if __name__ == "__main__":
    # Configuration-only deployment preflight: no database, file storage or provider calls.
    from argparse import ArgumentParser
    parser = ArgumentParser(description="Validate backend configuration without external calls")
    parser.add_argument("--production", action="store_true", help="Require the effective environment to be production")
    args = parser.parse_args()
    config = settings()
    if args.production and config.app_env != "production":
        parser.error("Production preflight requires effective APP_ENV=production; check shell overrides")
    print("Backend configuration validated")
