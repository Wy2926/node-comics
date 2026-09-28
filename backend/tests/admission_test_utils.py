"""Assertions against isolated Redis state, shared by SQLite and PostgreSQL tests."""
from datetime import timezone
from types import SimpleNamespace
from app import redis_state


def milliseconds(at):
    return int(at.replace(tzinfo=timezone.utc).timestamp() * 1000)


def freeze_clock(monkeypatch, clock):
    monkeypatch.setattr(redis_state, '_clock_ms', lambda: milliseconds(clock[0]))


def state_keys(scope):
    return list(redis_state.client().scan_iter(match=redis_state.key(scope, '*')))


def window_members(scope, identity=None):
    keys = [redis_state.key(scope, identity)] if identity else state_keys(scope)
    return {member: score for key in keys for member, score in redis_state.client().zrange(key, 0, -1, withscores=True)}


def window_count(scope, identity=None):
    return len(window_members(scope, identity))


def feedback_state(owner_id):
    values = redis_state.client().hgetall(redis_state.key('feedback', owner_id))
    return SimpleNamespace(daily_receipts=int(values.get('receipts', 0)),
        request_tokens=float(values.get('tokens', 0)))


def support_count():
    return sum(int(redis_state.client().hget(key, 'daily') or 0) for key in state_keys('support'))
