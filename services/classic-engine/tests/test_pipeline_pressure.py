import pytest
from tools.validate_pipeline_pressure import exercise


@pytest.mark.parametrize('scenario', ['text', 'upload', 'mixed'])
@pytest.mark.parametrize('local_pages', [1, 8])
def test_eight_leases_four_uploads_keep_making_progress(tmp_path, scenario, local_pages):
    result = exercise(tmp_path, scenario, local_pages=local_pages, timeout=30)
    assert result['completed'] == 24 and result['journal_empty']
    if scenario == 'upload':
        assert result['network_peak']['upload'] == 4
    if scenario == 'mixed':
        assert result['blocked_snapshot']['completed'] == 19
