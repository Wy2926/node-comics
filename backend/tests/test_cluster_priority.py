"""Public reading priorities and account changes use the durable submission contract."""
from datetime import timedelta

import pytest
from conftest import login, login_plus, png_variant, run_job, submit_asset, upload
from test_cluster_submissions import cluster, grant_redraw, manifest, queue_for, submit


def accepted(client, auth, count=1, *, mode='classic', key='pages'):
    response = submit(client, auth, manifest(count, key), mode=mode, key=key)
    assert response.status_code == 202, response.text
    return [item['job']['id'] for item in response.json()['items']]


def prioritize(client, auth, jobs, *, mode='classic', **fields):
    body = {'session_id':'reader-a', 'sequence':1, 'expected_version':0,
            'realtime_job_ids':jobs, 'ordered_job_ids':jobs, 'ttl_seconds':90, **fields}
    return client.post(f'/v1/me/queues/{mode}/priority', headers=auth, json=body)


def delta(client, auth, cursor='0', limit=100):
    response = client.get('/v1/me/translation-changes', headers=auth,
                          params={'cursor':cursor, 'limit':limit})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize('plus,limit', [(False,3),(True,10)])
def test_realtime_window_respects_account_limit(cluster, plus, limit):
    client, _ = cluster
    auth = (login_plus if plus else login)(client)
    if not plus:
        grant_redraw(client, auth, 20)
    for mode in ('classic','redraw'):
        ids = accepted(client, auth, limit, mode=mode, key=mode)
        rejected = prioritize(client, auth, ids+["over-limit"], mode=mode)
        assert rejected.status_code == 422 and rejected.json()['error']['code'] == 'REALTIME_LIMIT'
        assert queue_for(client, auth, mode)['realtime_count'] == 0
        response = prioritize(client, auth, ids[:limit], mode=mode, ordered_job_ids=ids)
        assert response.status_code == 200, response.text
        assert response.json()['realtime_job_ids'] == ids[:limit]
        summary = queue_for(client, auth, mode)
        assert summary['realtime_limit'] == summary['realtime_count'] == limit
        for job_id in ids:
            assert client.post(f'/v1/jobs/{job_id}/cancel',headers=auth).status_code == 200


@pytest.mark.parametrize('field', ['realtime_job_ids','ordered_job_ids'])
@pytest.mark.parametrize('wrong_scope', ['user','mode'])
def test_priority_rejects_other_accounts_and_modes_without_mutation(cluster, field, wrong_scope):
    client, _ = cluster
    auth = login_plus(client)
    own = accepted(client, auth, key='own')
    wrong = accepted(client, login_plus(client,'bob') if wrong_scope == 'user' else auth,
                     mode='redraw' if wrong_scope == 'mode' else 'classic', key='other')
    response = prioritize(client, auth, own, **{field:wrong})
    assert response.status_code == 404 and response.json()['error']['code'] == 'NOT_FOUND'
    assert queue_for(client, auth)['version'] == 0
    assert queue_for(client, auth)['realtime_count'] == 0
    assert prioritize(client, {}, own).status_code == 401


def test_global_ttl_cap_demotes_both_modes_for_all_accounts(cluster, monkeypatch):
    from app import jobs, queue_api, scheduler
    from app.config import settings
    from app.models import now
    client, _ = cluster
    accounts = [login_plus(client,name) for name in ('alice','bob')]
    items = [(auth,mode,accepted(client,auth,mode=mode,key=mode))
             for auth in accounts for mode in ('classic','redraw')]
    clock = [now()]
    for module in (jobs,queue_api,scheduler):
        monkeypatch.setattr(module,'now',lambda:clock[0])
    settings().priority_ttl_seconds = 20
    for auth,mode,ids in items:
        response = prioritize(client,auth,ids,mode=mode,ttl_seconds=300)
        assert response.status_code == 200, response.text
        assert response.json()['expires_at'] == (clock[0]+timedelta(seconds=20)).isoformat()+'Z'
        assert queue_for(client,auth,mode)['realtime_count'] == 1
    clock[0] += timedelta(seconds=20)
    for auth,mode,ids in items:
        assert queue_for(client,auth,mode)['realtime_count'] == 0
        assert client.get(f'/v1/jobs/{ids[0]}',headers=auth).json()['priority'] == 'preload'
        response = prioritize(client,auth,ids,mode=mode,session_id='new-device',sequence=0,expected_version=1)
        assert response.status_code == 200, response.text  # An expired controller needs no takeover.


