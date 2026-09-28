"""Text routing strategies, independent of suppliers, credentials and execution.

A stable input key keeps page lookups and cross-account result reuse on the
same provider. Weights describe long-run shares of distinct inputs,
not a strict sequence of HTTP requests or an upstream concurrency allocation.
"""
from hashlib import sha256


def weighted(weights: dict[str, int], key: str) -> str:
    candidates = sorted((provider, weight) for provider, weight in weights.items() if weight > 0)
    total = sum(weight for _, weight in candidates)
    if not total:
        raise ValueError('No weighted translation providers')
    position = int.from_bytes(sha256(key.encode()).digest(), 'big') * total // (1 << 256)
    for provider, weight in candidates:
        if position < weight:
            return provider
        position -= weight
    raise AssertionError('Invalid routing weights')


STRATEGIES = {'weighted': weighted}


def choose_provider(weights: dict[str, int], key: str, *, strategy='weighted') -> str:
    return STRATEGIES[strategy](weights, key)
