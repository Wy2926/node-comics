"""Immutable, secret-free classic stage configuration and cache identity."""
from .config import settings
from .adapters.text import PROMPT_VERSION
from .errors import problem
from .translation_providers import selected_provider, provider_profile


def enabled(db):
    return bool(settings().classic_enabled and selected_provider(db))


def snapshot(db, provider_id=None):
    cfg = settings()
    if not cfg.classic_enabled:
        problem('CLASSIC_NOT_CONFIGURED', '常规翻译引擎尚未启用', 503)
    text = provider_profile(db, provider_id)
    return {"mode": "classic", "prompt_version": PROMPT_VERSION,
            "provider": {"id": text["provider_id"], "timeout_seconds": cfg.classic_timeout_seconds},
            "engine": {"version": cfg.classic_engine_version, "protocol_version": 2},
            "stage_attempts": cfg.cluster_stage_attempts,
            "text": text}
