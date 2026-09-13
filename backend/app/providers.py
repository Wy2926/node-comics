import hashlib
import json
import os
from urllib.parse import urlsplit
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session
from .config import settings
from .errors import problem
from .models import Provider

LANGUAGES = {"zh-Hans": "简体中文", "zh-Hant": "繁體中文", "en": "English", "ja": "日本語", "ko": "한국어"}
PROMPT_VERSION = "comics-translate-v1"


class ProviderConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    label: str = Field(default="图片编辑服务", max_length=100)
    protocol: str = "openai_images"
    base_url: str = Field(max_length=1000)
    credential_ref: str = Field(default="OPENAI_API_KEY", pattern=r"^[A-Z][A-Z0-9_]{0,100}$")
    model: str = Field(min_length=1, max_length=120)
    image_field: str = "image"
    user_agent: str = Field(default="NodeComics/0.1", min_length=1, max_length=200)
    parameters: dict[str, str | int | float | bool] = Field(default_factory=dict)
    allowed_parameters: list[str] = Field(default_factory=lambda: ["quality", "size", "output_format", "background", "input_fidelity", "response_format", "moderation"])
    timeout_seconds: int = Field(default=600, ge=10, le=1800)
    max_bytes: int = Field(default=20 * 1024 * 1024, ge=1024, le=50 * 1024 * 1024)
    max_pixels: int = Field(default=24_000_000, ge=1, le=100_000_000)
    max_dimension: int = Field(default=8192, ge=32, le=32768)
    input_formats: list[str] = Field(default_factory=lambda: ["image/png", "image/jpeg", "image/webp"])
    download_hosts: list[str] = Field(default_factory=list)
    concurrency: int = Field(default=2, ge=1, le=32)
    enabled: bool = True
    pricing_version: str = "test-credits-v1"

    @field_validator("base_url")
    @classmethod
    def valid_base(cls, value):
        parsed = urlsplit(value)
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Base URL must not contain credentials, query or fragment")
        if parsed.scheme != "https" and not (settings().allow_private_providers and parsed.scheme == "http"):
            raise ValueError("HTTPS required")
        return value.rstrip("/")

    @field_validator("image_field")
    @classmethod
    def valid_field(cls, value):
        if value not in ("image", "image[]"):
            raise ValueError("image or image[] required")
        return value

    @field_validator("user_agent")
    @classmethod
    def valid_user_agent(cls, value):
        if not value.isascii() or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("User-Agent must contain printable ASCII only")
        return value

    @field_validator("protocol")
    @classmethod
    def valid_protocol(cls, value):
        if value != "openai_images":
            raise ValueError("Only openai_images supported")
        return value


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()


def credential(config: dict):
    ref = config["credential_ref"]
    return settings().openai_api_key if ref == "OPENAI_API_KEY" else os.environ.get(ref, "")


def initialize_providers(db: Session):
    cfg = settings()
    items = json.loads(cfg.providers_json) if cfg.providers_json else []
    if not isinstance(items, list):
        raise ValueError("PROVIDERS_JSON must be an array")
    if not items and cfg.openai_api_key:
        items = [{"id": "default", "label": "默认图片编辑服务", "base_url": cfg.openai_base_url, "model": cfg.openai_model, "user_agent": cfg.openai_user_agent, "timeout_seconds": cfg.provider_timeout_seconds}]
    for item in items:
        profile = ProviderConfig.model_validate(item)
        if not db.get(Provider, profile.id):
            db.add(Provider(id=profile.id, config=profile.model_dump(), enabled=profile.enabled))
    db.commit()


def configuration(db: Session, mode: str, language: str, provider_id=None):
    cfg = settings()
    if language not in LANGUAGES:
        problem("LANGUAGE_UNSUPPORTED", "此目标语言尚未开放", 422)
    if mode == "redraw":
        query = select(Provider).where(Provider.enabled.is_(True)).order_by(Provider.id)
        if provider_id:
            query = query.where(Provider.id == provider_id)
        providers = db.scalars(query).all()
        provider = next((item for item in providers if credential(item.config)), None)
        if not provider:
            problem("PROVIDER_CAPABILITY_UNSUPPORTED", "管理员尚未配置可用的图片编辑供应商", 503)
        config = {"mode": mode, "provider": provider.config, "prompt_version": PROMPT_VERSION, "unit_cost": cfg.redraw_cost}
    else:
        problem("MODE_UNSUPPORTED", "不支持此翻译方式", 422)
    config["version"] = digest(config)
    return config


def validate_input(asset, config):
    if config["mode"] != "redraw":
        return
    profile = config["provider"]
    if asset.byte_size > profile["max_bytes"] or asset.width * asset.height > profile["max_pixels"] or max(asset.width, asset.height) > profile["max_dimension"]:
        problem("IMAGE_TOO_LARGE", "此图片超出当前图片模型尺寸限制，请使用较小图片", 413)
    if asset.mime not in profile["input_formats"]:
        problem("PROVIDER_CAPABILITY_UNSUPPORTED", "此模型不支持图片格式", 422)
