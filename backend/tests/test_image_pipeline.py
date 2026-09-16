"""Slow text must not reserve image admission; cache reuse still authorizes."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import json

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import classic, workers
from app.adapters.text import TextResponse
from app.cluster_api import authorize_cached_input
from app.config import settings
from app.db import session_factory
from app.models import Asset, Job, now
from app.queue_models import ComputeNode, JobStage
from app.scheduler import active_count, claim_stage, ensure_stages
from test_classic import analysis, text_database
from test_cluster_scheduler import add_job, claim, scheduler_case


def take(node, stages):
    with session_factory()() as db:
        result = claim_stage(db, node, stages)
        db.commit()
        return result


def finish_analysis(lease, config):
    result = {**analysis(), 'version': config['engine']['version'], 'input_hash': 'a'*64}
    workers.complete_stage(lease.id, result, token=lease.token, node_id=lease.node_id)


def test_blocked_llm_does_not_stop_next_page_at_image_watermark(scheduler_case, monkeypatch):
    monkeypatch.setenv('CLUSTER_MAX_IMAGE_STAGES', '1')
    settings.cache_clear()
    first = add_job(scheduler_case)
    with session_factory()() as db:
        ensure_stages(db, db.get(Job, first))
        db.add(ComputeNode(id='text-node', name='text', capabilities=['text'], capacity=1,
                           resource_id='text-worker', engine_version='control', device='text'))
        db.commit()
    finish_analysis(claim(), scheduler_case)
    text_lease = take('text-node', ['text'])
    entered, release = Event(), Event()

    def slow_text(segments, language, profile):
        entered.set()
        assert release.wait(10)
        return TextResponse(json.dumps({'translations': [{'id': 'b001', 'text': '你好'}]}),
                            {'input_tokens': 10, 'output_tokens': 5}, 'isolated-slow-text')

    monkeypatch.setattr(classic, 'call_text', slow_text)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(workers.run_control_stage, text_lease.id)
        try:
            assert entered.wait(5)
            painted = take('node-0', ['inpaint'])
            workers.complete_stage(painted.id, {'cache_key': 'b'*64, 'version': scheduler_case['engine']['version'],
                                               'input_hash': 'a'*64}, token=painted.token, node_id=painted.node_id)
            second = add_job(scheduler_case)
            next_lease = take('node-0', ['analyze'])
            assert next_lease and next_lease.job_id == second
            assert not future.done()
            finish_analysis(next_lease, scheduler_case)
            with session_factory()() as db:
                assert db.get(Job, first).status == 'running'
                assert db.get(Job, first).phase == 'text'
                assert active_count(db, 'free-user', 'classic') == 2
                assert db.scalar(select(JobStage.status).where(JobStage.job_id == first, JobStage.name == 'render')) == 'waiting'
        finally:
            release.set()
        future.result(timeout=5)
    renderer = take('node-0', ['render'])
    assert renderer and renderer.job_id == first


@pytest.mark.parametrize('prepared,status,admitted', [(False, 'running', False), (True, 'running', True), (False, 'cancelled', True)])
def test_watermark_only_counts_active_unfinished_image_preparation(scheduler_case, monkeypatch, prepared, status, admitted):
    monkeypatch.setenv('CLUSTER_MAX_IMAGE_STAGES', '1')
    settings.cache_clear()
    waiting = add_job(scheduler_case)
    with session_factory()() as db:
        job = db.get(Job, waiting)
        ensure_stages(db, job)
        job.status = status
        for stage in db.scalars(select(JobStage).where(JobStage.job_id == waiting)):
            stage.status = 'succeeded' if stage.name == 'analyze' or (stage.name == 'inpaint' and prepared) else 'waiting'
        db.commit()
    fresh = add_job(scheduler_case)
    lease = take('node-0', ['analyze'])
    assert (lease is not None) == admitted
    if admitted:
        assert lease.job_id == fresh


def test_cached_input_authorization_has_no_object_io_and_fences_deleted_wrong_node_and_stale_lease(scheduler_case, monkeypatch):
    add_job(scheduler_case)
    lease = claim()
    monkeypatch.setattr('app.cluster_api.read_asset', lambda *a: pytest.fail('cache authorization read object bytes'))
    with session_factory()() as db:
        assert authorize_cached_input(lease.id, lease.token, 'node-0', db) == {'sha256': 'a'*64}
        with pytest.raises(HTTPException):
            authorize_cached_input(lease.id, lease.token, 'node-1', db)
        db.get(Asset, 'free-user-image').deleted_at = now()
        db.commit()
        with pytest.raises(HTTPException) as error:
            authorize_cached_input(lease.id, lease.token, 'node-0', db)
        assert error.value.status_code == 410
        db.get(Job, lease.job_id).cancel_requested = True
        db.commit()
        from app.errors import ProcessingError
        with pytest.raises(ProcessingError):
            authorize_cached_input(lease.id, lease.token, 'node-0', db)
