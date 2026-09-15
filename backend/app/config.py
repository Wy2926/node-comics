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
    oidc_issuer: str = ""
    oidc_audience: str = ""
    oidc_jwks_url: str = ""
    oidc_authorization_endpoint: str = ""
    oidc_token_endpoint: str = ""
    oidc_client_id: str = ""
    oidc_admin_role: str = "node-comics-admin"
    cors_origins: str = "http://localhost:18080,http://127.0.0.1:18080,http://localhost:5173,http://127.0.0.1:5173"
    extension_ids: str = ""
    free_daily_pages: int = Field(default=100, ge=0, le=1_000_000)
    plus_monthly_redraw_pages: int = Field(default=300, ge=0, le=1_000_000)
    quota_timezone: str = "Asia/Shanghai"
    retention_days: int = Field(default=0, ge=0)
    max_upload_bytes: int = 20 * 1024 * 1024
    max_pixels: int = 24_000_000
    max_dimension: int = 8192
    max_batch: int = Field(default=500, ge=1, le=500)
    free_queue_capacity: int = Field(default=10, ge=1, le=1000)
    plus_queue_capacity: int = Field(default=500, ge=1, le=5000)
    free_realtime_slots: int = Field(default=2, ge=1, le=100)
    plus_realtime_slots: int = Field(default=10, ge=1, le=100)
    free_scheduler_weight: float = Field(default=1, ge=0.1, le=100)
    plus_scheduler_weight: float = Field(default=2, ge=0.1, le=100)
    realtime_share: float = Field(default=0.9, ge=0.5, le=0.99)
    priority_ttl_seconds: int = Field(default=90, ge=10, le=300)
    upload_session_ttl_seconds: int = Field(default=900, ge=30, le=3600)
    upload_session_max_lifetime_seconds: int = Field(default=3600, ge=60, le=86400)
    cluster_node_token: SecretStr = SecretStr("")
    cluster_lease_seconds: int = Field(default=90, ge=10, le=600)
    cluster_node_timeout_seconds: int = Field(default=120, ge=10, le=600)
    cluster_stage_attempts: int = Field(default=3, ge=1, le=10)
    cluster_text_slots: int = Field(default=4, ge=1, le=100)
    cluster_upload_slots: int = Field(default=2, ge=1, le=32)
    cluster_redraw_slots: int = Field(default=4, ge=1, le=100)
    cluster_text_requests_per_minute: int = Field(default=60, ge=1, le=10000)
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
    classic_engine_profile: Literal['mit', 'mit-directml'] = 'mit'
    classic_engine_version: str = "mit-95227a2-classic-v4-cluster"
    classic_timeout_seconds: int = 900
    text_base_url: str = ""
    text_api_key: str = ""
    text_model: str = "gpt-5.6-luna"
    text_protocol: str = "openai_chat"
    text_user_agent: str = "Mozilla/5.0"
    text_timeout_seconds: int = 60
    text_max_attempts: int = 3
    text_max_output_tokens: int = 1024
    text_group_bytes: int = 1800
    text_page_budget_micros: int = 50_000
    # CNY per million tokens = micro-CNY per token; operator estimates, not billing facts.
    text_input_rate: int = 5
    text_output_rate: int = 30
    text_pricing_version: str = "operator-estimate-v1"

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
