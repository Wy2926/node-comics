"""Control failures retain their precise code."""
from fastapi import HTTPException
from app import workers
from app.db import session_factory
from app.models import Job
from app.queue_models import ExecutionLease
from test_classic import text_case, text_database


def test_control_http_conflict_is_terminal_and_preserves_its_code(text_case, monkeypatch):
    def reject(*args):
        raise HTTPException(409, detail={'code': 'FILE_PAGE_CONFLICT', 'message': 'same file page has another image'})
    monkeypatch.setattr(workers, 'run_text_stage', reject)
    workers.run_control_stage(text_case[1])
    with session_factory()() as db:
        job = db.get(Job, text_case[0])
        assert (job.status, job.error_code) == ('failed', 'FILE_PAGE_CONFLICT')
        assert db.get(ExecutionLease, text_case[1]).completed_at is not None
