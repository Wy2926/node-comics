"""Opt-in R2 document channel; independent of the existing local image store."""
from functools import lru_cache
from pathlib import Path
import re
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


MAX_SOURCE_BYTES = 200_000_000  # Decimal MB, not MiB.
MAX_PAGES = 200


class DocumentSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix='DOCUMENT_', env_file=('../.env', '.env'),
                                     extra='ignore', hide_input_in_errors=True)
    enabled: bool = False
    r2_endpoint_url: str = ''
    r2_bucket: str = ''
    r2_access_key_id: SecretStr = SecretStr('')
    r2_secret_access_key: SecretStr = SecretStr('')
    r2_key_prefix: str = Field(default='documents', max_length=96)
    signed_url_seconds: int = Field(default=300, ge=30, le=900)
    upload_part_bytes: int = Field(default=16 * 1024 * 1024, ge=5 * 1024 * 1024, le=32 * 1024 * 1024)
    upload_lifetime_seconds: int = Field(default=3600, ge=300, le=86400)
    spool_path: Path = Path('./document-spool')
    worker_slots: int = Field(default=1, ge=1, le=4)
    worker_poll_seconds: float = Field(default=2, ge=0.1, le=60)
    prepare_timeout_seconds: int = Field(default=900, ge=1, le=3600)
    package_timeout_seconds: int = Field(default=900, ge=1, le=3600)
    output_retention_days: int = Field(default=7, ge=1, le=365)
    waiting_retention_hours: int = Field(default=24, ge=1, le=168)
    parser_require_sandbox: bool = True
    max_page_pixels: int = Field(default=24_000_000, ge=1, le=100_000_000)
    max_page_dimension: int = Field(default=20_000, ge=1, le=100_000)
    max_page_bytes: int = Field(default=128 * 1024 * 1024, ge=1024, le=512 * 1024 * 1024)
    max_expanded_bytes: int = Field(default=2 * 1024 ** 3, ge=1024, le=8 * 1024 ** 3)
    max_output_bytes: int = Field(default=4 * 1024 ** 3, ge=1024, le=5 * 1024 ** 3)
    max_spool_bytes: int = Field(default=6 * 1024 ** 3, ge=1024, le=16 * 1024 ** 3)
    parser_memory_bytes: int = Field(default=1024 ** 3, ge=64 * 1024 ** 2, le=8 * 1024 ** 3)
    parser_timeout_seconds: int = Field(default=300, ge=1, le=1800)
    pdf_dpi: int = Field(default=144, ge=72, le=300)

    @field_validator('r2_key_prefix')
    @classmethod
    def prefix(cls, value):
        if not re.fullmatch(r'[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*', value):
            raise ValueError('DOCUMENT_R2_KEY_PREFIX must be a nonempty private namespace')
        return value

    @field_validator('r2_endpoint_url')
    @classmethod
    def endpoint(cls, value):
        if value:
            parsed = urlsplit(value)
            if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                    or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
                raise ValueError('DOCUMENT_R2_ENDPOINT_URL must be an HTTPS origin')
        return value.rstrip('/')

    @model_validator(mode='after')
    def configured(self):
        if self.enabled and not all((self.r2_endpoint_url, self.r2_bucket,
                                    self.r2_access_key_id.get_secret_value(),
                                    self.r2_secret_access_key.get_secret_value())):
            raise ValueError('Enabled document jobs require dedicated R2 settings')
        return self


@lru_cache
def get_document_settings():
    return DocumentSettings()
