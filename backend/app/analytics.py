"""Bounded, best-effort relay for consented extension analytics, never business facts."""
import asyncio
from collections import OrderedDict
import hashlib
import hmac
import json
import logging
import re
import secrets
from threading import Lock
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
import httpx
from pydantic import Field, ValidationError

from .config import settings
from .request_models import RequestBody


router = APIRouter(prefix='/v1/analytics', tags=['analytics'])
logger = logging.getLogger(__name__)
COLLECT_URL = 'https://www.google-analytics.com/mp/collect'
MAX_BODY_BYTES = 16 * 1024
MAX_AGE_SECONDS = 72 * 60 * 60
UUID_PATTERN = r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'


class Event(RequestBody):
    event_id: str = Field(pattern=UUID_PATTERN)
    name: str = Field(min_length=1, max_length=40)
    params: dict[str, Any] = Field(default_factory=dict, max_length=40)
    timestamp_micros: int = Field(strict=True, gt=0, le=9_007_199_254_740_991)


class EventBatch(RequestBody):
    client_id: str = Field(pattern=UUID_PATTERN)
    session_id: int = Field(strict=True, ge=1_577_836_800, le=9_999_999_999)
    events: list[Event] = Field(min_length=1, max_length=20)


# The endpoint reads a bounded stream before validation, so describe its body explicitly.
# Inline this one nested definition: its Pydantic #/$defs reference is not an OpenAPI root ref.
BATCH_SCHEMA = EventBatch.model_json_schema()
BATCH_SCHEMA['properties']['events']['items'] = BATCH_SCHEMA.pop('$defs')['Event']


