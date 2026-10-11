"""Document admission races against the explicitly isolated PostgreSQL database."""
import os
import pytest
from test_postgres_concurrency import pg_scope  # noqa: F401
from test_compute_v3_postgres import client  # noqa: F401
from test_document_quota_api import (document_case,  # noqa: F401
    test_cancel_races_reservation_with_one_serialized_winner,
    test_parallel_documents_compete_for_total_balance_not_individual_buckets,
    test_multi_bucket_reservation_rolls_back_as_one_transaction,
    test_multi_bucket_settlement_exactly_once_original_buckets_and_no_text,
    test_model_scope_cannot_borrow_rights_from_another_bucket,
    test_paid_unlimited_tracks_all_200_processing_pages_without_finite_bucket)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')
