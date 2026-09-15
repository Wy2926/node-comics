"""Real controller stage transitions with synthetic image-node replies."""
from datetime import timedelta
from fastapi import HTTPException
import pytest
from sqlalchemy import func, select

from app import classic, workers
from app.db import session_factory
from app.errors import ProcessingError
from app.models import Job, now
from app.queue_models import ComputeNode, ExecutionLease, JobStage
from app.scheduler import claim_stage
from test_classic import text_case, text_database


@pytest.fixture
def pipeline(text_case):
    job_id, text_lease = text_case
    with session_factory()() as db:
        job = db.get(Job, job_id)
        version = job.config['engine']['version']
        db.add(ComputeNode(id='image-node', name='image device', capabilities=['analyze', 'inpaint', 'render'],
                           capacity=1, resource_id='isolated:cpu', engine_version=version, device='cpu'))
        db.add(JobStage(job_id=job_id, name='inpaint', status='ready'))
        db.add(JobStage(job_id=job_id, name='render', status='waiting'))
        db.commit()
        image_lease = claim_stage(db, 'image-node', ['inpaint'])
        db.commit()
        reply = {'cache_key': 'd' * 64, 'cached': True, 'timings': {'inpaint': 0.1},
                 'version': version, 'width': 80, 'height': 64, 'input_hash': 'a' * 64}
        return job_id, text_lease, image_lease.id, image_lease.token, reply


@pytest.mark.parametrize('first', ['text', 'inpaint'])
def test_text_and_image_release_independently_and_render_waits_for_both(pipeline, first):
    job, text_lease, image_lease, token, reply = pipeline
    def complete(name):
        if name == 'text':
            workers.complete_stage(text_lease, classic.run_text_stage(job, text_lease))
        else:
            workers.complete_stage(image_lease, reply, token=token, node_id='image-node')
    complete(first)
    with session_factory()() as db:
        render = db.scalar(select(JobStage).where(JobStage.job_id == job, JobStage.name == 'render'))
        assert render.status == 'waiting'
        if first == 'inpaint':
            assert db.scalar(select(func.count()).select_from(ExecutionLease).where(
                ExecutionLease.node_id == 'image-node', ExecutionLease.completed_at.is_(None))) == 0
            assert db.get(ExecutionLease, text_lease).completed_at is None
    complete('text' if first == 'inpaint' else 'inpaint')
    with session_factory()() as db:
        assert db.scalar(select(JobStage).where(JobStage.job_id == job, JobStage.name == 'render')).status == 'ready'


def test_image_completion_is_idempotent_and_changed_replay_is_fenced(pipeline):
    _, _, lease, token, reply = pipeline
    workers.complete_stage(lease, reply, token=token, node_id='image-node')
    workers.complete_stage(lease, reply, token=token, node_id='image-node')
    with pytest.raises(ProcessingError, match='LEASE_EXPIRED'):
        workers.complete_stage(lease, {**reply, 'cache_key': 'e' * 64}, token=token, node_id='image-node')


def test_failure_from_sibling_does_not_overwrite_first_terminal_failure(pipeline):
    job, text_lease, image_lease, token, _ = pipeline
    workers.fail_stage(text_lease, ProcessingError('TEXT_AUTH_FAILED', 'text rejected'))
    try:
        workers.fail_stage(image_lease, ProcessingError('CLASSIC_INPAINT_FAILED', 'late image failure'),
                           token=token, node_id='image-node')
    except ProcessingError as error:
        assert error.code == 'LEASE_EXPIRED'
    with session_factory()() as db:
        record = db.get(Job, job)
        assert record.status == 'failed'
        assert record.error_code == 'TEXT_AUTH_FAILED'
        stage = db.get(JobStage, db.get(ExecutionLease, image_lease).stage_id)
        assert stage.status != 'ready'


def test_node_invalid_result_ends_lease_with_precise_validation_error(pipeline):
    from app.cluster_api import CompletionRequest, complete
    job, _, lease, token, reply = pipeline
    response = complete(lease, CompletionRequest(lease_token=token, result={**reply, 'cache_key': 'invalid'}), identity='image-node')
    assert response == {'accepted': False, 'error': {'code': 'INVALID_ENGINE_RESULT', 'message': '抹字缓存标识无效'}}
    with session_factory()() as db:
        assert db.get(Job, job).error_code == 'INVALID_ENGINE_RESULT'
        assert db.get(ExecutionLease, lease).completed_at is not None


def test_control_http_conflict_is_terminal_and_preserves_its_code(text_case, monkeypatch):
    def reject(*args):
        raise HTTPException(409, detail={'code': 'FILE_PAGE_CONFLICT', 'message': 'same file page has another image'})
    monkeypatch.setattr(workers, 'run_text_stage', reject)
    workers.run_control_stage(text_case[1])
    with session_factory()() as db:
        job = db.get(Job, text_case[0])
        assert (job.status, job.error_code) == ('failed', 'FILE_PAGE_CONFLICT')
        assert db.get(ExecutionLease, text_case[1]).completed_at is not None
