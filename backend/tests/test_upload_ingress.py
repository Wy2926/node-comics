"""Bound upload resources without holding database connections across client/R2 I/O."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event
import time

from fastapi import HTTPException
import pytest
from sqlalchemy import select
from starlette.requests import ClientDisconnect

from app import system_settings  # noqa: F401; schema registration precedes database fixtures.
from test_upload_storage import pending, storage_db


@pytest.fixture
def ingress_case(storage_db, png):
    from app.config import settings
    from app.db import session_factory
    from app.models import User, uid
    settings().result_storage_backend = 'local'
    settings().r2_endpoint_url = ''
    owners, uploads = [], {}
    with session_factory()() as db:
        for index in range(2):
            user = User(id=uid(), subject=f'isolated-ingress-{index}', name=f'owner-{index}')
            db.add(user)
            db.flush()
            owners.append(user.id)
            uploads[user.id] = [pending(db, user.id, png)[1].id for _ in range(4)]
        db.commit()
    return {'owners': owners, 'uploads': uploads, 'data': png}


def active_leases():
    from app.db import session_factory
    from app.upload_models import UploadIngressLease
    with session_factory()() as db:
        return db.scalars(select(UploadIngressLease)).all()


def configure_limits(**changes):
    """Persist test limits through the same database read boundary as replicas."""
    from app.db import session_factory
    from app.system_settings import RequestLimits, initialize_system_settings
    with session_factory()() as db:
        row = initialize_system_settings(db)
        row.values = RequestLimits.model_validate({**row.values, **changes}).model_dump()
        row.version += 1
        db.commit()


async def until_async(predicate, timeout=5):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError('Timed out waiting for isolated upload event')
        await asyncio.sleep(.01)


async def call_handler(case, request, index=0):
    from app.db import session_factory
    from app.models import User
    from app.upload_api import upload_content
    owner = case['owners'][0]
    with session_factory()() as db:
        # Match the identity dependency's already checked-out connection.
        user = db.get(User, owner)
        return await upload_content(case['uploads'][owner][index], request, user, db)


def test_shared_owner_global_and_same_upload_limits(ingress_case):
    from app.upload_ingress import acquire_ingress, release_ingress
    case = ingress_case
    alice, bob = case['owners']
    configure_limits(upload_user_concurrency=2, upload_global_concurrency=3)
    leases = []
    try:
        leases.append(acquire_ingress(case['uploads'][alice][0], alice))
        with pytest.raises(HTTPException) as error:
            acquire_ingress(case['uploads'][alice][0], alice)
        assert error.value.status_code == 429
        leases.append(acquire_ingress(case['uploads'][alice][1], alice))
        with pytest.raises(HTTPException) as error:
            acquire_ingress(case['uploads'][alice][2], alice)
        assert error.value.status_code == 429
        leases.append(acquire_ingress(case['uploads'][bob][0], bob))
        with pytest.raises(HTTPException) as error:
            acquire_ingress(case['uploads'][bob][1], bob)
        assert error.value.status_code == 429
        assert error.value.headers['Retry-After']
        assert len(active_leases()) == 3
    finally:
        for lease in leases:
            release_ingress(lease)
    assert active_leases() == []


def test_parallel_replicas_cannot_overbook_global_or_owner_limit(ingress_case):
    from app.upload_ingress import acquire_ingress, release_ingress
    configure_limits(upload_user_concurrency=2, upload_global_concurrency=3)
    pairs = [(owner, upload_id) for owner in ingress_case['owners'] for upload_id in ingress_case['uploads'][owner][:3]]
    barrier = Barrier(len(pairs))

    def claim(pair):
        owner, upload_id = pair
        barrier.wait(timeout=5)
        try:
            return acquire_ingress(upload_id, owner)
        except HTTPException as error:
            assert error.status_code == 429
            return None

    with ThreadPoolExecutor(max_workers=len(pairs)) as pool:
        results = list(pool.map(claim, pairs))
    accepted = [lease for lease in results if lease]
    try:
        assert len(accepted) == len(active_leases()) == 3
        assert all(sum(lease.owner_id == owner for lease in accepted) <= 2 for owner in ingress_case['owners'])
    finally:
        for lease in accepted:
            release_ingress(lease)


def test_expired_token_cannot_release_or_fail_replacement(ingress_case):
    from app.db import session_factory
    from app.models import now
    from app.upload_ingress import acquire_ingress, record_body_failure, release_ingress, renew_ingress
    from app.upload_models import UploadIngressLease, UploadReservation
    owner = ingress_case['owners'][0]
    upload_id = ingress_case['uploads'][owner][0]
    old = acquire_ingress(upload_id, owner)
    with session_factory()() as db:
        db.get(UploadIngressLease, old.id).expires_at = now() - timedelta(seconds=1)
        db.commit()
    replacement = acquire_ingress(upload_id, owner)
    try:
        assert not renew_ingress(old)
        release_ingress(old)
        record_body_failure(old, HTTPException(422, detail={'code': 'OLD_BAD_BODY', 'message': 'old generation'}))
        assert [lease.id for lease in active_leases()] == [replacement.id]
        with session_factory()() as db:
            receipt = db.get(UploadReservation, upload_id)
            assert receipt.status == 'awaiting_upload' and receipt.error_code is None
    finally:
        release_ingress(replacement)


def test_waiting_body_releases_identity_connection_and_disconnect_releases_slot(ingress_case):
    from app.db import engine

    async def run():
        entered, disconnect = asyncio.Event(), asyncio.Event()
        class Request:
            headers = {}
            async def stream(self):
                assert engine().pool.checkedout() == 0
                entered.set()
                await disconnect.wait()
                raise ClientDisconnect()
                yield b''
        task = asyncio.create_task(call_handler(ingress_case, Request()))
        try:
            await asyncio.wait_for(entered.wait(), 5)
            assert engine().pool.checkedout() == 0
            assert len(active_leases()) == 1
            assert engine().pool.checkedout() == 0
        finally:
            disconnect.set()
        with pytest.raises(ClientDisconnect):
            await asyncio.wait_for(task, 5)
        assert active_leases() == []
    asyncio.run(run())


def test_cancelled_waiting_body_releases_slot_and_preserves_retry(ingress_case):
    from app.upload_ingress import acquire_ingress, release_ingress
    async def run():
        entered = asyncio.Event()
        class Request:
            headers = {}
            async def stream(self):
                entered.set()
                await asyncio.Event().wait()
                yield b''
        task = asyncio.create_task(call_handler(ingress_case, Request()))
        await asyncio.wait_for(entered.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert active_leases() == []
        owner = ingress_case['owners'][0]
        replacement = acquire_ingress(ingress_case['uploads'][owner][0], owner)
        release_ingress(replacement)
    asyncio.run(run())


def test_cancel_during_r2_put_keeps_slot_and_heartbeat_until_thread_finishes(ingress_case, monkeypatch):
    from app.db import engine
    from app.models import now
    from app import upload_ingress
    # Accelerate only this test's immutable snapshot; production/admin input
    # keeps the >=15 second validation and real database configuration read.
    from app.system_settings import get_request_limits
    monkeypatch.setattr(upload_ingress, 'get_request_limits',
        lambda db: get_request_limits(db).model_copy(update={'upload_ingress_lease_seconds': .3}))
    entered, release = Event(), Event()
    put_connections = []
    class Store:
        def put(self, *args, **kwargs):
            put_connections.append(engine().pool.checkedout())
            entered.set()
            assert release.wait(5)
    monkeypatch.setattr(upload_ingress, 'get_store', lambda backend: Store())

    async def run():
        class Request:
            headers = {}
            async def stream(self):
                yield ingress_case['data']
        task = asyncio.create_task(call_handler(ingress_case, Request()))
        try:
            await until_async(entered.is_set)
            assert put_connections == [0]
            task.cancel()
            await asyncio.sleep(.65)  # More than two complete lease lifetimes.
            assert not task.done()
            leases = active_leases()
            assert len(leases) == 1 and leases[0].expires_at > now()
            assert engine().pool.checkedout() == 0
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert active_leases() == []
    asyncio.run(run())


@pytest.mark.parametrize('kind', ['first_byte_idle', 'empty_chunks_idle', 'total'])
def test_body_timeout_is_bounded_and_reservation_remains_retryable(ingress_case, kind):
    from app.db import session_factory
    from app.upload_models import UploadReservation
    configure_limits(upload_idle_timeout_seconds=.10 if kind != 'total' else .15,
                     upload_body_timeout_seconds=.24 if kind == 'total' else 1)
    async def run():
        class Request:
            headers = {}
            async def stream(self):
                while True:
                    await asyncio.sleep(1 if kind == 'first_byte_idle' else .035)
                    yield b'x' if kind == 'total' else b''
        started = time.monotonic()
        with pytest.raises(HTTPException) as error:
            await call_handler(ingress_case, Request())
        assert error.value.status_code == 408
        assert time.monotonic() - started < 2
        assert active_leases() == []
        with session_factory()() as db:
            receipt = db.get(UploadReservation, ingress_case['uploads'][ingress_case['owners'][0]][0])
            assert receipt.status == 'awaiting_upload' and receipt.error_code is None
    asyncio.run(run())


def test_lost_ingress_stops_waiting_for_client_body(ingress_case, monkeypatch):
    from app import upload_ingress
    configure_limits(upload_idle_timeout_seconds=5., upload_body_timeout_seconds=5.)
    async def lose_lease(lease, stopped, lost):
        await asyncio.sleep(.05)
        lost.set()
    monkeypatch.setattr(upload_ingress, 'keep_ingress_alive', lose_lease)
    async def run():
        class Request:
            headers = {}
            async def stream(self):
                await asyncio.sleep(3)
                yield ingress_case['data']
        started = time.monotonic()
        with pytest.raises(HTTPException) as error:
            await asyncio.wait_for(call_handler(ingress_case, Request()), 1.5)
        assert error.value.status_code == 409
        assert time.monotonic() - started < 1.5
        assert active_leases() == []
    asyncio.run(run())


def test_accepted_replay_does_not_read_body_or_allocate_slot(ingress_case, monkeypatch):
    from app import upload_ingress
    from app.db import session_factory
    from app.upload_models import UploadReservation
    owner = ingress_case['owners'][0]
    upload_id = ingress_case['uploads'][owner][0]
    with session_factory()() as db:
        receipt = db.get(UploadReservation, upload_id)
        receipt.status = 'validating'
        expires = receipt.expires_at
        db.commit()
    monkeypatch.setattr(upload_ingress, 'get_store', lambda *args: pytest.fail('replay must not access storage'))
    class Request:
        headers = {}
        async def stream(self):
            pytest.fail('accepted replay must not read its request body')
            yield b''
    result = asyncio.run(call_handler(ingress_case, Request()))
    assert result['status'] == 'validating'
    assert active_leases() == []
    with session_factory()() as db:
        assert db.get(UploadReservation, upload_id).expires_at == expires


def test_cancelled_acquisition_releases_committed_slot(ingress_case, monkeypatch):
    from app import upload_ingress
    acquired, release, returned = Event(), Event(), Event()
    actual = upload_ingress.acquire_ingress
    def delayed(*args):
        lease = actual(*args)
        acquired.set()
        try:
            assert release.wait(5)
            return lease
        finally:
            returned.set()
    monkeypatch.setattr(upload_ingress, 'acquire_ingress', delayed)
    async def run():
        class Request:
            headers = {}
            async def stream(self):
                pytest.fail('cancelled acquisition must not begin body reading')
                yield b''
        task = asyncio.create_task(call_handler(ingress_case, Request()))
        try:
            await until_async(acquired.is_set)
            task.cancel()
            await asyncio.sleep(.05)
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        await until_async(returned.is_set)
        assert active_leases() == []
    asyncio.run(run())


def test_settings_changes_only_affect_new_upload_timeout_and_renewal(ingress_case):
    from app.db import session_factory
    from app.models import now
    from app.upload_ingress import acquire_ingress, read_ingress_body, release_ingress, renew_ingress
    from app.upload_models import UploadIngressLease
    owner = ingress_case['owners'][0]
    configure_limits(upload_idle_timeout_seconds=.5, upload_body_timeout_seconds=1.,
                     upload_ingress_lease_seconds=15)
    old = acquire_ingress(ingress_case['uploads'][owner][0], owner)
    configure_limits(upload_idle_timeout_seconds=.1, upload_body_timeout_seconds=.15,
                     upload_ingress_lease_seconds=30)
    new = acquire_ingress(ingress_case['uploads'][owner][1], owner)
    try:
        assert old.limits.upload_idle_timeout_seconds == .5
        assert new.limits.upload_idle_timeout_seconds == .1
        assert renew_ingress(old) and renew_ingress(new)
        with session_factory()() as db:
            assert 14 < (db.get(UploadIngressLease, old.id).expires_at - now()).total_seconds() <= 15
            assert 29 < (db.get(UploadIngressLease, new.id).expires_at - now()).total_seconds() <= 30

        async def run():
            class DelayedRequest:
                headers = {}
                async def stream(self):
                    await asyncio.sleep(.22)
                    yield ingress_case['data']
            results = await asyncio.gather(
                read_ingress_body(DelayedRequest(), old, asyncio.Event()),
                read_ingress_body(DelayedRequest(), new, asyncio.Event()), return_exceptions=True)
            assert results[0] == ingress_case['data']
            assert isinstance(results[1], HTTPException) and results[1].status_code == 408
        asyncio.run(run())
    finally:
        release_ingress(old)
        release_ingress(new)
