from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
import pytest
from sqlalchemy import event
from app.control_pools import report_pools
from app.db import session_factory
from app.health import log_failure, probe_oidc, readiness, report_progress
from app.health_models import ServiceHeartbeat
from app.models import now


def mark_ready():
    report_progress("control-worker", instance="test-worker")
    report_progress("maintenance", instance="test-maintenance")
    with session_factory()() as db:
        from conftest import control_node
        from app.queue_models import ComputeNode
        node = db.get(ComputeNode, control_node(db))
        node.runtime_report = {"protocol_version": 3, "ready": True}
        node.heartbeat_at = now()
        report_pools(db)


def test_live_is_independent_of_dependencies_and_ready_requires_all_services(client):
    assert client.get("/health/live").status_code == 200
    assert client.get('/health/ready').status_code == 200
    response = client.get("/health/cluster")
    assert response.status_code == 503
    assert response.json()["checks"]["maintenance"] == "unavailable"
    mark_ready()
    assert client.get("/health/ready").status_code == 200
    with patch("app.health.session_factory", side_effect=RuntimeError("secret database URL")):
        assert client.get("/health/live").status_code == 200
        response = client.get("/health/cluster")
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
        log_failure("maintenance", error, job_id="synthetic-job", stage="classic", lease_id="synthetic-lease")
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
        stage = db.scalar(select(JobStage).where(JobStage.job_id == job_id, JobStage.name == "page"))
        stage.available_at = now() - timedelta(days=1)
        db.commit()
        payload, ready = readiness()
        assert ready and payload["alerts"]["overdue_ready_stages"] == 1
        job.status = "outcome_unknown"
        db.commit()
        payload, ready = readiness()
        assert ready and payload["alerts"]["outcome_unknown"] == 1
        assert job_id not in str(payload) and job.owner_id not in str(payload)


@pytest.fixture
def document_health(client, monkeypatch):
    from app.documents import config
    monkeypatch.setattr(config, 'get_document_settings', lambda: SimpleNamespace(enabled=True))
    mark_ready()
    from app.queue_models import ComputeNode
    from conftest import control_node
    with session_factory()() as db:
        node = db.get(ComputeNode, control_node(db))
        node.runtime_report = {**node.runtime_report, 'document_protocol': 2}
        node.capabilities = ['page', 'doc_prepare', 'doc_ocr', 'doc_render', 'doc_zip']
        db.commit()
        return node.id


def test_document_worker_is_required_only_for_cluster_when_enabled(client, document_health):
    payload, ready = readiness()
    assert not ready and payload['checks']['document-worker'] == 'unavailable'
    assert payload['checks']['document-nodes'] == 'ready'
    assert client.get('/health/ready').status_code == 200
    assert readiness(role='control-worker', instance='test-worker')[1]
    report_progress('document-worker', instance='test-document-worker')
    assert readiness()[1]
    assert readiness(role='document-worker', instance='test-document-worker')[1]
    report_progress('document-worker', instance='test-document-worker', error=ValueError('private failure'))
    assert not readiness()[1]
    report_progress('document-worker', instance='test-document-worker')
    with session_factory()() as db:
        row = db.get(ServiceHeartbeat, ('document-worker', 'test-document-worker'))
        row.heartbeat_at = row.last_success_at = now() - timedelta(minutes=20)
        db.commit()
    assert not readiness()[1]


@pytest.mark.parametrize('mutation', ['ready', 'legacy', 'old-document-protocol', 'disabled', 'stale',
    'not-ready', 'old-compute-protocol', 'config-pending', 'config-error', 'control', 'document-slots-zero'])
def test_document_node_uses_registered_protocol_and_runtime_gates(document_health, mutation):
    from app.queue_models import ComputeNode
    report_progress('document-worker', instance='test-document-worker')
    with session_factory()() as db:
        node = db.get(ComputeNode, document_health)
        if mutation == 'legacy':
            node.runtime_report = {'protocol_version': 3, 'ready': True}
        elif mutation == 'old-document-protocol':
            node.runtime_report = {**node.runtime_report, 'document_protocol': 1}
        elif mutation == 'disabled':
            node.enabled = False
        elif mutation == 'stale':
            node.heartbeat_at = now() - timedelta(minutes=20)
        elif mutation == 'not-ready':
            node.runtime_report = {**node.runtime_report, 'ready': False}
        elif mutation == 'old-compute-protocol':
            node.runtime_report = {**node.runtime_report, 'protocol_version': 2}
        elif mutation == 'config-pending':
            node.applied_config_version = node.config_version - 1
        elif mutation == 'config-error':
            node.config_error = 'INVALID_CONFIG'
        elif mutation == 'control':
            node.engine_version = 'control'
        elif mutation == 'document-slots-zero':
            node.desired_config = {**node.desired_config, 'document_slots': 0}
        db.commit()
    payload, ready = readiness()
    assert ready == (mutation == 'ready')
    assert payload['checks']['document-nodes'] == ('ready' if mutation == 'ready' else 'unavailable')


def test_document_checks_do_not_change_disabled_or_role_specific_health(client, monkeypatch):
    from app.documents import config
    from app.config import settings
    monkeypatch.setattr(config, 'get_document_settings', lambda: SimpleNamespace(enabled=False))
    mark_ready()
    payload, ready = readiness()
    assert ready
    assert 'document-worker' not in payload['checks'] and 'document-nodes' not in payload['checks']
    monkeypatch.setattr(settings(), 'classic_enabled', False)
    assert 'compute-nodes' not in readiness()[0]['checks']
    monkeypatch.setattr(config, 'get_document_settings', lambda: SimpleNamespace(enabled=True))
    payload, ready = readiness()
    assert not ready and payload['checks']['document-nodes'] == 'unavailable'
    assert 'compute-nodes' not in payload['checks']
    with patch.object(config, 'get_document_settings', side_effect=AssertionError('role health must not load R2 config')):
        assert readiness(role='control-worker', instance='test-worker')[1]


def test_document_and_image_node_health_share_one_existence_query(document_health):
    from app.db import engine
    report_progress('document-worker', instance='test-document-worker')
    statements = []

    def record(connection, cursor, statement, *args):
        if statement.lstrip().upper().startswith('SELECT EXISTS') and 'compute_nodes' in statement:
            statements.append(statement)

    event.listen(engine(), 'before_cursor_execute', record)
    try:
        payload, ready = readiness()
        assert ready and payload['checks']['compute-nodes'] == payload['checks']['document-nodes'] == 'ready'
    finally:
        event.remove(engine(), 'before_cursor_execute', record)
    assert len(statements) == 1
