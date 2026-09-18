"""Server configuration. Secrets are read from environment, never returned to clients."""
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
import re
from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore", hide_input_in_errors=True)
    app_env: Literal["production", "development", "test"] = "production"
    database_url: str = "sqlite:///./node-comics.db"
    storage_path: Path = Path("./private-data")
    result_storage_backend: Literal["local", "r2"] = "local"
    r2_endpoint_url: str = ""
    r2_bucket: str = ""
    r2_access_key_id: SecretStr = SecretStr("")
    r2_secret_access_key: SecretStr = SecretStr("")
    r2_key_prefix: str = "node-comics/"
    storage_url_ttl_seconds: int = Field(default=300, ge=1, le=3600)
    storage_timeout_seconds: int = Field(default=30, ge=1, le=120)
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
    free_daily_pages: int = Field(default=100, ge=0, le=1_000_000)
    plus_monthly_redraw_pages: int = Field(default=300, ge=0, le=1_000_000)
    paddle_enabled: bool = False
    paddle_environment: Literal['sandbox', 'production'] = 'sandbox'
    paddle_api_key: SecretStr = SecretStr('')
    paddle_client_token: str = ''
    paddle_webhook_secret: SecretStr = SecretStr('')
    paddle_product_id: str = ''
    paddle_trial_price_id: str = ''
    paddle_standard_price_id: str = ''
    paddle_checkout_url: str = ''
    quota_timezone: str = "Asia/Shanghai"
    retention_days: int = Field(default=0, ge=0)
    max_upload_bytes: int = 20 * 1024 * 1024
    max_pixels: int = 24_000_000
    max_dimension: int = 8192
    max_batch: int = Field(default=500, ge=1, le=500)
    submission_requests_per_minute: int = Field(default=60, ge=1, le=10000)
    submission_request_burst: int = Field(default=30, ge=1, le=1000)
    submission_items_per_minute: int = Field(default=2000, ge=1, le=100000)
    submission_item_burst: int = Field(default=1000, ge=500, le=100000)
    submission_concurrency: int = Field(default=4, ge=1, le=32)
    submission_large_batch_items: int = Field(default=100, ge=1, le=500)
    submission_large_batch_concurrency: int = Field(default=1, ge=1, le=8)
    submission_admission_lease_seconds: int = Field(default=300, ge=30, le=3600)
    submission_receipts_per_day: int = Field(default=2000, ge=1, le=100000)
    submission_items_per_day: int = Field(default=20000, ge=500, le=1000000)
    submission_receipt_retention_days: int = Field(default=30, ge=1, le=365)
    submission_max_body_bytes: int = Field(default=512 * 1024, ge=1024, le=2 * 1024 * 1024)
    feedback_requests_per_minute: int = Field(default=30, ge=1, le=1000)
    feedback_request_burst: int = Field(default=10, ge=1, le=100)
    feedback_receipts_per_day: int = Field(default=100, ge=1, le=10000)
    upload_user_concurrency: int = Field(default=10, ge=1, le=32)
    upload_global_concurrency: int = Field(default=16, ge=1, le=128)
    upload_idle_timeout_seconds: float = Field(default=15, ge=0.1, le=120)
    upload_body_timeout_seconds: float = Field(default=120, ge=0.1, le=900)
    upload_ingress_lease_seconds: int = Field(default=45, ge=15, le=300)
    free_queue_capacity: int = Field(default=3, ge=1, le=1000)
    plus_queue_capacity: int = Field(default=10, ge=1, le=5000)
    free_realtime_slots: int = Field(default=3, ge=1, le=100)
    plus_realtime_slots: int = Field(default=10, ge=1, le=100)
    free_scheduler_weight: float = Field(default=1, ge=0.1, le=100)
    plus_scheduler_weight: float = Field(default=2, ge=0.1, le=100)
    realtime_share: float = Field(default=0.9, ge=0.5, le=0.99)
    priority_ttl_seconds: int = Field(default=90, ge=10, le=300)
    upload_session_ttl_seconds: int = Field(default=900, ge=30, le=3600)
    upload_session_max_lifetime_seconds: int = Field(default=3600, ge=60, le=86400)
    cluster_lease_seconds: int = Field(default=90, ge=10, le=600)
    cluster_node_timeout_seconds: int = Field(default=120, ge=10, le=600)
    cluster_stage_attempts: int = Field(default=3, ge=1, le=10)
    cluster_text_slots: int = Field(default=4, ge=1, le=100)
    cluster_upload_slots: int = Field(default=2, ge=1, le=32)
    cluster_redraw_slots: int = Field(default=4, ge=1, le=100)
    cluster_max_result_bytes: int = Field(default=88 * 1024 * 1024, ge=1024, le=128 * 1024 * 1024)
    cluster_max_image_stages: int = Field(default=64, ge=1, le=1000)
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
    classic_engine_version: str = "mit-95227a2-classic-v9-qt-roi"
    classic_timeout_seconds: int = Field(default=900, ge=30, le=3600)

    @model_validator(mode="after")
    def validate_billing(self):
        if self.paddle_enabled:
            if self.app_env == 'production' and self.paddle_environment != 'production':
                raise ValueError('Sandbox billing requires an isolated development/test service')
            if not all((self.paddle_api_key.get_secret_value(), self.paddle_client_token,
                        self.paddle_webhook_secret.get_secret_value(), self.paddle_product_id,
                        self.paddle_trial_price_id, self.paddle_standard_price_id, self.paddle_checkout_url)):
                raise ValueError('Paddle billing configuration is incomplete')
            sandbox = self.paddle_environment == 'sandbox'
            if self.paddle_client_token.startswith('test_') != sandbox:
                raise ValueError('Paddle client token does not match the environment')
            if ('_sdbx_' in self.paddle_api_key.get_secret_value()) != sandbox:
                raise ValueError('Paddle API key does not match the environment')
            url = urlsplit(self.paddle_checkout_url)
            if (url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment):
                raise ValueError('Paddle checkout URL must be an HTTPS page without credentials or query')
        return self

    @model_validator(mode="after")
    def validate_admin_web_path(self):
        if self.admin_web_path and (not re.fullmatch(r"/[A-Za-z0-9][A-Za-z0-9_-]{1,79}/", self.admin_web_path)
                or self.admin_web_path.strip("/").lower() in {
                    "admin", "v1", "internal", "health", "docs", "redoc", "api", "openapi"}):
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
        if not self.dev_auth and self.result_storage_backend != "r2":
            raise ValueError("Public deployment requires RESULT_STORAGE_BACKEND=r2 for originals and results")
        if self.result_storage_backend == "r2" or self.r2_endpoint_url:
            url = urlsplit(self.r2_endpoint_url)
            if (url.scheme != "https" or not re.fullmatch(r"[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com", url.netloc)
                    or url.path not in ("", "/") or url.query or url.fragment):
                raise ValueError("R2_ENDPOINT_URL must be the HTTPS R2 S3 account endpoint")
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", self.r2_bucket):
                raise ValueError("R2_BUCKET must be a valid bucket name")
            if not self.r2_access_key_id.get_secret_value() or not self.r2_secret_access_key.get_secret_value():
                raise ValueError("R2 credentials are required")
            if not re.fullmatch(r"(?:[A-Za-z0-9_-]+/)+", self.r2_key_prefix):
                raise ValueError("R2_KEY_PREFIX must be a nonempty directory prefix ending in /")
        return self


@lru_cache
def settings() -> Settings:
    return Settings()


if __name__ == "__main__":
    # Configuration-only deployment preflight: no database, R2 or provider calls.
    from argparse import ArgumentParser
    parser = ArgumentParser(description="Validate backend configuration without external calls")
    parser.add_argument("--production", action="store_true", help="Require the effective environment to be production")
    args = parser.parse_args()
    config = settings()
    if args.production and config.app_env != "production":
        parser.error("Production preflight requires effective APP_ENV=production; check shell overrides")
    print("Backend configuration validated")
