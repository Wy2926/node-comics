"""Feedback receipts have independent, bounded account budgets and stable replays."""
from datetime import timedelta
import pytest
from sqlalchemy import func, select
from conftest import configure_system_limits, login


def seed_feedback_job(owner_id, png):
    """A synthetic completed result; no translation or external store is involved."""
    from app.assets import create_asset
    from app.db import session_factory
    from app.models import Job, now, uid
    with session_factory()() as db:
        source = create_asset(db, owner_id, png)
        output = create_asset(db, owner_id, png, kind="classic", parent_id=source.id)
        job = Job(owner_id=owner_id, input_asset_id=source.id, output_asset_id=output.id,
                  source_sha256=source.sha256, mode="classic", target_language="en",
                  status="succeeded", phase="completed", idempotency_key=uid(),
                  operation="isolated-feedback", request_hash="a" * 64, cache_key="a" * 64,
                  config={}, quota_pages=0, quota_kind="classic_daily", settlement="free",
                  completed_at=now())
        db.add(job)
        db.commit()
        return job.id


def send_feedback(client, auth, job_id, key, comment="同一条合成反馈"):
    return client.post(f"/v1/jobs/{job_id}/feedback",
                       headers={**auth, "Idempotency-Key": key},
                       json={"issues": ["meaning"], "comment": comment})


@pytest.fixture
def feedback_case(client, png, monkeypatch):
    from app import feedback_limits
    from app.models import now
    auth = login(client)
    owner_id = client.get("/v1/me", headers=auth).json()["user"]["id"]
    job_id = seed_feedback_job(owner_id, png)
    clock = [now()]
    monkeypatch.setattr(feedback_limits, "now", lambda: clock[0])
    return client, auth, owner_id, job_id, clock


def test_new_keys_cannot_create_unbounded_feedback(feedback_case):
    from app.config import settings
    from app.db import session_factory
    from app.feedback_models import FeedbackAdmission
    from app.models import Ledger
    from app.reader_api import Feedback
    client, auth, owner_id, job_id, _ = feedback_case
    configure_system_limits(feedback_request_burst=3, feedback_requests_per_minute=1)
    responses = [send_feedback(client, auth, job_id, f"new-{index}") for index in range(6)]
    assert [response.status_code for response in responses] == [201, 201, 201, 429, 429, 429]
    for response in responses[3:]:
        assert response.json()["error"]["code"] == "FEEDBACK_RATE_LIMITED"
        assert response.headers["Retry-After"] == "60"
        assert response.json()["error"]["retry_after_seconds"] == 60
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Feedback)) == 3
        assert db.scalar(select(func.count()).select_from(FeedbackAdmission)) == 1
        assert db.get(FeedbackAdmission, owner_id).daily_receipts == 3
        assert db.scalar(select(func.count()).select_from(Ledger)) == 0


def test_token_refill_and_clock_rollback(feedback_case):
    from app.config import settings
    client, auth, _, job_id, clock = feedback_case
    configure_system_limits(feedback_request_burst=1, feedback_requests_per_minute=2)
    first_time = clock[0]
    assert send_feedback(client, auth, job_id, "first").status_code == 201
    clock[0] = first_time - timedelta(seconds=60)
    assert send_feedback(client, auth, job_id, "next").status_code == 429
    clock[0] = first_time + timedelta(seconds=29)
    response = send_feedback(client, auth, job_id, "next")
    assert response.status_code == 429 and response.headers["Retry-After"] == "1"
    clock[0] = first_time + timedelta(seconds=30)
    assert send_feedback(client, auth, job_id, "next").status_code == 201


def test_replay_and_conflict_are_stable_when_both_budgets_are_exhausted(feedback_case):
    from app.config import settings
    from app.db import session_factory
    from app.feedback_models import FeedbackAdmission
    from app.reader_api import Feedback
    client, auth, owner_id, job_id, _ = feedback_case
    configure_system_limits(feedback_request_burst=1, feedback_receipts_per_day=1)
    first = send_feedback(client, auth, job_id, "stable")
    assert first.status_code == 201
    assert send_feedback(client, auth, job_id, "new").status_code == 429
    for _ in range(3):
        replay = send_feedback(client, auth, job_id, "stable")
        assert replay.status_code == 201 and replay.json() == first.json()
    conflict = send_feedback(client, auth, job_id, "stable", "不同内容")
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    with session_factory()() as db:
        row = db.get(FeedbackAdmission, owner_id)
        assert row.daily_receipts == 1 and row.request_tokens == 0
        assert db.scalar(select(func.count()).select_from(Feedback)) == 1


