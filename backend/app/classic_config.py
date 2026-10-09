"""Immutable, secret-free classic stage configuration and cache identity."""
from .config import settings
from .adapters.text import PROMPT_VERSION
from .errors import problem
from .translation_providers import has_provider, provider_resolver


def enabled(db, *, plan_id='free'):
    return bool(settings().classic_enabled and has_provider(db, plan_id=plan_id))


def snapshot_resolver(db, provider_id=None, *, plan_id='free'):
    cfg = settings()
    if not cfg.classic_enabled:
        problem('CLASSIC_NOT_CONFIGURED', '常规翻译引擎尚未启用', 503)
    profile = provider_resolver(db, provider_id, plan_id=plan_id)

    def resolve(routing_key=''):
        return profile_snapshot(profile(routing_key))
    return resolve


def profile_snapshot(text):
    cfg = settings()
    if not cfg.classic_enabled:
        problem('CLASSIC_NOT_CONFIGURED', '常规翻译引擎尚未启用', 503)
    return {"mode": "classic", "prompt_version": PROMPT_VERSION,
            "provider": {"id": text["provider_id"], "timeout_seconds": cfg.classic_timeout_seconds},
            "engine": {"protocol_version": 3}, "stage_attempts": cfg.cluster_stage_attempts, "text": text}


def snapshot(db, provider_id=None, *, routing_key='', plan_id='free'):
    return snapshot_resolver(db, provider_id, plan_id=plan_id)(routing_key)
