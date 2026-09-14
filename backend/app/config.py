"""Server configuration. Secrets are read from environment, never returned to clients."""
from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")
    database_url: str = "sqlite:///./node-comics.db"
    redis_url: str = "redis://localhost:6379/0"
    storage_path: Path = Path("./private-data")
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
    initial_quota: int = 100
    redraw_cost: int = 8
    retention_days: int = 7
    max_upload_bytes: int = 20 * 1024 * 1024
    max_pixels: int = 24_000_000
    max_dimension: int = 8192
    max_batch: int = 100
    max_active_jobs: int = 120
    batch_window: int = 3
    unknown_release_seconds: int = 3600
    dispatch_interval_seconds: int = 2
    queue_republish_seconds: int = 60
    openai_base_url: str = "https://api.openai.com/v1"
    openai_api_key: str = ""
    openai_model: str = "gpt-image-2"
    openai_user_agent: str = "NodeComics/0.1"
    providers_json: str = ""
    provider_timeout_seconds: int = 600
    allow_private_providers: bool = False
    classic_enabled: bool = False
    classic_cost: int = 1
    classic_engine_url: str = "http://classic-engine:8000"
    classic_engine_token: str = ""
    classic_engine_version: str = "mit-95227a2-classic-v1"
    classic_timeout_seconds: int = 900
    classic_local_attempts: int = 3
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


@lru_cache
def settings() -> Settings:
    return Settings()
