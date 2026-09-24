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
    from app.translation_requests import ControlAdmission, ImageAdmission
    client,_=cluster
    auth=login(client)
    settings().translation_request_burst=3
    settings().translation_requests_per_minute=1
    responses=[submit(client,auth,descriptor(png),key=f'reuse-{i}') for i in range(6)]
    assert [r.status_code for r in responses] == [202,202,202,429,429,429]
    for response in responses[3:]:
        assert response.json()['error']['code']=='REQUEST_RATE_LIMITED'
        assert int(response.headers['Retry-After']) > 0
    with session_factory()() as db:
        assert len(list(db.scalars(select(ImageAdmission))))==1
        assert db.scalar(select(ControlAdmission)).leases==[]


def test_independent_sessions_enforce_same_account_concurrency(scheduler_case):
    from app.translation_limits import acquire_control,release_control
    from app.config import settings
    settings().translation_request_concurrency=2
    gate=Barrier(8)
    def enter(index):
        gate.wait()
        try:return acquire_control('free-user')
        except HTTPException as error:
            assert error.status_code==429 and error.detail['code']=='REQUEST_RATE_LIMITED'
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
    from app import translation_limits
    from app.config import settings
    from app.models import now
    settings().translation_request_concurrency=1
    first=translation_limits.acquire_control('free-user')
    later=now()+timedelta(seconds=settings().translation_request_lease_seconds+1)
    monkeypatch.setattr(translation_limits,'now',lambda:later)
    following=translation_limits.acquire_control('free-user')
    assert following != first
    translation_limits.release_control('free-user',first)
    with pytest.raises(HTTPException) as denied:translation_limits.acquire_control('free-user')
    assert denied.value.detail['code']=='REQUEST_RATE_LIMITED'
    translation_limits.release_control('free-user',following)


def test_independent_sessions_share_control_request_burst(scheduler_case):
    from app.translation_limits import acquire_control,release_control
    from app.config import settings
    settings().translation_request_concurrency=32
    settings().translation_request_burst=3
    settings().translation_requests_per_minute=1
    gate=Barrier(8)
    def enter(index):
        gate.wait()
        try:return acquire_control('free-user')
        except HTTPException as error:
            assert error.detail['code']=='REQUEST_RATE_LIMITED'
            return None
    with ThreadPoolExecutor(8) as pool:
        accepted=[token for token in pool.map(enter,range(8)) if token]
    assert len(accepted)==3
    for token in accepted:release_control('free-user',token)
