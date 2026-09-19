"""Reading plans fence window updates and directly apply task priorities."""
from datetime import timedelta
import pytest
from conftest import login, login_plus, png_variant, run_job, submit_asset, upload
from test_cluster_submissions import cluster, manifest, plan_item, submit


def accepted(client,auth,count=1,*,mode="classic",key="pages"):
    ids=[]
    for index in range(count):
        response=submit(client,auth,manifest(1,f"{key}-{index}"),mode=mode,key=f"{key}-{index}")
        assert response.status_code==202,response.text
        ids.append(response.json()["items"][0]["job"]["id"])
    return ids


def window_items(jobs):
    from sqlalchemy import select
    from app.db import session_factory
    from app.models import Job
    from app.plan_models import TranslationOperation
    with session_factory()() as db:
        items=[]
        for index,job_id in enumerate(jobs):
            job=db.get(Job,job_id)
            op=db.scalar(select(TranslationOperation).where(TranslationOperation.job_id==job_id))
            items.append(plan_item(op.descriptor["image"],op.operation_key,mode=job.mode,
                role="current" if index==0 else "prefetch",job_id=job.id))
        return items


def prioritize(client,auth,jobs,*,session_id="reader-a",sequence=1,**fields):
    return client.post("/v1/translation-plans",headers=auth,json={"trigger":"reading",
        "session_id":session_id,"sequence":sequence,"items":window_items(jobs),**fields})


def lease(client,auth,session_id="reader-a",**fields):
    return client.put(f"/v1/reading-sessions/{session_id}/lease",headers=auth,json={"modes":["classic"],**fields})


def delta(client,auth,cursor="0",limit=100,**params):
    response=client.get("/v1/me/translation-changes",headers=auth,
        params={"cursor":cursor,"limit":limit,**params})
    assert response.status_code==200,response.text
    return response.json()


def test_plan_is_limited_to_three_pages_not_three_unfinished_jobs(cluster):
    client,_=cluster
    auth=login(client)
    ids=accepted(client,auth,4)
    assert prioritize(client,auth,ids).status_code==422
    assert prioritize(client,auth,ids[:3]).status_code==200
    assert client.get(f"/v1/jobs/{ids[3]}",headers=auth).json()["status"]=="awaiting_upload"


def test_same_sequence_replay_and_conflict_never_reorder_window(cluster):
    client,_=cluster
    auth=login(client)
    ids=accepted(client,auth,2)
    first=prioritize(client,auth,ids,sequence=5)
    assert first.status_code==200,first.text
    cursor=delta(client,auth)["cursor"]
    repeated=prioritize(client,auth,ids,sequence=5)
    assert repeated.status_code==200
    assert delta(client,auth,cursor)["items"]==[]
    changed=prioritize(client,auth,list(reversed(ids)),sequence=5)
    assert changed.status_code==409 and changed.json()["error"]["code"]=="READING_SEQUENCE_CONFLICT"
    stale=prioritize(client,auth,ids,sequence=4)
    assert stale.status_code==409 and stale.json()["error"]["code"]=="STALE_READING_PLAN"


def test_stale_window_cannot_admit_new_work(cluster):
    client,_=cluster
    auth=login(client)
    ids=accepted(client,auth)
    assert prioritize(client,auth,ids,sequence=2).status_code==200
    response=client.post("/v1/translation-plans",headers=auth,json={"trigger":"reading",
        "session_id":"reader-a","sequence":1,"items":[plan_item(manifest(1,"old")[0],"old")]})
    assert response.status_code==409
    assert client.get("/v1/jobs",headers=auth).json()["total"]==1


def test_priority_takeover_fences_former_controller(cluster):
    client,_=cluster
    auth=login(client)
    ids=accepted(client,auth,2)
    first=prioritize(client,auth,ids[:1])
    assert first.status_code==200 and first.json()["priority"]["classic"]["owned"]
    background=prioritize(client,auth,ids[1:],session_id="reader-b")
    assert background.status_code==200 and not background.json()["priority"]["classic"]["owned"]
    epoch=background.json()["priority"]["classic"]["epoch"]
    takeover=lease(client,auth,"reader-b",priority_epochs={"classic":epoch},takeover=True)
    assert takeover.status_code==200 and takeover.json()["priority"]["classic"]["owned"]
    former=prioritize(client,auth,ids[:1],sequence=2,
                      priority_epochs={"classic":first.json()["priority"]["classic"]["epoch"]})
    assert former.status_code==409
    assert client.get(f"/v1/jobs/{ids[0]}",headers=auth).json()["priority"]=="preload"


def test_known_job_reference_is_owner_scoped(cluster):
    client,_=cluster
    alice,bob=login(client),login(client,"bob")
    foreign=accepted(client,bob)
    response=prioritize(client,alice,foreign)
    assert response.status_code==200 and response.json()["items"][0]["disposition"]=="blocked"
    assert response.json()["items"][0]["code"]=="NOT_FOUND"
    assert client.get("/v1/jobs",headers=alice).json()["total"]==0


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


def test_newly_admitted_window_is_prioritized_before_reply_and_empty_window_releases_it(cluster):
    from app.db import session_factory
    from app.models import Job
    client,_=cluster
    auth=login(client)
    response=submit(client,auth,manifest(3),key='atomic-reading')
    assert response.status_code==202
    ids=[item['job']['id'] for item in response.json()['items']]
    assert all(item['job']['priority']=='realtime' for item in response.json()['items'])
    with session_factory()() as db:
        assert [db.get(Job,job).priority_rank for job in ids]==[0,1,2]
    released=client.post('/v1/translation-plans',headers=auth,json={
        'trigger':'reading','session_id':'fixture-atomic-reading','sequence':2,'items':[]})
    assert released.status_code==200
    assert all(client.get(f'/v1/jobs/{job}',headers=auth).json()['priority']=='preload' for job in ids)
    assert all(client.get(f'/v1/jobs/{job}',headers=auth).json()['status']=='awaiting_upload' for job in ids)


def test_expired_session_can_resolve_accepted_operation_but_cannot_add_new_work(cluster,monkeypatch):
    from app.db import session_factory
    from app.models import now
    from app.plan_models import ReadingSession
    from test_cluster_submissions import resolve
    client,_=cluster
    auth=login(client)
    ids=accepted(client,auth)
    first=prioritize(client,auth,ids)
    assert first.status_code==200
    owner=client.get('/v1/me',headers=auth).json()['user']['id']
    with session_factory()() as db:
        db.get(ReadingSession,(owner,'reader-a')).expires_at=now()-timedelta(seconds=1)
        db.commit()
    response=client.post('/v1/translation-plans',headers=auth,json={
        'trigger':'reading','session_id':'reader-a','sequence':2,
        'items':[plan_item(manifest(1,'new')[0],'new')]})
    assert response.status_code==409 and response.json()['error']['code']=='READING_SESSION_EXPIRED'
    assert resolve(client,auth,['pages-0']).json()['items'][0]['job']['id']==ids[0]
    assert client.get('/v1/jobs',headers=auth).json()['total']==1
