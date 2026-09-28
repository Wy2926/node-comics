"""Shared supplier RPM, atomically reserved in Redis without a database lock."""
from .adapters.llm import TextError
from .models import uid
from .redis_state import AdmissionUnavailable, window, release_window, run, key

UNSTARTED_ERRORS = frozenset({'TEXT_PROVIDER_DISABLED', 'TEXT_PROVIDER_UNAVAILABLE',
    'TEXT_PROVIDER_REVISION_INVALID', 'TEXT_CHANNEL_UNSUPPORTED'})


def reserve_request(provider, request_id=None):
    request_id = request_id or uid()
    try:
        budget = window('provider', provider.id, provider.requests_per_minute, member=request_id)
    except AdmissionUnavailable:
        raise TextError('ADMISSION_UNAVAILABLE', '请求准入服务暂时不可用', retryable=True, retry_after=2) from None
    if budget['retry_after_seconds']:
        raise TextError('TEXT_RATE_LIMITED', '供应商上游请求已达到每分钟上限',
            retryable=True, retry_after=budget['retry_after_seconds'])
    return request_id


def release_unstarted_request(provider_id, request_id, error):
    if getattr(error, 'code', None) in UNSTARTED_ERRORS:
        try:
            release_window('provider', provider_id, request_id)
        except AdmissionUnavailable:
            pass  # Conservative failed refund expires within the window.


def unavailable_providers(providers):
    """One Redis round trip for a precheck; calls still reserve atomically."""
    if not providers:
        return []
    try:
        available = run('provider_capacity', [key('provider', p.id) for p in providers],
            *[p.requests_per_minute for p in providers])
    except AdmissionUnavailable:
        return [p.id for p in providers]
    return [p.id for p, ready in zip(providers, available) if not ready]
