import json
import pytest

from classic_node.config import load


def configuration():
    return {'protocol_version': 3, 'control_url': 'https://control.example.test',
            'node_id': 'fixture', 'node_token': 'fixture', 'resource_id': 'fixture:cuda:0'}


@pytest.fixture
def cpu_capacity(monkeypatch):
    value = {'logical_cpus': 16, 'affinity_cpus': 16, 'cpuset_cpus': 16, 'quota_cpus': 11.5,
             'effective_cpus': 11.5, 'budget_cpus': 11, 'warnings': []}
    monkeypatch.setattr('classic_node.resources.detect_cpu_capacity', lambda: dict(value))
    return value


@pytest.mark.parametrize('workers', [0, -1, 17, 9, True, 1.5, '2', 'Auto', None])
def test_invalid_render_capacity_is_rejected(tmp_path, workers):
    config = configuration()
    config['render_workers'] = workers
    path = tmp_path / 'node.json'
    path.write_text(json.dumps(config))
    with pytest.raises(ValueError, match='render_workers'):
        load(path)


def test_missing_cpu_configuration_resolves_auto_counts(tmp_path, cpu_capacity):
    config = configuration()
    path = tmp_path / 'node.json'
    path.write_text(json.dumps(config))
    resolved = load(path)
    assert resolved['engine']['threads'] == 3 and resolved['render_workers'] == 5
    assert resolved['_render_threads'] == resolved['_cpu_resources']['render_threads'] == 1
    assert resolved['_cpu_resources']['allocated_cpu_slots'] == 11
    assert resolved['_cpu_resources']['mixed_render_cpu_slots'] == 13
    assert not resolved['_cpu_resources']['oversubscribed'] and resolved['_cpu_resources']['warnings'] == []
    assert 'render_threads' not in resolved['engine']  # Execution policy, not model/output identity.


@pytest.mark.parametrize('threads,workers,expected', [
    ('auto', 'auto', (3, 5, 1)), ('auto', 3, (2, 3, 2)), ('auto', 1, (3, 1, 3)),
    (2, 'auto', (2, 7, 1)), (3, 2, (3, 2, 2)), (12, 4, (12, 4, 1)), (12, 1, (12, 1, 12))])
def test_cpu_budget_combines_model_pages_and_render_native_threads(tmp_path, cpu_capacity, threads, workers, expected):
    config = {**configuration(), 'engine': {'threads': threads}, 'render_workers': workers}
    path = tmp_path / 'node.json'
    path.write_text(json.dumps(config))
    resolved = load(path)
    result = resolved['_cpu_resources']
    assert (resolved['engine']['threads'], resolved['render_workers'], result['render_threads']) == expected
    assert result['allocated_cpu_slots'] == 2 * expected[0] + expected[1] * expected[2]
    assert result['mixed_render_cpu_slots'] == 2 * expected[0] + max(expected[1] * expected[2],
                                                                 (expected[1] - 1) * expected[2] + expected[0])
    assert bool(result['warnings']) == result['oversubscribed'] == (result['allocated_cpu_slots'] > 11.5)


@pytest.mark.parametrize('workers', ['auto', 24])
def test_render_processes_are_bounded_by_leases_not_a_fixed_sixteen_worker_cap(tmp_path, cpu_capacity, workers):
    cpu_capacity.update(logical_cpus=128, affinity_cpus=128, cpuset_cpus=None, quota_cpus=None,
                        effective_cpus=128, budget_cpus=128)
    config = {**configuration(), 'max_leases': 32, 'engine': {'threads': 2}, 'render_workers': workers}
    path = tmp_path / 'node.json'
    path.write_text(json.dumps(config))
    resolved = load(path)
    assert resolved['engine']['threads'] == 2
    assert resolved['render_workers'] == (32 if workers == 'auto' else 24)
    assert resolved['_cpu_resources']['render_threads'] == (3 if workers == 'auto' else 5)


def test_small_cpu_quota_preserves_minimum_work_and_warns_without_rewriting_pages(tmp_path, cpu_capacity):
    cpu_capacity.update(quota_cpus=.5, effective_cpus=.5, budget_cpus=1, warnings=['fixture unreadable ancestor'])
    path = tmp_path / 'node.json'
    path.write_text(json.dumps(configuration()))
    resolved = load(path)
    assert resolved['local_pages'] == 2 and resolved['engine']['threads'] == resolved['render_workers'] == 1
    assert resolved['_cpu_resources']['render_threads'] == 1
    assert resolved['_cpu_resources']['oversubscribed']
    assert len(resolved['_cpu_resources']['warnings']) == 2
    assert cpu_capacity['warnings'] == ['fixture unreadable ancestor']


@pytest.mark.parametrize('threads', [0, -1, True, 1.5, '2', 'Auto', None])
def test_invalid_analysis_thread_counts_are_rejected(tmp_path, threads):
    path = tmp_path / 'node.json'
    path.write_text(json.dumps({**configuration(), 'engine': {'threads': threads}}))
    with pytest.raises(ValueError, match='engine.threads'):
        load(path)


@pytest.mark.parametrize('field', ['local_pages', 'max_leases'])
@pytest.mark.parametrize('value', [True, 2.5, '2', 0, 33])
def test_page_budget_requires_integer_protocol_limits(tmp_path, field, value):
    path = tmp_path / 'node.json'
    path.write_text(json.dumps({**configuration(), field: value}))
    with pytest.raises(ValueError, match='local_pages'):
        load(path)
