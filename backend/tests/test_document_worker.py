"""Text-only central execution and bounded metadata maintenance; no external traffic."""
from contextlib import nullcontext
from datetime import timedelta
import os
from pathlib import Path
import subprocess
import sys
from textwrap import dedent
from types import SimpleNamespace

import pytest

from app.db import session_factory
from app.documents import text, worker
from app.documents.models import Document
from app.models import Job, now, uid
from app.queue_models import ExecutionLease
from test_document_quota_api import document_case  # fixture dependency
from test_document_workflow import claim, flow, ocr_all


def test_fresh_worker_registers_foreign_keys_without_api_parser_or_database(tmp_path):
    code = dedent('''
        import sys
        from unittest.mock import patch
        sys.path.insert(0, sys.argv[1])
        with patch('sqlalchemy.create_engine', side_effect=AssertionError('No database initialization')), \\
             patch('socket.create_connection', side_effect=AssertionError('No network access')), \\
             patch('socket.socket.connect', side_effect=AssertionError('No network access')):
            import app.documents.worker
            from app.db import Base
            from sqlalchemy.orm import configure_mappers
            configure_mappers()
            targets = [fk.column for table in Base.metadata.tables.values() for fk in table.foreign_keys]
            assert targets and {'quota_periods', 'billing_terms'} <= Base.metadata.tables.keys()
            assert 'app.main' not in sys.modules
            assert 'alembic.command' not in sys.modules
            assert 'comic_document_files' not in sys.modules and 'pypdfium2' not in sys.modules
    ''')
    environment = {name: value for name, value in os.environ.items()
                   if name.upper() in {'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH'}}
    environment.update(APP_ENV='test', DEV_AUTH='false')
    result = subprocess.run([sys.executable, '-I', '-c', code, str(Path(__file__).resolve().parents[1])],
                            cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr


def test_execute_only_text_without_spool_or_r2(flow, monkeypatch):
    ocr_all(flow)
    lease, calls, completed = claim(), [], []
    monkeypatch.setattr(worker, 'lease_guard', lambda _: nullcontext(lambda: None))
    monkeypatch.setattr(worker, 'get_document_settings', lambda: pytest.fail('Text execution needs no spool'))
    monkeypatch.setattr(worker, 'get_document_store', lambda: pytest.fail('Text execution needs no R2'))
    def run(job_id, lease_id, check):
        check()
        calls.append((job_id, lease_id))
        return {'translated_pages': 2}
    monkeypatch.setattr(text, 'run_text_stage', run)
    monkeypatch.setattr(worker, 'complete_control', lambda *args: completed.append(args))
    worker.execute(lease)
    assert calls == [(flow.job_id, lease.id)]
    assert completed == [(lease.id, {'translated_pages': 2})]
    assert not hasattr(worker, 'prepare') and not hasattr(worker, 'package')


@pytest.mark.parametrize('stage', ['doc_prepare', 'doc_zip'])
def test_central_executor_rejects_host_stages(flow, monkeypatch, stage):
    ocr_all(flow)
    lease, failed = claim(), []
    monkeypatch.setattr(worker, 'lease_guard', lambda _: nullcontext(lambda: None))
    monkeypatch.setattr(worker, 'current', lambda *args: (None, SimpleNamespace(name=stage), None))
    monkeypatch.setattr(text, 'run_text_stage', lambda *a: pytest.fail('Host stages cannot run centrally'))
    monkeypatch.setattr(worker, 'fail_lease', lambda lease_id, error, **kwargs: failed.append((lease_id, error.code)))
    worker.execute(lease)
    assert failed == [(lease.id, 'DOCUMENT_STAGE_INVALID')]


def test_unknown_reconciliation_cycles_without_old_unknown_starvation(flow, monkeypatch):
    ids = []
    with session_factory()() as db:
        for _ in range(45):
            job_id = uid()
            ids.append(job_id)
            db.add(Job(id=job_id, owner_id=flow.case.owner, mode='classic', workflow_kind='document',
                target_language='zh-Hans', status='outcome_unknown', phase='doc_text', idempotency_key=job_id,
                operation='document', request_hash='a' * 64, cache_key=job_id, config={}, quota_pages=0,
                quota_kind='none', settlement='none', unknown_since=now() - timedelta(days=1)))
            db.flush()
            db.add(Document(job_id=job_id, filename='fixture.zip', source_type='zip', source_key=f'documents/input/{job_id}/source',
                source_size=1, source_sha256='a' * 64, reserved_at=now(), expires_at=now() + timedelta(days=1)))
        db.commit()
    visited, state = [], worker.MaintenanceState()
    monkeypatch.setattr(text, 'reconcile_saved_response', lambda job_id: visited.append(job_id))
    for expected in (20, 40, 45):
        assert worker.maintain(state) is state
        assert len(visited) == expected
    assert visited == sorted(ids)
    worker.maintain(state)
    assert visited[45:] == sorted(ids)[:20]


def test_output_expiration_still_runs_after_reconciliation(flow, monkeypatch):
    deleted = []
    monkeypatch.setattr(flow.store, 'delete_prefix',
        lambda prefix: deleted.append(prefix) or {'more': False, 'deleted': 1}, raising=False)
    with session_factory()() as db:
        db.get(Job, flow.job_id).status = 'succeeded'
        document = db.get(Document, flow.job_id)
        document.expires_at = now() - timedelta(seconds=1)
        document.cleanup_after = None
        document.output_ref = {'key': f'documents/output/{document.job_id}/fixture.zip'}
        db.commit()
    worker.maintain()
    assert deleted == [f'documents/output/{flow.job_id}']
    with session_factory()() as db:
        assert db.get(Document, flow.job_id).output_ref is None


def test_maintenance_runs_one_bounded_owner_recovery_pass(flow, monkeypatch):
    calls = []
    monkeypatch.setattr(worker, 'expire_offline_workspaces', lambda: calls.append('owners'))
    worker.maintain()
    assert calls == ['owners']


def test_terminal_cleanup_waits_for_leases_and_reclaims_legacy_work_only_once(flow, monkeypatch):
    ocr_all(flow)
    lease, deleted = claim(), []
    monkeypatch.setattr(flow.store, 'delete_prefix',
        lambda prefix: deleted.append(prefix) or {'more': False, 'deleted': 1}, raising=False)
    with session_factory()() as db:
        db.get(Job, flow.job_id).status = 'failed'
        document = db.get(Document, flow.job_id)
        document.upload_id = None
        document.cleanup_after = now() - timedelta(seconds=1)
        db.commit()
    worker.maintain()
    assert not deleted
    with session_factory()() as db:
        db.get(ExecutionLease, lease.id).completed_at = now()
        db.commit()
    worker.maintain()
    assert deleted == [f'documents/{category}/{flow.job_id}' for category in ('input', 'work', 'output')]
    worker.maintain()
    assert len(deleted) == 3
