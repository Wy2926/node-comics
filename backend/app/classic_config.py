"""Immutable, secret-free classic stage configuration and cache identity."""
from urllib.parse import urlsplit
from .config import settings
from .errors import problem


def enabled():
    cfg = settings()
    return bool(cfg.classic_enabled and cfg.text_api_key and cfg.text_base_url)


def snapshot():
    cfg = settings()
    if not enabled():
        problem("CLASSIC_NOT_CONFIGURED", "常规翻译引擎或文本服务尚未配置", 503)
    url = urlsplit(cfg.text_base_url)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        problem("CLASSIC_CONFIG_INVALID", "文本服务需要不含凭据的 HTTPS 地址", 503)
    if cfg.text_protocol not in ("openai_chat", "openai_responses"):
        problem("CLASSIC_CONFIG_INVALID", "文本接口协议不支持", 503)
    if not (1 <= cfg.text_max_attempts <= 3 and 128 <= cfg.text_max_output_tokens <= 8192
            and 128 <= cfg.text_group_bytes <= 16000 and 1 <= cfg.text_input_rate <= 1000
            and 1 <= cfg.text_output_rate <= 5000 and 1 <= cfg.text_timeout_seconds <= 180
            and 1 <= cfg.cluster_stage_attempts <= 10 and 30 <= cfg.classic_timeout_seconds <= 3600
            and 0 < cfg.text_page_budget_micros <= 10_000_000):
        problem("CLASSIC_CONFIG_INVALID", "常规翻译预算或次数限制无效", 503)
    return {"mode": "classic", "prompt_version": "classic-text-v1",
            "provider": {"id": "classic-text", "timeout_seconds": cfg.classic_timeout_seconds},
            "engine": {"version": ('mit-95227a2-classic-v4-dml-v4' if cfg.classic_engine_profile == 'mit-directml' else cfg.classic_engine_version), "detector": "default", "ocr": "48px",
                       "inpainter": "lama_large", "detection_size": 1536, "inpainting_size": 512,
                       "inpainting_strategy": "masked-crops-v1", "inpainting_padding": 48, "inpainting_merge_gap": 24,
                       "mask_dilation": 3, "font_minimum": 10, "font": "NotoSansMonoCJK-VF@b861b923e105",
                       "reading_order": "rtl", "render_version": "masked-png-v2-hyphen-32b006a2"},
            "stage_attempts": cfg.cluster_stage_attempts,
            "text": {"base_url": cfg.text_base_url.rstrip("/"), "model": cfg.text_model,
                     "protocol": cfg.text_protocol, "user_agent": cfg.text_user_agent,
                     "timeout_seconds": cfg.text_timeout_seconds, "max_attempts": cfg.text_max_attempts,
                     "max_output_tokens": cfg.text_max_output_tokens, "group_bytes": cfg.text_group_bytes,
                     "page_budget_micros": cfg.text_page_budget_micros, "input_rate": cfg.text_input_rate,
                     "output_rate": cfg.text_output_rate, "pricing_version": cfg.text_pricing_version}}
