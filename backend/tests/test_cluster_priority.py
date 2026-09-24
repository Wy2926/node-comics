"""Each translation has a one-way, bounded scheduling hint; no reader controller."""
from datetime import timedelta
from conftest import login, request_record
from test_cluster_submissions import cluster, manifest, submit
from app.db import session_factory
from app.models import Job, now


def job(client, auth, snapshot):
    record = request_record(client, auth, snapshot['id'])
    with session_factory()() as db:
        return db.get(Job, record.job_id)


def test_prefetch_can_be_promoted_once_and_late_prefetch_cannot_demote(cluster):
    client, _ = cluster
    auth = login(client)
    image = manifest(1)[0]
    first = submit(client, auth, image, priority='prefetch').json()
    initial = job(client, auth, first)
    assert initial.priority_rank > 0
    current = submit(client, auth, image, priority='current')
    assert current.status_code == 202
    promoted = job(client, auth, first)
    assert promoted.priority_rank == 0 and promoted.id == initial.id
    for priority in ['current', 'prefetch']:
        assert submit(client, auth, image, priority=priority).status_code == 202
        repeated = job(client, auth, first)
        assert repeated.priority_rank == 0 and repeated.realtime_until == promoted.realtime_until


def test_expired_priority_neither_revokes_work_nor_requires_heartbeat(cluster):
    client, _ = cluster
    auth = login(client)
    first = submit(client, auth, manifest(1)[0]).json()
    row = job(client, auth, first)
    with session_factory()() as db:
        db.get(Job, row.id).realtime_until = now() - timedelta(seconds=1)
        db.commit()
    response = client.get('/v1/translations/' + first['id'], headers=auth)
    assert response.status_code == 200 and response.json()['state'] == 'needs_input'
    assert submit(client, auth, manifest(1)[0]).status_code == 202
    assert job(client, auth, first).realtime_until < now()


def test_multiple_readers_are_all_allowed_current_priority(cluster):
    client, _ = cluster
    auth = login(client)
    replies = [submit(client, auth, manifest(1, f'device-{i}')[0], key=f'device-{i}').json() for i in range(5)]
    assert all(job(client, auth, reply).priority_rank == 0 for reply in replies)
    assert len({job(client, auth, reply).id for reply in replies}) == 5
    assert all(job(client, auth, reply).realtime_until > now() for reply in replies)


def test_unuploaded_classic_details_are_explicitly_not_ready(cluster):
    client, _ = cluster
    auth = login(client)
    first = submit(client, auth, manifest(1)[0]).json()
    job_id = job(client, auth, first).id
    response = client.get('/v1/translations/' + first['id'] + '/classic', headers=auth)
    assert response.status_code == 409 and response.json()['error']['code'] == 'INPUT_NOT_READY'
    assert client.get('/v1/translations/' + first['id'] + '/classic', headers=login(client, 'bob')).status_code == 404
