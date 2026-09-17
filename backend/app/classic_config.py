"""Immutable, secret-free classic stage configuration and cache identity."""
from .config import settings
from .errors import problem
from .translation_providers import selected_provider, text_profile


def enabled(db):
    return bool(settings().classic_enabled and selected_provider(db))


def snapshot(db, provider_id=None):
    cfg = settings()
    if not cfg.classic_enabled:
        problem('CLASSIC_NOT_CONFIGURED', '常规翻译引擎尚未启用', 503)
    text = text_profile(db, provider_id)
    return {"mode": "classic", "prompt_version": "translation-channels-v1",
            "provider": {"id": text["provider_id"], "timeout_seconds": cfg.classic_timeout_seconds},
            "engine": {"version": cfg.classic_engine_version, "detector": "default", "ocr": "48px",
                       "inpainter": "lama_large", "detection_size": 1536, "inpainting_size": 512,
                       "inpainting_strategy": "masked-crops-v1", "inpainting_padding": 48, "inpainting_merge_gap": 24,
                       "mask_dilation": 3, "font_minimum": 10, "font": "NotoSansMonoCJK-VF@b861b923e105+NotoSans@b85c38ecea8a",
                       "reading_order": "rtl", "render_version": "masked-png-v6-roi-mtu-f0307a0-qt611-noto-b85c38ec",
                       "bubble_detector": "ballons-translator@84ba500ea1a4"},
            "stage_attempts": cfg.cluster_stage_attempts,
            "text": text}
