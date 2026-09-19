"""Versioned operator configuration; no credentials are part of this document."""
from typing import Literal
from pydantic import Field
from .request_models import RequestBody

from .languages import Language


class NodeConfig(RequestBody):
    schema_version: Literal[1] = 1
    execution_slots: int = Field(default=1, ge=1, le=32, strict=True)
    poll_seconds: float = Field(default=20, ge=1, le=30, allow_inf_nan=False)
    heartbeat_seconds: float = Field(default=10, ge=.1, le=30, allow_inf_nan=False)
    request_seconds: float = Field(default=30, ge=1, le=120, allow_inf_nan=False)
    page_seconds: float = Field(default=900, ge=10, le=3600, allow_inf_nan=False)
    text_wait_seconds: float = Field(default=600, ge=10, le=3600, allow_inf_nan=False)
    delivery_seconds: float = Field(default=120, ge=10, le=600, allow_inf_nan=False)
    allowed_languages: list[Language] = Field(default_factory=lambda: ['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko'], min_length=1, max_length=16)


def default_config():
    return NodeConfig().model_dump(exclude_none=True)
