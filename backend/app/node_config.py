"""Versioned operator configuration; no credentials are part of this document."""
from typing import Literal
from pydantic import Field
from .request_models import RequestBody

from .languages import Language


class EngineOverrides(RequestBody):
    languages: list[Language] | None = Field(default=None, min_length=1, max_length=16)
    torch_threads: int | None = Field(default=None, ge=1, le=128, strict=True)
    opencv_threads: int | None = Field(default=None, ge=1, le=128, strict=True)
    cache_bytes: int | None = Field(default=None, ge=0, le=8 * 1024**3, strict=True)
    cache_ttl_seconds: int | None = Field(default=None, ge=0, le=86400, strict=True)


class NodeConfig(RequestBody):
    schema_version: Literal[1] = 1
    execution_slots: int = Field(default=1, ge=1, le=32, strict=True)
    poll_seconds: float = Field(default=1, ge=.05, le=30, allow_inf_nan=False)
    heartbeat_seconds: float = Field(default=10, ge=.1, le=30, allow_inf_nan=False)
    config_poll_seconds: float = Field(default=15, ge=1, le=60, allow_inf_nan=False)
    request_seconds: float = Field(default=30, ge=1, le=120, allow_inf_nan=False)
    stage_seconds: float = Field(default=900, ge=10, le=3600, allow_inf_nan=False)
    input_cache_bytes: int = Field(default=128 * 1024**2, ge=0, le=8 * 1024**3, strict=True)
    input_cache_ttl_seconds: int = Field(default=900, ge=0, le=86400, strict=True)
    engine: EngineOverrides = Field(default_factory=EngineOverrides)


def default_config():
    return NodeConfig().model_dump(exclude_none=True)
