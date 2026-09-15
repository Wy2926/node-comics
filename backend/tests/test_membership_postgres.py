"""Finite quota and receipt contention in the dedicated PostgreSQL test database."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta, timezone
from threading import Barrier
from fastapi import HTTPException
from sqlalchemy import select
from test_postgres_concurrency import pg, pg_scope, pytestmark
from conftest import png_variant
from app.db import session_factory
from app.models import Asset, Job, Ledger, User, now
from app.entitlement_models import QuotaPeriod
from app.jobs import settle
from app.submission_api import ItemRequest, SubmissionRequest, submit
from app.quota_grants import GrantRequest, grant_pages


def test_postgres_final_daily_and_gift_pages_are_reserved_exactly_once(pg):
    from app.config import settings
    from app.assets import create_asset
    settings().free_daily_pages = 1
    with session_factory()() as db:
        db.get(User, pg['owner_id']).plus_expires_at = now() - timedelta(seconds=1)
        assets = [create_asset(db, pg['owner_id'], png_variant(pg['png'], n)) for n in range(6)]
        db.commit()
        ids = [asset.id for asset in assets]
        grant_pages(db, pg['owner_id'], pg['owner_id'], 'one-gift', GrantRequest(
            mode='classic', pages=1, expires_at=(now() + timedelta(hours=1)).replace(tzinfo=timezone.utc), note='race'))
    barrier = Barrier(6)
    def accept(n):
        with session_factory()() as db:
            user, asset = db.get(User, pg['owner_id']), db.get(Asset, ids[n])
            barrier.wait(timeout=10)
            try:
                receipt = submit(SubmissionRequest(mode='classic', target_language='zh-Hans', max_quota_pages=1,
                    items=[ItemRequest(client_item_id=str(n), asset_id=asset.id, image_sha256=asset.sha256,
                                       byte_size=asset.byte_size, content_type=asset.mime)]),
                    idempotency_key=str(n), user=user, db=db)
                return receipt['items'][0]['job']['id']
            except HTTPException as error:
                assert error.detail['code'] == 'DAILY_QUOTA_EXHAUSTED'
                db.rollback()
                return None
    with ThreadPoolExecutor(6) as pool:
        accepted = [job_id for job_id in pool.map(accept, range(6)) if job_id]
    assert len(accepted) == 2
    with session_factory()() as db:
        periods = db.scalars(select(QuotaPeriod).where(QuotaPeriod.owner_id == pg['owner_id'])).all()
        assert sorted((row.kind, row.reserved) for row in periods) == [('classic_daily', 1), ('classic_grant', 1)]
    # Duplicated completion/cancellation delivery contends on the same job rows.
    def finish(job_id):
        with session_factory()() as db:
            job = db.scalar(select(Job).where(Job.id == job_id).with_for_update(key_share=True))
            job.status = 'succeeded'
            settle(db, job, success=True)
            db.commit()
    with ThreadPoolExecutor(6) as pool:
        list(pool.map(finish, accepted * 3))
    with session_factory()() as db:
        assert sum(db.scalars(select(QuotaPeriod.used))) == 2
        assert sum(db.scalars(select(QuotaPeriod.reserved))) == 0
        assert len(db.scalars(select(Ledger).where(Ledger.kind == 'settle')).all()) == 2
        assert sum(db.scalars(select(Asset.active_references))) == 0


def test_postgres_concurrent_grant_receipt_issues_only_one_bucket(pg):
    request = GrantRequest(mode='redraw', pages=7,
        expires_at=(now() + timedelta(days=2)).replace(tzinfo=timezone.utc), note='concurrent receipt')
    barrier = Barrier(6)
    def issue(_):
        with session_factory()() as db:
            barrier.wait(timeout=10)
            return grant_pages(db, pg['owner_id'], pg['owner_id'], 'same-grant', request)
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(issue, range(6)))
    assert all(result == results[0] for result in results)
    with session_factory()() as db:
        assert len(db.scalars(select(QuotaPeriod).where(QuotaPeriod.source == 'grant')).all()) == 1
        assert sum(db.scalars(select(Ledger.amount).where(Ledger.kind == 'grant'))) == 7


def test_postgres_same_grant_key_for_different_users_is_a_conflict(pg):
    with session_factory()() as db:
        other = User(subject='other-grant-target', name='Other')
        db.add(other)
        db.commit()
        owners = [pg['owner_id'], other.id]
    request = GrantRequest(mode='redraw', pages=1,
        expires_at=(now() + timedelta(days=1)).replace(tzinfo=timezone.utc), note='scope contention')
    barrier = Barrier(2)
    def issue(owner):
        with session_factory()() as db:
            barrier.wait(timeout=10)
            try:
                grant_pages(db, owner, pg['owner_id'], 'scope-race', request)
                return 201
            except HTTPException as error:
                assert error.detail['code'] == 'IDEMPOTENCY_CONFLICT'
                db.rollback()
                return error.status_code
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(issue, owners)) == [201, 409]
