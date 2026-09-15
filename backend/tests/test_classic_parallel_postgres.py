"""Run the same controlled branch races against an isolated PostgreSQL schema."""
import os

import pytest
from test_postgres_concurrency import pg_scope
from test_classic import configured
from test_classic_parallel import (
    test_branches_overlap_and_render_waits_for_both_checkpoints,
    test_local_failure_stops_new_groups_and_recovery_reuses_successful_text,
    test_text_failure_joins_local_work_and_never_renders,
    test_cancel_or_delete_during_both_branches_discards_late_images_and_accounts_text,
    test_old_inpaint_reply_cannot_replace_new_attempt_checkpoint,
    test_invalid_cleaned_background_never_reaches_render,
)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
                                reason='Requires the dedicated PostgreSQL concurrency-test database')


@pytest.fixture
def client(pg_scope, monkeypatch):
    monkeypatch.setenv('RESULT_STORAGE_BACKEND', 'local')
    from app.config import settings
    settings.cache_clear()
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as client:
        yield client
