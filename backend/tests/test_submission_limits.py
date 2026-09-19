"""HTTP control protection is shared across replicas and distinct from image admission."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
import pytest
from fastapi import HTTPException
from sqlalchemy import select
from conftest import login
from test_cluster_submissions import cluster, descriptor, submit
from test_cluster_scheduler import scheduler_case
from test_classic import text_database


def test_replays_consume_control_tokens_but_not_image_budget(cluster,png):
    from app.config import settings
    from app.db import session_factory
    from app.plan_models import ControlAdmission, ImageAdmission
    client,_=cluster
    auth=login(client)
    settings().plan_request_burst=3
    settings().plan_requests_per_minute=1
    responses=[submit(client,auth,[descriptor(png)],key=f'reuse-{i}') for i in range(6)]
    assert [r.status_code for r in responses] == [202,200,200,429,429,429]
    for response in responses[3:]:
        assert response.json()['error']['code']=='CONTROL_RATE_LIMITED'
        assert response.json()['error']['scope']=='control_request'
        assert int(response.headers['Retry-After']) > 0
    with session_factory()() as db:
        assert len(list(db.scalars(select(ImageAdmission))))==1
        assert db.scalar(select(ControlAdmission)).leases==[]


def test_independent_sessions_enforce_same_account_concurrency(scheduler_case):
    from app.plan_limits import acquire_control,release_control
    from app.config import settings
    settings().plan_request_concurrency=2
    gate=Barrier(8)
    def enter(index):
        gate.wait()
        try:return acquire_control('free-user')
        except HTTPException as error:
            assert error.status_code==429 and error.detail['code']=='CONTROL_BUSY'
            return None
    with ThreadPoolExecutor(8) as pool:
        accepted=[token for token in pool.map(enter,range(8)) if token]
    assert len(accepted)==2
    other=acquire_control('plus-user')
    release_control('plus-user',other)
    for token in accepted:release_control('free-user',token)
    token=acquire_control('free-user')
    release_control('free-user',token)


def test_expired_admission_lease_does_not_permanently_block_account(scheduler_case,monkeypatch):
    from app import plan_limits
    from app.config import settings
    from app.models import now
    settings().plan_request_concurrency=1
    first=plan_limits.acquire_control('free-user')
    later=now()+timedelta(seconds=settings().plan_request_lease_seconds+1)
    monkeypatch.setattr(plan_limits,'now',lambda:later)
    following=plan_limits.acquire_control('free-user')
    assert following != first
    plan_limits.release_control('free-user',first)
    with pytest.raises(HTTPException) as denied:plan_limits.acquire_control('free-user')
    assert denied.value.detail['code']=='CONTROL_BUSY'
    plan_limits.release_control('free-user',following)


def test_independent_sessions_share_control_request_burst(scheduler_case):
    from app.plan_limits import acquire_control,release_control
    from app.config import settings
    settings().plan_request_concurrency=32
    settings().plan_request_burst=3
    settings().plan_requests_per_minute=1
    gate=Barrier(8)
    def enter(index):
        gate.wait()
        try:return acquire_control('free-user')
        except HTTPException as error:
            assert error.detail['code']=='CONTROL_RATE_LIMITED'
            return None
    with ThreadPoolExecutor(8) as pool:
        accepted=[token for token in pool.map(enter,range(8)) if token]
    assert len(accepted)==3
    for token in accepted:release_control('free-user',token)
