"""The document reservation cannot enter image cancellation or settlement."""
from datetime import timedelta

from fastapi import HTTPException
import pytest
from sqlalchemy import select

from app.db import session_factory
from app.documents.models import DocumentQuotaAllocation
from app.documents.quota import settle_document
from app.entitlement_models import QuotaPeriod
from app.errors import ProcessingError
from app.jobs import cancel_job
from app.models import Job, now
from app.workers import finish_job
from conftest import login
from test_document_quota_api import document_case, create, prepare, purchase, reserve


def test_single_image_helpers_refuse_document_without_mutating_reservation(document_case):
    case = document_case
    period_id = purchase(case, 3)
    job_id = prepare(case, create(case), 3)
    assert reserve(job_id)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        before = job.status, job.settlement, job.cancel_requested, job.discard_output
        with pytest.raises(HTTPException) as exc:
            cancel_job(db, job)
        assert exc.value.status_code == 409 and exc.value.detail['code'] == 'WORKFLOW_MISMATCH'
        with pytest.raises(ProcessingError, match='WORKFLOW_MISMATCH'):
            finish_job(db, job, 'cancelled')
        assert (job.status, job.settlement, job.cancel_requested, job.discard_output) == before
        assert db.get(QuotaPeriod, period_id).reserved == 3
        assert all(row.reserved for row in db.scalars(select(DocumentQuotaAllocation)))


def test_admin_reserved_jobs_finds_each_original_document_bucket_once(document_case):
    case = document_case
    early = purchase(case, 2, ends_at=now() + timedelta(hours=1))
    late = purchase(case, 2)
    job_id = prepare(case, create(case), 3)
    assert reserve(job_id)
    admin = login(case.client, 'admin')
    path = f'/v1/admin/users/{case.owner}/reserved-jobs'
    for period in (early, late):
        response = case.client.get(path, headers=admin, params={'period_id': period})
        assert response.status_code == 200, response.text
        assert response.json()['total'] == 1
        assert response.json()['items'][0]['id'] == job_id
        assert response.json()['items'][0]['workflow_kind'] == 'document'
    assert case.client.get(path, headers=admin).json()['total'] == 1
    assert case.client.get(path, headers=admin, params={'period_id': 'unrelated'}).json()['total'] == 0
    other = case.client.get('/v1/me', headers=login(case.client, 'other')).json()['user']['id']
    assert case.client.get(f'/v1/admin/users/{other}/reserved-jobs', headers=admin,
        params={'period_id': early}).json()['total'] == 0
    with session_factory()() as db:
        settle_document(db, db.get(Job, job_id), success=False)
        db.commit()
    assert case.client.get(path, headers=admin, params={'period_id': early}).json()['total'] == 0