def test_priority_sequence_replay_is_idempotent_and_conflicts_are_rejected(cluster):
    client, _ = cluster
    auth = login(client)
    ids = accepted(client,auth,2)
    first = prioritize(client,auth,[ids[1]],ordered_job_ids=ids,sequence=5)
    assert first.status_code == 200, first.text
    before = delta(client,auth)
    repeated = prioritize(client,auth,[ids[1]],ordered_job_ids=ids,sequence=5,expected_version=0)
    assert repeated.json() == first.json()
    assert delta(client,auth,before['cursor'])['items'] == []
    changed = prioritize(client,auth,[ids[0]],sequence=5,expected_version=1)
    older = prioritize(client,auth,[ids[0]],sequence=4,expected_version=1)
    for response in (changed,older):
        assert response.status_code == 409 and response.json()['error']['code'] == 'STALE_PRIORITY'
    conflicting = prioritize(client,auth,ids,sequence=6,expected_version=0)
    assert conflicting.status_code == 409
    assert conflicting.json()['error']['code'] == 'QUEUE_VERSION_CONFLICT'
    assert conflicting.json()['error']['version'] == 1
    current = prioritize(client,auth,ids,sequence=6,expected_version=1)
    assert current.status_code == 200 and current.json()['version'] == 2


def test_foreground_takeover_prevents_background_devices_stealing_priority(cluster):
    client, _ = cluster
    auth = login(client)
    ids = accepted(client,auth,2)
    assert prioritize(client,auth,[ids[0]]).status_code == 200
    background = prioritize(client,auth,[ids[1]],session_id='reader-b',sequence=0,expected_version=1)
    assert background.status_code == 409 and background.json()['error']['code'] == 'READING_SESSION_ACTIVE'
    takeover = prioritize(client,auth,[ids[1]],session_id='reader-b',sequence=0,expected_version=1,takeover=True)
    assert takeover.status_code == 200 and takeover.json()['session_id'] == 'reader-b'
    former = prioritize(client,auth,[ids[0]],sequence=2,expected_version=2)
    assert former.status_code == 409 and former.json()['error']['code'] == 'READING_SESSION_ACTIVE'
    summary = queue_for(client,auth)
    assert summary['session_id'] == 'reader-b' and summary['version'] == 2
    assert client.get(f'/v1/jobs/{ids[1]}',headers=auth).json()['priority'] == 'realtime'
    assert client.get(f'/v1/jobs/{ids[0]}',headers=auth).json()['priority'] == 'preload'


