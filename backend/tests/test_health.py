from datetime import timedelta
from unittest.mock import patch
from app.control_pools import report_pools
from app.db import session_factory
from app.health import log_failure, probe_oidc, readiness, report_progress
from app.health_models import ServiceHeartbeat
from app.models import now


def mark_ready():
    report_progress("control-worker", instance="test-worker")
    report_progress("maintenance", instance="test-maintenance")
    with session_factory()() as db:
        report_pools(db)


def test_live_is_independent_of_dependencies_and_ready_requires_all_services(client):
    assert client.get("/health/live").status_code == 200
    response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["checks"]["maintenance"] == "unavailable"
    mark_ready()
    assert client.get("/health/ready").status_code == 200
    with patch("app.health.session_factory", side_effect=RuntimeError("secret database URL")):
        assert client.get("/health/live").status_code == 200
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert "secret" not in response.text


def test_stale_success_or_failed_loop_is_not_ready_and_recovers(client):
    mark_ready()
    with session_factory()() as db:
        row = db.get(ServiceHeartbeat, ("maintenance", "test-maintenance"))
        row.heartbeat_at = row.last_success_at = now() - timedelta(minutes=20)
        db.commit()
    assert not readiness()[1]
    report_progress("maintenance", instance="test-maintenance", error=ValueError("private text"))
    assert not readiness()[1]
    report_progress("maintenance", instance="test-maintenance")
    assert readiness()[1]
    with session_factory()() as db:
        row = db.get(ServiceHeartbeat, ("maintenance", "test-maintenance"))
        assert row.failure_count == 1 and row.consecutive_failures == 0
        assert row.last_error_code == "ValueError"


def test_replica_health_requires_own_progress_but_cluster_can_use_another_replica(client):
    mark_ready()
    report_progress("control-worker", instance="broken-worker", error=RuntimeError("secret"))
    assert readiness()[1]
    assert not readiness(role="control-worker", instance="broken-worker")[1]
    assert readiness(role="control-worker", instance="test-worker")[1]


def test_failure_logs_diagnostic_locations_without_exception_values(client, caplog):
    try:
        raise ValueError("private-image-words and signed-url-secret")
    except ValueError as error:
        log_failure("maintenance", error, job_id="synthetic-job", stage="redraw", lease_id="synthetic-lease")
    assert "ValueError" in caplog.text
    assert "test_health.py" in caplog.text
    assert "job_id=synthetic-job" in caplog.text and "lease_id=synthetic-lease" in caplog.text
    assert "private-image-words" not in caplog.text and "signed-url-secret" not in caplog.text


def test_oidc_probe_records_outage_and_readiness_does_not_call_remote_service(client, monkeypatch):
    from app.config import settings
    mark_ready()
    monkeypatch.setattr(settings(), "dev_auth", False)
    with patch("app.auth.jwks_client") as factory:
        probe_oidc()
        factory.return_value.get_signing_keys.assert_called_once_with(refresh=True)
        assert readiness()[1]
        factory.return_value.get_signing_keys.assert_called_once()
        factory.return_value.get_signing_keys.side_effect = RuntimeError("secret-issuer-url")
        probe_oidc()
        payload, ready = readiness()
        assert not ready and payload["checks"]["oidc"] == "unavailable"
        assert "secret" not in str(payload)


def test_unknown_and_overdue_task_alerts_are_safe_without_reading_session(client, png):
    from conftest import create, login_plus, upload
    from sqlalchemy import select
    from app.models import Job
    from app.queue_models import JobStage
    auth = login_plus(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    mark_ready()
    with session_factory()() as db:
        job = db.get(Job, job_id)
        stage = db.scalar(select(JobStage).where(JobStage.job_id == job_id, JobStage.name == "redraw"))
        stage.available_at = now() - timedelta(days=1)
        db.commit()
        payload, ready = readiness()
        assert ready and payload["alerts"]["overdue_ready_stages"] == 1
        job.status = "outcome_unknown"
        db.commit()
        payload, ready = readiness()
        assert ready and payload["alerts"]["outcome_unknown"] == 1
        assert job_id not in str(payload) and job.owner_id not in str(payload)
