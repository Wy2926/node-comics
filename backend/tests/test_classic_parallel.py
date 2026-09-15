"""Controlled LLM/lease races without synchronous image branches."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event

import pytest
from sqlalchemy import func, select
from app import classic
from app.adapters.text import TextError, TextResponse
from app.db import session_factory
from app.models import ClassicState, Job, TextCall, now
from app.queue_models import ExecutionLease, JobStage
from app.scheduler import lock_scheduler
from test_classic import text_case, text_database, SEGMENTS


def test_inflight_llm_does_not_hold_scheduler_or_image_resources(text_case, monkeypatch):
    entered, release = Event(), Event()
    original = classic.call_text
    def text(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)
    monkeypatch.setattr(classic, 'call_text', text)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(classic.run_text_stage, *text_case)
        try:
            assert entered.wait(5)
            with session_factory()() as db:
                lock_scheduler(db)
                lease = db.get(ExecutionLease, text_case[1])
                assert lease.resource_pool == 'text:classic-text'
                assert db.scalar(select(func.count()).select_from(ExecutionLease)) == 1
                # A node loss/recovery transaction proceeds while the LLM waits.
                stage = db.get(JobStage, lease.stage_id)
                stage.generation += 1
                db.commit()
        finally:
            release.set()
        with pytest.raises(classic.ProcessingError, match='LEASE_EXPIRED'):
            future.result(timeout=5)
    with session_factory()() as db:
        assert db.scalar(select(TextCall)).usage
        assert db.get(ClassicState, text_case[0]).translations == {}


def test_atomic_unknown_cost_budget_cannot_be_overreserved(text_case):
    def reserve(index):
        try:
            return classic.reserve_call(*text_case, index, SEGMENTS, 'zh-Hans')[0]
        except TextError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, [0, 1]))
    assert results.count('TEXT_BUDGET_EXCEEDED') == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
        call = db.scalar(select(TextCall))
        assert call.accounted_micros == call.reserved_micros


def test_new_node_reuses_paid_translation_after_image_cache_loss(text_case, monkeypatch):
    classic.run_text_stage(*text_case)
    with session_factory()() as db:
        state = db.get(ClassicState, text_case[0])
        state.artifacts = {}  # Losing all image hints does not remove paid text.
        lease = db.get(ExecutionLease, text_case[1])
        lease.generation += 1
        db.get(JobStage, lease.stage_id).generation = lease.generation
        lease.expires_at = now() + timedelta(minutes=5)
        db.commit()
    monkeypatch.setattr(classic, 'call_text', lambda *args: pytest.fail('Completed text must not be called again'))
    assert classic.run_text_stage(*text_case) == {'translations': {'b001': '你好！'}}
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