def test_daily_limit_resets_on_utc_day_and_replay_does_not_count_again(feedback_case):
    from app.config import settings
    from app.db import session_factory
    from app.feedback_models import FeedbackAdmission
    client, auth, owner_id, job_id, clock = feedback_case
    configure_system_limits(feedback_receipts_per_day=2)
    assert send_feedback(client, auth, job_id, "first").status_code == 201
    assert send_feedback(client, auth, job_id, "second").status_code == 201
    response = send_feedback(client, auth, job_id, "third")
    assert response.status_code == 429 and response.json()["error"]["code"] == "FEEDBACK_DAILY_LIMIT"
    assert int(response.headers["Retry-After"]) > 0
    assert send_feedback(client, auth, job_id, "first").status_code == 201
    clock[0] = (clock[0] + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    assert send_feedback(client, auth, job_id, "first").status_code == 201
    assert send_feedback(client, auth, job_id, "third").status_code == 201
    with session_factory()() as db:
        assert db.get(FeedbackAdmission, owner_id).daily_receipts == 1


def test_account_budgets_and_receipts_remain_private(feedback_case, png):
    from app.config import settings
    from app.db import session_factory
    from app.feedback_models import FeedbackAdmission
    client, auth, owner_id, job_id, _ = feedback_case
    configure_system_limits(feedback_receipts_per_day=1)
    assert send_feedback(client, auth, job_id, "same-key").status_code == 201
    assert send_feedback(client, auth, job_id, "over").status_code == 429
    other = login(client, "other-feedback-owner")
    other_id = client.get("/v1/me", headers=other).json()["user"]["id"]
    other_job = seed_feedback_job(other_id, png)
    assert send_feedback(client, other, job_id, "same-key").status_code == 404
    assert send_feedback(client, other, other_job, "same-key").status_code == 201
    assert client.get("/v1/me/feedback", headers=other).json()["total"] == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(FeedbackAdmission)) == 2
        assert db.get(FeedbackAdmission, owner_id).daily_receipts == 1
        assert db.get(FeedbackAdmission, other_id).daily_receipts == 1


def test_feedback_budget_is_independent_of_submission_and_page_quotas(feedback_case):
    from app.config import settings
    from app.db import session_factory
    from app.models import Ledger
    from app.plan_models import ControlAdmission
    client, auth, _, job_id, _ = feedback_case
    settings().plan_request_burst = 1
    settings().free_daily_pages = 0
    for index in range(3):
        assert send_feedback(client, auth, job_id, str(index)).status_code == 201
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ControlAdmission)) == 0
        assert db.scalar(select(func.count()).select_from(Ledger)) == 0


def test_admin_settings_apply_to_new_feedback_without_resetting_usage(feedback_case):
    from app.config import settings
    from app.db import session_factory
    from app.feedback_models import FeedbackAdmission
    client, auth, owner_id, job_id, clock = feedback_case
    configure_system_limits(feedback_request_burst=1, feedback_requests_per_minute=1, feedback_receipts_per_day=1)
    assert send_feedback(client, auth, job_id, "before-setting").status_code == 201
    operator = login(client, "admin")
    current = client.get("/v1/admin/system-settings", headers=operator).json()
    values = {**current["values"], "feedback_request_burst": 2, "feedback_receipts_per_day": 2}
    changed = client.put("/v1/admin/system-settings", headers=operator,
                         json={"expected_version": current["version"], "values": values})
    assert changed.status_code == 200
    # Changing environment fallbacks cannot refill or replace saved settings.
    settings().feedback_requests_per_minute = 1000
    denied = send_feedback(client, auth, job_id, "after-setting")
    assert denied.status_code == 429 and denied.headers["Retry-After"] == "60"
    clock[0] += timedelta(seconds=60)
    assert send_feedback(client, auth, job_id, "after-setting").status_code == 201
    with session_factory()() as db:
        assert db.get(FeedbackAdmission, owner_id).daily_receipts == 2