def test_pause_is_mode_local_and_running_stages_keep_their_lease(cluster, png):
    from app.config import settings
    from app.db import session_factory
    from app.queue_models import ComputeNode
    from app.scheduler import claim_stage, current_lease
    client, _ = cluster
    auth = login_plus(client)
    ids = {}
    for mode in ('classic','redraw'):
        ids[mode] = []
        for index in range(2):
            response = submit_asset(client,auth,upload(client,auth,png_variant(png,index)),key=f'{mode}-{index}',mode=mode)
            assert response.status_code == 202, response.text
            ids[mode].append(response.json()['items'][0]['job']['id'])
    with session_factory()() as db:
        db.add(ComputeNode(applied_config_version=1, supported_languages=['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko'], id='priority-node',name='test',resource_id='priority-node',capabilities=['analyze','redraw'],
                           capacity=4,engine_version=settings().classic_engine_version,device='cpu'))
        db.commit()
        lease = claim_stage(db,'priority-node',['analyze'])
        db.commit()
        assert lease is not None
        running_id,lease_id = lease.job_id,lease.id
    paused = client.post('/v1/me/queues/classic/pause',headers=auth,json={'paused':True})
    assert paused.status_code == 200 and paused.json()['paused']
    version = paused.json()['version']
    assert client.post('/v1/me/queues/classic/pause',headers=auth,json={'paused':True}).json()['version'] == version
    assert not queue_for(client,auth,'redraw')['paused']
    with session_factory()() as db:
        assert current_lease(db,lease_id)[2].id == running_id
        assert claim_stage(db,'priority-node',['analyze']) is None
        assert claim_stage(db,'priority-node',['redraw']) is not None
        db.commit()
    running = client.get(f'/v1/jobs/{running_id}',headers=auth).json()
    assert running['status'] == 'running' and not running['cancel_requested']
    assert client.post('/v1/me/queues/classic/pause',headers=auth,json={'paused':False}).json()['version'] == version+1
    assert client.post('/v1/me/queues/redraw/pause',headers=auth,json={'paused':True}).json()['paused']
    with session_factory()() as db:
        assert claim_stage(db,'priority-node',['analyze']) is not None
        db.commit()


def test_change_cursor_paginates_account_jobs_and_delivers_later_mutations(cluster, png, monkeypatch):
    from app import workers
    from app.adapters.images import TranslationOutput
    client, _ = cluster
    auth = login_plus(client)
    completed_asset = upload(client,auth,png)
    response = submit_asset(client,auth,completed_asset,key='will-complete')
    assert response.status_code == 202, response.text
    complete_id = response.json()['items'][0]['job']['id']
    ids = accepted(client,auth,5,key='paginate')
    foreign = accepted(client,login_plus(client,'bob'),3,key='foreign')
    cursor,found = '0',[]
    while True:
        page = delta(client,auth,cursor,2)
        assert len(page['items']) <= 2
        assert all(j['change_sequence'] > int(cursor) for j in page['items'])
        found.extend(j['id'] for j in page['items'])
        assert not set(foreign).intersection(found)
        cursor = page['cursor']
        if not page['has_more']:
            break
    assert len(found) == len(set(found)) == 6
    assert set(found) == {complete_id,*ids}
    assert delta(client,auth,cursor)['items'] == []
    assert client.post(f'/v1/jobs/{ids[0]}/cancel',headers=auth).status_code == 200
    monkeypatch.setattr(workers,'redraw',lambda *args:TranslationOutput(png))
    run_job(complete_id)
    updates = delta(client,auth,cursor)
    mapped = {j['id']:j for j in updates['items']}
    assert mapped[ids[0]]['status'] == 'cancelled'
    assert mapped[complete_id]['status'] == 'succeeded' and mapped[complete_id]['result_available']
    cursor = updates['cursor']
    assert client.delete(f'/v1/images/{mapped[complete_id]["output_asset_id"]}',headers=auth).status_code == 200
    deleted = delta(client,auth,cursor)
    assert [j['id'] for j in deleted['items']] == [complete_id]
    assert deleted['items'][0]['result_expired'] and deleted['items'][0]['output_asset_id'] is None
    assert int(deleted['cursor']) > int(cursor)
    assert delta(client,auth,deleted['cursor'])['items'] == []
    assert client.get('/v1/me/translation-changes?cursor=-1',headers=auth).status_code == 422
    assert client.get('/v1/me/translation-changes').status_code == 401


def test_unuploaded_classic_details_are_explicitly_not_ready(cluster):
    client, _ = cluster
    auth = login(client)
    job = accepted(client,auth)[0]
    response = client.get(f'/v1/jobs/{job}/classic',headers=auth)
    assert response.status_code == 409 and response.json()['error']['code'] == 'INPUT_NOT_READY'
    assert client.get(f'/v1/jobs/{job}/classic',headers=login(client,'bob')).status_code == 404
