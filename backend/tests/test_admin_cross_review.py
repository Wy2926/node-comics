"""Cross-review probes for admin request concurrency and policy propagation."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from sqlalchemy import func, select
from conftest import login_plus


def test_provider_test_concurrent_receipt_does_not_duplicate_assets(client, png, monkeypatch):
    from app import admin_api
    from app.db import session_factory
    from app.models import Asset, Job
    auth = login_plus(client, 'admin')
    original = admin_api.job_for_request
    barrier = Barrier(2)
    def check(*args):
        result = original(*args)
        barrier.wait(timeout=10)
        return result
    monkeypatch.setattr(admin_api, 'job_for_request', check)
    def send(_):
        return client.post('/v1/admin/providers/default/test', headers={**auth, 'Idempotency-Key': 'parallel-probe'},
            files={'image': ('sample.png', png, 'image/png')})
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(send, range(2)))
    assert [reply.status_code for reply in replies] == [202, 202]
    assert replies[0].json()['id'] == replies[1].json()['id']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Asset)) == 1


def test_provider_test_rechecks_unknown_state_after_upload_preparation(client, png, monkeypatch):
    from app import admin_api
    from app.db import session_factory
    from app.models import Job
    auth = login_plus(client, 'admin')
    first = client.post('/v1/admin/providers/default/test', headers={**auth, 'Idempotency-Key': 'first-test'},
        files={'image': ('sample.png', png, 'image/png')})
    assert first.status_code == 202
    job_id = first.json()['id']
    configure = admin_api.configuration
    def become_unknown(*args):
        # Emulate a worker reporting a timeout while the request is preparing
        # its image, after the initial unresolved query but before admission.
        with session_factory()() as db:
            db.get(Job, job_id).status = 'outcome_unknown'
            db.commit()
        return configure(*args)
    monkeypatch.setattr(admin_api, 'configuration', become_unknown)
    repeated = client.post('/v1/admin/providers/default/test', headers={**auth, 'Idempotency-Key': 'new-test'},
        files={'image': ('sample.png', png, 'image/png')})
    assert repeated.status_code == 409, repeated.text
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