LANGUAGES = {'en', 'ja', 'ko', 'fr', 'es', 'pt-BR', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id'}
ENUMS = {
    'browser': {'chrome', 'edge', 'firefox', 'other'},
    'ui_language': LANGUAGES | {'zh-CN', 'zh-TW'},
    'surface': {'reader', 'popup', 'options', 'inline'},
    'screen': {'library', 'discover', 'search', 'sites', 'downloads', 'settings', 'account', 'reader'},
    'source_type': {'local', 'website', 'google_drive', 'unknown'},
    'format': {'cbz', 'zip', 'cbr', 'rar', 'pdf', 'mobi', 'website', 'unknown'},
    'entry_point': {'library', 'search', 'discover', 'popup', 'context_menu', 'inline', 'downloads', 'settings', 'other'},
    'method': {'manual', 'automatic'},
    'outcome': {'success', 'failed', 'duplicate', 'cancelled', 'empty', 'partial', 'blocked', 'no_text'},
    'channel': {'official', 'local'},
    'mode': {'original', 'classic', 'redraw', 'compare'},
    'layout': {'continuous', 'single'},
    'search_mode': {'direct', 'translated'},
    'error_code': {'network', 'permission', 'auth', 'quota', 'rate_limit', 'timeout', 'source_unavailable', 'unsupported', 'cancelled', 'unknown'},
    'target_language': LANGUAGES | {'zh-Hans', 'zh-Hant'},
}
COUNTS = {'count', 'page_count', 'pages_viewed', 'result_count'}
DURATIONS = {'duration_ms', 'active_ms', 'engagement_time_msec'}
COMMON_PARAMS = {'browser', 'extension_version', 'ui_language', 'surface'}
READING_PARAMS = {'source_type', 'format', 'layout', 'mode', 'target_language'}
TRANSLATION_PARAMS = {'channel', 'mode', 'target_language', 'method'}
EVENT_PARAMS = {
    'page_view': {'screen'},
    'extension_first_use': set(),
    'import_started': {'source_type', 'format', 'count'},
    'import_result': {'source_type', 'format', 'outcome', 'count', 'duration_ms', 'error_code'},
    'search_started': {'search_mode'},
    'search_result': {'search_mode', 'outcome', 'result_count', 'duration_ms'},
    'reader_open': READING_PARAMS | {'page_count'},
    'reading_summary': READING_PARAMS | {'active_ms', 'pages_viewed', 'engagement_time_msec'},
    'reading_engaged': READING_PARAMS | {'active_ms', 'pages_viewed'},
    'reader_activated': READING_PARAMS | {'active_ms', 'pages_viewed'},
    'translation_requested': TRANSLATION_PARAMS,
    'translation_viewed': TRANSLATION_PARAMS | {'duration_ms'},
    'translation_view_changed': {'mode', 'channel', 'target_language'},
    'offline_download_result': {'source_type', 'outcome', 'count', 'duration_ms'},
    'quota_blocked': {'channel', 'mode'},
    'upgrade_click': {'entry_point'},
}


def clean_params(event: Event) -> dict[str, str | int]:
    result = {}
    for key in COMMON_PARAMS | EVENT_PARAMS[event.name]:
        value = event.params.get(key)
        if key in ENUMS and isinstance(value, str) and value in ENUMS[key]:
            result[key] = value
        elif key == 'extension_version' and isinstance(value, str) and len(value) <= 32 and re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', value):
            result[key] = value
        elif key in COUNTS and type(value) is int and 0 <= value <= 10_000:
            result[key] = value
        elif key in DURATIONS and type(value) is int and 0 <= value <= 86_400_000:
            result[key] = value
    if event.name == 'page_view' and 'screen' in result:
        result['page_location'] = 'https://extension.nodelane.invalid/' + result['screen']
        result['page_title'] = 'NodeLane Extension - ' + result['screen']
    return result


class RelayGuard:
    """Per-process limits. No account identifiers, persistence, or raw IP retention."""
    max_buckets = 4096
    max_seen = 20_000
    dedupe_seconds = 24 * 60 * 60
    max_in_flight = 8

    def __init__(self):
        self.lock = Lock()
        self.salt = secrets.token_bytes(32)
        self.buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()
        self.seen: OrderedDict[tuple[str, str], float] = OrderedDict()
        self.in_flight = 0

    def _take(self, key: str, capacity: int, refill: float, cost: int, now: float) -> bool:
        tokens, at = self.buckets.pop(key, (float(capacity), now))
        tokens = min(float(capacity), tokens + max(0, now - at) * refill)
        allowed = tokens >= cost
        self.buckets[key] = (tokens - cost if allowed else tokens, now)
        while len(self.buckets) > self.max_buckets:
            self.buckets.popitem(last=False)
        return allowed

    def admit(self, batch: EventBatch, ip: str, now: float) -> list[Event] | None:
        ip_key = hmac.new(self.salt, ip.encode(), hashlib.sha256).hexdigest()
        with self.lock:
            # Charge even unknown/stale/replayed events; rotating client IDs cannot evade IP limits.
            # Rejected clients must not consume other clients' global delivery budget.
            for key, capacity, refill, cost in (
                ('ip:' + ip_key, 120, 2, 1),
                ('client:' + batch.client_id, 30, .5, 1),
                ('events:' + batch.client_id, 300, 5, len(batch.events)),
                ('global', 600, 100, len(batch.events)),
            ):
                if not self._take(key, capacity, refill, cost, now):
                    raise HTTPException(
                        429,
                        detail={'code': 'ANALYTICS_RATE_LIMITED', 'message': '分析请求过于频繁'},
                        headers={'Retry-After': '10'},
                    )
            if self.in_flight >= self.max_in_flight:
                return None
            while self.seen and next(iter(self.seen.values())) <= now - self.dedupe_seconds:
                self.seen.popitem(last=False)
            accepted = []
            for event in batch.events:
                at = event.timestamp_micros / 1_000_000
                key = (batch.client_id, event.event_id)
                if event.name not in EVENT_PARAMS or not now - MAX_AGE_SECONDS <= at <= now + 300 or key in self.seen:
                    continue
                self.seen[key] = now
                accepted.append(event)
            while len(self.seen) > self.max_seen:
                self.seen.popitem(last=False)
            if accepted:
                self.in_flight += 1
            return accepted

    def release(self):
        with self.lock:
            self.in_flight -= 1


guard = RelayGuard()


def make_transport() -> httpx.AsyncBaseTransport:
    # Direct transport avoids AsyncClient's INFO log containing the API secret query.
    return httpx.AsyncHTTPTransport(retries=0)


def build_payload(batch: EventBatch, events: list[Event]) -> dict[str, Any]:
    """Keep production and the non-collecting validation tool on the same payload contract."""
    # GA4's strict Web stream validator requires <number>.<number>, not a UUID.
    # Derive two 32-bit numbers from the random local install ID; no account identity is used.
    digest = hashlib.sha256(batch.client_id.encode('ascii')).digest()
    ga_client_id = f'{int.from_bytes(digest[:4], "big")}.{int.from_bytes(digest[4:8], "big")}'
    return {
        'client_id': ga_client_id,
        'consent': {'ad_user_data': 'DENIED', 'ad_personalization': 'DENIED'},
        'events': [{
            'name': event.name,
            'timestamp_micros': event.timestamp_micros,
            'params': {**clean_params(event), 'session_id': batch.session_id},
        } for event in events],
    }


async def send_events(batch: EventBatch, events: list[Event]):
    cfg = settings()
    payload = build_payload(batch, events)
    if cfg.ga4_debug_mode and cfg.app_env != 'production':
        for event in payload['events']:
            event['params']['debug_mode'] = True
    request = httpx.Request('POST', COLLECT_URL,
        params={'measurement_id': cfg.ga4_extension_measurement_id, 'api_secret': cfg.ga4_extension_api_secret.get_secret_value()},
        json=payload, extensions={'timeout': {'connect': 1., 'read': 1., 'write': 1., 'pool': .5}})
    try:
        async with asyncio.timeout(2):
            async with make_transport() as transport:
                response = await transport.handle_async_request(request)
                try:
                    if not 200 <= response.status_code < 300:
                        logger.warning('Analytics relay upstream rejected request')
                finally:
                    await response.aclose()
    except (httpx.HTTPError, TimeoutError):
        # Neither exception text nor URL/body may be logged (secret, client ID, private input).
        logger.warning('Analytics relay delivery unavailable')


@router.post('/events', status_code=204, response_class=Response,
    summary='Receive consented extension analytics',
    description='Public, best-effort extension telemetry only. Accepts up to 20 events and 16 KiB; '
        'unknown events, private or unrecognized parameters and stale events are discarded. '
        'No account authorization or identifiers are used. A 204 does not confirm Google Analytics ingestion.',
    responses={204: {'description': 'Best-effort processing finished; also returned when analytics is disabled'},
        408: {'description': 'Request body timeout'}, 413: {'description': 'Request exceeds 16 KiB'},
        415: {'description': 'JSON content type required'}, 422: {'description': 'Invalid event envelope'},
        429: {'description': 'Process-local rate limit exceeded; see Retry-After'}},
    openapi_extra={'security': [], 'requestBody': {'required': True,
        'content': {'application/json': {'schema': BATCH_SCHEMA}}}})
async def collect(request: Request):
    cfg = settings()
    if not cfg.ga4_enabled or not cfg.ga4_extension_measurement_id or not cfg.ga4_extension_api_secret.get_secret_value():
        return Response(status_code=204)
    if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
        raise HTTPException(415, detail={'code': 'ANALYTICS_CONTENT_TYPE', 'message': '需要 JSON 请求'})
    raw = bytearray()
    try:
        async with asyncio.timeout(5):
            async for chunk in request.stream():
                if len(raw) + len(chunk) > MAX_BODY_BYTES:
                    raise HTTPException(413, detail={'code': 'ANALYTICS_BODY_TOO_LARGE', 'message': '分析请求超过大小限制'})
                raw.extend(chunk)
    except TimeoutError:
        raise HTTPException(408, detail={'code': 'ANALYTICS_BODY_TIMEOUT', 'message': '分析请求超时'}) from None
    try:
        batch = EventBatch.model_validate(json.loads(raw))
    except (ValidationError, ValueError, UnicodeError, RecursionError):
        raise HTTPException(422, detail={'code': 'ANALYTICS_INVALID', 'message': '分析请求格式无效'}) from None
    now = time.time()
    if batch.session_id > now + 300:
        raise HTTPException(422, detail={'code': 'ANALYTICS_INVALID', 'message': '分析会话时间无效'})
    events = guard.admit(batch, request.client.host if request.client else '', now)
    if events:
        try:
            await send_events(batch, events)
        finally:
            guard.release()
    # No durable queue or GA delivery acknowledgement. A 204 is only best-effort acceptance.
    return Response(status_code=204)
