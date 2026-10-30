"""Isolated PostgreSQL evidence for compatible startup and indexed expiry."""
from datetime import timedelta
import os
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from test_postgres_concurrency import pg_scope, pg, new_job

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires dedicated PostgreSQL test database')


def test_postgres_additive_schema_stamps_do_not_gate_readiness(pg):
    from app.db import engine
    from app.runtime import check_database
    with engine().begin() as db:
        db.execute(text("UPDATE alembic_version SET version_num='future_additive'"))
        db.execute(text('ALTER TABLE users ADD COLUMN additive_note TEXT'))
    check_database(startup=True)
    check_database()
    with engine().begin() as db:
        db.execute(text('ALTER TABLE users RENAME COLUMN name TO retired_name'))
    with pytest.raises(RuntimeError, match='structure is incomplete'):
        check_database(startup=True)


def test_postgres_expiry_uses_partial_index_and_preserves_other_work(pg):
    from app.db import session_factory
    from app.models import Job, IMAGE_RESULT_EXPIRY_FILTER, now
    from app.result_retention import expire_registered_results
    from app.scheduler import lock_scheduler
    job_id = new_job(pg)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        job.status, job.completed_at = 'no_text', now() - timedelta(days=8)
        db.flush()
        template = dict(db.execute(select(Job.__table__).where(Job.id == job_id)).mappings().one())
        rows = [{**template, 'id': str(uuid4()), 'idempotency_key': str(uuid4()), 'discard_output': True}
                for _ in range(5000)]
        # Discarded history and a live task must not be expired again.
        live_id = str(uuid4())
        rows.append({**template, 'id': live_id, 'idempotency_key': live_id, 'status': 'running'})
        db.execute(Job.__table__.insert(), rows)
        db.execute(text('ANALYZE jobs'))
        plan = db.execute(text('EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM jobs WHERE ' +
            IMAGE_RESULT_EXPIRY_FILTER + ' AND completed_at <= :cutoff ORDER BY completed_at,id LIMIT 100'),
            {'cutoff': now() - timedelta(days=7)}).scalar()
        assert 'ix_jobs_image_result_expiry' in str(plan)
        lock_scheduler(db)
        expire_registered_results(db)
        db.commit()
        assert job.discard_output and job.error_code == 'RESULT_EXPIRED'
        assert not db.get(Job, live_id).discard_output
