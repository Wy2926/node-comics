"""Routing is stable across processes and independent of HTTP scheduling."""
from collections import Counter
import pytest
from app.translation_routing import choose_provider


def test_weighted_shares_ignore_order_and_zero_weights():
    weights = {'a': 3, 'b': 1, 'excluded': 0}
    keys = [f'input-{index}' for index in range(4000)]
    selected = [choose_provider(weights, key) for key in keys]
    assert selected == [choose_provider(dict(reversed(list(weights.items()))), key) for key in keys]
    assert selected == [choose_provider({'a': 30, 'b': 10}, key) for key in keys]
    counts = Counter(selected)
    assert counts.keys() == {'a', 'b'}
    assert 2850 < counts['a'] < 3150
    assert choose_provider({'excluded': 0, 'only': 1}, 'input') == 'only'
    with pytest.raises(ValueError):
        choose_provider({'excluded': 0}, 'input')


def test_routing_strategy_can_be_extended_without_supplier_or_worker_changes(monkeypatch):
    from app.translation_routing import STRATEGIES
    monkeypatch.setitem(STRATEGIES, 'synthetic', lambda weights, key: next(iter(weights)))
    assert choose_provider({'a': 1, 'b': 1}, 'input', strategy='synthetic') == 'a'
