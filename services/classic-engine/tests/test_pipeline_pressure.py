import pytest
from tools.validate_pipeline_pressure import exercise, FixtureRuntime


@pytest.mark.parametrize('scenario', ['text', 'upload', 'mixed'])
@pytest.mark.parametrize('local_pages', [1, 8])
def test_eight_leases_four_uploads_keep_making_progress(tmp_path, scenario, local_pages):
    result = exercise(tmp_path, scenario, local_pages=local_pages, timeout=30)
    assert result['completed'] == 24 and result['journal_empty']
    assert sum(result['claim_batches']) == 24 and max(result['claim_batches']) <= 4
    if scenario == 'upload':
        assert result['network_peak']['upload'] == 4
    if scenario == 'mixed':
        assert result['blocked_snapshot']['completed'] == 19
        spans = result['stage_spans']
        network = [span for span in spans if span['stage'] in {'download', 'analysis_submit', 'deliver'}]
        compute = [span for span in spans if span['stage'] in {'analyze', 'inpaint', 'render'}]
        assert any(left['lease_id'] != right['lease_id'] and left['start_s'] < right['end_s']
                   and right['start_s'] < left['end_s'] for left in network for right in compute)


def test_throughput_accepts_unchanged_pages_without_upload_or_duplicate_settlement(tmp_path):
    from classic_node.protocol import pack_result
    class OriginalRuntime(FixtureRuntime):
        def render(self, original, cleaned, analysis, translated, language, alpha, **kwargs):
            return pack_result(original, original, alpha, self.version, analysis, translated)
    result = exercise(tmp_path, 'throughput', OriginalRuntime(), total=8, timeout=15)
    assert result['completed'] == 8 and result['journal_empty']
    assert all(page['output_bytes'] == 0 for page in result['page_profiles'])
    assert result['network_peak'].get('upload', 0) == 0


def test_measurement_fails_immediately_on_a_stage_error(tmp_path):
    class BrokenRuntime(FixtureRuntime):
        def inpaint(self, *args, **kwargs):
            raise RuntimeError('private fixture details')
    with pytest.raises(AssertionError, match='inpaint') as failure:
        exercise(tmp_path, 'throughput', BrokenRuntime(), total=8, timeout=15)
    assert 'private fixture details' not in str(failure.value)
