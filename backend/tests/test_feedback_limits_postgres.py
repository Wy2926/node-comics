"""Independent API sessions cannot race feedback budgets or idempotency on PostgreSQL."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from fastapi import HTTPException
import pytest
from sqlalchemy import func, select
from test_postgres_concurrency import pg_scope, pytestmark
from test_feedback_limits import seed_feedback_job
from conftest import configure_system_limits


@pytest.fixture
def feedback_database(pg_scope, png, monkeypatch):
    from app import feedback_limits
    from app.db import initialize, session_factory
    from app.models import User, now
    initialize()
    stamp = now()
    monkeypatch.setattr(feedback_limits, "now", lambda: stamp)
    with session_factory()() as db:
        db.add_all([User(id="feedback-owner", subject="isolated:feedback", name="Owner"),
                    User(id="other-owner", subject="isolated:other", name="Other")])
        db.commit()
    return seed_feedback_job("feedback-owner", png), seed_feedback_job("other-owner", png)


def race_feedback(job_id, keys, comments=None):
    from app.db import session_factory
    from app.reader_api import FeedbackRequest, submit_feedback
    gate = Barrier(len(keys))
    def submit(index):
        with session_factory()() as db:
            gate.wait(timeout=10)
            try:
                result = submit_feedback(job_id, FeedbackRequest(issues=["meaning"],
                    comment=comments[index] if comments else "same content"), keys[index],
                    SimpleNamespace(id="feedback-owner"), db)
                return 201, result["id"]
            except HTTPException as error:
                if error.status_code == 429:
                    assert int(error.headers["Retry-After"]) > 0
                return error.status_code, error.detail["code"]
    with ThreadPoolExecutor(len(keys)) as pool:
        return list(pool.map(submit, range(len(keys))))


@pytest.mark.parametrize("budget,expected_error", [
    ("feedback_request_burst", "FEEDBACK_RATE_LIMITED"),
    ("feedback_receipts_per_day", "FEEDBACK_DAILY_LIMIT"),
])
def test_independent_sessions_share_feedback_limits(feedback_database, budget, expected_error):
    from app.config import settings
    from app.db import session_factory
    from app.feedback_models import FeedbackAdmission
    from app.reader_api import Feedback, FeedbackRequest, submit_feedback
    configure_system_limits(**{"feedback_request_burst": 20, budget: 3})
    job_id, other_job = feedback_database
    results = race_feedback(job_id, [f"new-{index}" for index in range(8)])
    assert sum(status == 201 for status, _ in results) == 3
    assert [code for status, code in results if status != 201] == [expected_error] * 5
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Feedback)) == 3
        assert db.scalar(select(func.count()).select_from(FeedbackAdmission)) == 1
        assert db.get(FeedbackAdmission, "feedback-owner").daily_receipts == 3
        result = submit_feedback(other_job, FeedbackRequest(issues=["meaning"]), "other",
                                 SimpleNamespace(id="other-owner"), db)
        assert result["job_id"] == other_job


def test_concurrent_replay_creates_exactly_one_receipt(feedback_database):
    from app.config import settings
    from app.db import session_factory
    from app.feedback_models import FeedbackAdmission
    from app.reader_api import Feedback
    configure_system_limits(feedback_request_burst=1, feedback_receipts_per_day=1)
    results = race_feedback(feedback_database[0], ["shared-key"] * 8)
    assert {status for status, _ in results} == {201}
    assert len({receipt_id for _, receipt_id in results}) == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Feedback)) == 1
        row = db.get(FeedbackAdmission, "feedback-owner")
        assert row.daily_receipts == 1 and row.request_tokens == 0


def test_concurrent_idempotency_conflict_remains_409(feedback_database):
    from app.config import settings
    configure_system_limits(feedback_request_burst=1, feedback_receipts_per_day=1)
    results = race_feedback(feedback_database[0], ["same-key"] * 2, ["first content", "other content"])
    assert sorted(status for status, _ in results) == [201, 409]
    assert next(code for status, code in results if status == 409) == "IDEMPOTENCY_CONFLICT"
