"""Atomic, expiring admission state; persistent jobs and receipts stay in SQL."""
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from redis import Redis, RedisError
from redis.backoff import NoBackoff
from redis.retry import Retry
from .config import settings


class AdmissionUnavailable(Exception):
    code = 'ADMISSION_UNAVAILABLE'
    def __init__(self):
        super().__init__(self.code)  # Never expose Redis URLs, credentials or command arguments.


@lru_cache
def client():
    return Redis.from_url(settings().redis_url.get_secret_value(), decode_responses=True,
        socket_connect_timeout=1, socket_timeout=1, max_connections=64,
        retry=Retry(NoBackoff(), 0), health_check_interval=30)


def key(scope, identity=''):
    return f'{settings().redis_namespace}:{{admission}}:{scope}:{identity}'


def _clock_ms():
    """Empty in production: every script uses the Redis server's clock."""
    return ''


@lru_cache
def script_source(name):
    return (Path(__file__).parent / 'redis_scripts' / (name + '.lua')).read_text(encoding='utf-8')


def run(name, keys, *args):
    try:
        return client().register_script(script_source(name))(keys=keys, args=[_clock_ms(), *args])
    except RedisError:
        raise AdmissionUnavailable() from None


def command(name, *args, **kwargs):
    try:
        return getattr(client(), name)(*args, **kwargs)
    except RedisError:
        raise AdmissionUnavailable() from None


def datetime_ms(value):
    return datetime.fromtimestamp(float(value) / 1000, timezone.utc).replace(tzinfo=None)


def window(scope, identity, limit, *, member='', seconds=60):
    used, retry, at, last = run('window', [key(scope, identity)], limit, seconds * 1000, member)
    return {'window_seconds': seconds, 'limit': limit, 'used': used, 'remaining': max(0, limit - used),
        'retry_after_seconds': retry, 'last_request_at': datetime_ms(last).isoformat() + 'Z' if last else None}


def release_window(scope, identity, member):
    command('zrem', key(scope, identity), member)


def bucket(scope, identity, rate, burst, *, member='', concurrency=0, lease_seconds=60, daily=0):
    result = run('bucket', [key(scope, identity), key(scope + '-leases', identity), key(scope + '-receipts', identity)],
        rate, burst, concurrency, lease_seconds * 1000, member, daily)
    allowed, retry, tokens, at, active, receipts, day, reason = result
    return {'allowed': bool(allowed), 'retry_after_seconds': retry, 'recorded_tokens': float(tokens),
        'refilled_at': datetime_ms(at), 'active_leases': active, 'daily_receipts': receipts,
        'day_started_at': datetime_ms(day), 'reason': reason}
