"""Per-image admission is exact, atomic and independent of upload/job completion."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import pytest
from sqlalchemy import func, select
from conftest import configure_system_limits, login, login_plus, submit_asset, upload
from test_cluster_submissions import cluster, descriptor, grant_redraw, manifest, plan_item, resolve, submit


def counts():
    from app.db import session_factory
    from app.models import Job, Ledger
    from app.plan_models import ImageAdmission, TranslationOperation
    from app.upload_models import UploadReservation
    with session_factory()() as db:
        return {model.__name__: db.scalar(select(func.count()).select_from(model))
                for model in (Job, Ledger, ImageAdmission, TranslationOperation, UploadReservation)}


def high_control_budget():
    from app.config import settings
    settings().plan_request_burst = 1000
    settings().plan_requests_per_minute = 1000


@pytest.mark.parametrize('plus,limit', [(False,10), (True,100)])
def test_exact_rolling_limit_combines_devices_modes_and_languages(cluster, plus, limit, monkeypatch):
    from app import plan_limits
    from app.models import now
    client, _ = cluster
    auth = (login_plus if plus else login)(client)
    if not plus:
        grant_redraw(client, auth, 100)
    high_control_budget()
    clock = [now()]
    monkeypatch.setattr(plan_limits, 'server_now', lambda db: clock[0])
    for index in range(limit):
        item = plan_item(manifest(1, f'input-{index}')[0], f'op-{index}', mode='classic' if index % 2 else 'redraw')
        item['target_language'] = 'en' if index % 3 else 'zh-Hans'
        response = client.post('/v1/translation-plans', headers=auth, json={'trigger':'manual','items':[item]})
        assert response.status_code == 202, response.text
    before = counts()
    denied = submit(client, auth, manifest(1, 'last'), key='last')
    assert denied.status_code == 429, denied.text
    assert denied.json()['items'][0]['code'] == 'IMAGE_RATE_LIMITED'
    assert denied.json()['error']['scope'] == 'new_translation'
    assert denied.headers['Retry-After'] == '60'
    assert counts() == before
    replay = submit(client, auth, [manifest(1, 'input-0')[0]], key='another-key', mode='redraw')
    assert replay.status_code == 200 and replay.json()['items'][0]['disposition'] == 'pending'
    assert counts()['ImageAdmission'] == limit
    clock[0] += timedelta(seconds=59, milliseconds=999)
    assert submit(client, auth, manifest(1, 'last'), key='last').headers['Retry-After'] == '1'
    clock[0] += timedelta(milliseconds=1)
    accepted = submit(client, auth, manifest(1, 'last'), key='last')
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()['image_rate_limit']['remaining'] == limit - 1


def test_partial_admission_and_lookup_only_do_not_leak_rejected_rows(cluster):
    client, _ = cluster
    auth = login(client)
    configure_system_limits(free_images_per_minute=1)
    response = submit(client, auth, manifest(3))
    assert response.status_code == 202
    assert [item['disposition'] for item in response.json()['items']] == ['accepted','deferred','deferred']
    assert all(value == 1 for value in counts().values())
    retry = submit(client, auth, manifest(3), allow_new=False)
    assert retry.status_code == 200
    assert [item['disposition'] for item in retry.json()['items']] == ['pending','deferred','deferred']
    assert [item.get('code') for item in retry.json()['items'][1:]] == ['NEW_TRANSLATION_NOT_REQUESTED']*2
    assert all(value == 1 for value in counts().values())
    replay = submit(client, auth, manifest(3))
    assert replay.status_code == 200  # A pending page prevents all-deferred 429.
    assert replay.json()['items'][1]['code'] == 'IMAGE_RATE_LIMITED'


def test_cancel_does_not_refund_minute_admission(cluster):
    client, _ = cluster
    auth = login(client)
    configure_system_limits(free_images_per_minute=1)
    item = submit(client, auth, manifest(1)).json()['items'][0]
    assert client.post(f"/v1/jobs/{item['job']['id']}/cancel", headers=auth).status_code == 200
    response = submit(client, auth, manifest(1,'new'),key='new')
    assert response.status_code == 429
    assert counts()['ImageAdmission'] == 1
    assert client.get('/v1/me/entitlements', headers=auth).json()['modes']['classic']['quota']['reserved'] == 0


def test_existing_original_still_counts_when_translation_is_new(cluster, png):
    client, _ = cluster
    auth = login_plus(client)
    asset = upload(client, auth, png)
    configure_system_limits(plus_images_per_minute=1)
    response = submit_asset(client, auth, asset)
    assert response.status_code == 202 and response.json()['items'][0]['upload'] is None
    denied = submit_asset(client, auth, asset, key='other-language', language='en')
    assert denied.status_code == 429
    assert counts()['ImageAdmission'] == counts()['Job'] == 1


def test_idempotency_conflict_is_local_to_one_page(cluster):
    client, _ = cluster
    auth = login(client)
    original = submit(client, auth, manifest(1),key='same').json()['items'][0]
    items = [plan_item(manifest(1,'different')[0],'same'),
             plan_item(manifest(1,'independent')[0],'other',role='prefetch')]
    response = client.post('/v1/translation-plans',headers=auth,
        json={'trigger':'reading','session_id':'conflict-session','sequence':1,'items':items})
    assert response.status_code == 202
    assert response.json()['items'][0]['code'] == 'IDEMPOTENCY_CONFLICT'
    assert response.json()['items'][1]['disposition'] == 'accepted'
    assert counts()['Job'] == counts()['ImageAdmission'] == counts()['TranslationOperation'] == 2
    assert resolve(client,auth,['same']).json()['items'][0]['job']['id'] == original['job']['id']


def test_concurrent_devices_cannot_exceed_remaining_image_budget(cluster):
    client, _ = cluster
    auth = login(client)
    configure_system_limits(free_images_per_minute=5)
    barrier = Barrier(4)
    def request(index):
        barrier.wait(timeout=10)
        return submit(client,auth,manifest(2,f'device-{index}'),key=f'device-{index}')
    with ThreadPoolExecutor(4) as pool:
        responses = list(pool.map(request,range(4)))
    assert sum(item['disposition']=='accepted' for r in responses for item in r.json()['items']) == 5
    assert sorted(r.status_code for r in responses) == [202,202,202,429]
    assert counts()['Job'] == counts()['ImageAdmission'] == counts()['TranslationOperation'] == 5


def test_plus_downgrade_waits_for_enough_events_to_expire(cluster,monkeypatch):
    from app.db import session_factory
    from app.models import User, now
    from app.plan_models import ImageAdmission
    from app import plan_limits
    client, _ = cluster
    auth = login_plus(client)
    configure_system_limits(free_images_per_minute=2, plus_images_per_minute=4)
    at = now()
    monkeypatch.setattr(plan_limits,'server_now',lambda db: at)
    for index in range(4):
        assert submit(client,auth,manifest(1,f'p-{index}'),key=f'op-{index}').status_code == 202
    with session_factory()() as db:
        user = db.scalar(select(User).where(User.subject=='dev:alice'))
        user.plus_expires_at = at - timedelta(seconds=1)
        for index,row in enumerate(db.scalars(select(ImageAdmission).order_by(ImageAdmission.job_id))):
            row.admitted_at = at - timedelta(seconds=40-index*10)
        db.commit()
    denied = submit(client,auth,manifest(1,'new'),key='new')
    assert denied.status_code == 429
    assert denied.headers['Retry-After'] == '40'  # Third event must expire, not merely the oldest.


def test_old_submission_and_public_queue_routes_are_deleted(cluster):
    client,_ = cluster
    auth=login(client)
    for path in ['/v1/translation-submissions','/v1/translation-submissions/old',
                 '/v1/me/queues','/v1/me/queues/classic/items']:
        assert client.get(path,headers=auth).status_code == 404
    for path in ['/v1/translation-submissions','/v1/translation-submissions/old/cancel',
                 '/v1/me/queues/classic/priority','/v1/me/queues/classic/pause']:
        assert client.post(path,headers=auth,json={}).status_code == 404


def test_internal_error_rolls_back_entire_plan_and_no_receipt_escapes(cluster,monkeypatch):
    from app import plan_api
    client,_=cluster
    auth=login(client)
    actual=plan_api.accept_item
    def fail_second(db,user,item,allow_new,**kwargs):
        if item.role=='prefetch':
            raise RuntimeError('isolated transaction failure')
        return actual(db,user,item,allow_new,**kwargs)
    monkeypatch.setattr(plan_api,'accept_item',fail_second)
    with pytest.raises(RuntimeError,match='isolated transaction failure'):
        submit(client,auth,manifest(2))
    assert all(value==0 for value in counts().values())
    assert client.get('/v1/me/translation-changes',headers=auth).json()['items']==[]


def test_free_completed_result_is_available_with_exhausted_image_budget(cluster,png,monkeypatch):
    from app.adapters.images import TranslationOutput
    from app import workers
    from conftest import png_variant,run_job
    client,_=cluster
    alice,bob=login_plus(client,'alice'),login(client,'bob')
    source=upload(client,alice,png)
    done=submit_asset(client,alice,source).json()['items'][0]['job']
    monkeypatch.setattr(workers,'redraw',lambda *args:TranslationOutput(png))
    run_job(done['id'])
    configure_system_limits(free_images_per_minute=1)
    assert submit(client,bob,manifest(1,'busy'),key='busy').status_code==202
    reused=submit(client,bob,[descriptor(png)],key='cached',mode='redraw',max_pages=0,allow_new=False)
    assert reused.status_code==200,reused.text
    item=reused.json()['items'][0]
    assert item['disposition']=='ready' and item['job']['cache_hit']
    assert item['job']['id']!=done['id'] and item['job']['quota_pages']==0
    assert counts()['ImageAdmission']==2


def test_policy_revision_ignores_new_jobs_and_changes_for_configuration(cluster):
    client,_=cluster
    auth=login(client)
    first=submit(client,auth,manifest(1,'one'),key='one').json()
    second=submit(client,auth,manifest(1,'two'),key='two').json()
    assert first['policy_revision']==second['policy_revision']
    configure_system_limits(free_images_per_minute=31)
    policy=client.get('/v1/me/translation-changes',headers=auth,
        params={'cursor':second['items'][0]['job']['change_sequence'],'policy_revision':second['policy_revision']}).json()
    assert policy['policy_revision']!=second['policy_revision']


def test_image_backoff_header_is_exposed_to_extension_origin(cluster):
    client,_=cluster
    auth=login(client)
    configure_system_limits(free_images_per_minute=1)
    assert submit(client,auth,manifest(1),key='first').status_code==202
    response=submit(client,{**auth,'Origin':'http://localhost:5173'},manifest(1,'other'),key='other')
    assert response.status_code==429
    assert response.headers['Retry-After']
    assert 'retry-after' in response.headers['Access-Control-Expose-Headers'].lower()


def test_admission_event_cleanup_preserves_permanent_operation_key(cluster,monkeypatch):
    from app.db import session_factory
    from app.models import now
    from app.plan_models import ImageAdmission,TranslationOperation
    from app.plan_limits import clean_admissions
    client,_=cluster
    auth=login(client)
    first=submit(client,auth,manifest(1),key='permanent').json()['items'][0]
    assert client.post(f"/v1/jobs/{first['job']['id']}/cancel",headers=auth).status_code==200
    with session_factory()() as db:
        db.get(ImageAdmission,first['job']['id']).admitted_at=now()-timedelta(minutes=3)
        db.commit()
        clean_admissions(db)
        db.commit()
        assert db.scalar(select(func.count()).select_from(ImageAdmission))==0
        assert db.scalar(select(func.count()).select_from(TranslationOperation))==1
    replay=submit(client,auth,manifest(1),key='permanent')
    assert replay.status_code==200
    assert replay.json()['items'][0]['disposition']=='blocked'
    assert replay.json()['items'][0]['job']['id']==first['job']['id']
    assert counts()['Job']==1 and counts()['ImageAdmission']==0


def test_clean_contract_has_no_daily_receipt_or_account_queue_limits():
    from app.config import Settings
    assert not {'free_queue_capacity','plus_queue_capacity','submission_receipts_per_day',
                'submission_items_per_day','submission_large_batch_items',
                'operation_receipts_per_day'}.intersection(Settings.model_fields)
