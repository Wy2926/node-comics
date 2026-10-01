"""Anonymous credentials, admission and cleanup against isolated databases only."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import SecretStr
from sqlalchemy import select, func
from app import guests
from app.config import settings
from app.db import session_factory
from app.guest_models import GuestSession, GuestDailyUsage, GuestDailyBudget
from app.models import User, Job, Ledger, now
from app.translation_requests import TranslationRequest
from test_cluster_submissions import cluster, descriptor
from conftest import login

real_verify = guests.verify
real_throttle = guests.throttle


@pytest.fixture
def visitor(cluster, monkeypatch):
    client, _ = cluster
    client._transport.client = ('127.0.0.1', 50000)
    cfg = settings()
    cfg.guest_enabled = True
    cfg.guest_origin = 'http://testserver'
    cfg.turnstile_site_key = 'test-site'
    cfg.turnstile_secret_key = SecretStr('isolated-secret')
    cfg.guest_hash_secret = SecretStr('isolated-network-hmac-key-at-least-32')
    calls = []
    def verify(token, action):
        calls.append((token, action))
        if token != 'test-proof':
            guests.problem('VERIFICATION_FAILED', 'verification failed', 403)
    monkeypatch.setattr(guests, 'verify', verify)
    monkeypatch.setattr(guests, 'throttle', lambda *args, **kwargs: None)
    headers = {'X-Guest-Request': '1', 'Origin': 'http://testserver', 'X-Turnstile-Token': 'test-proof',
               'X-Translation-Protocol': 'overlay-v1'}
    response = client.post('/v1/guest/session', json={'token': 'test-proof'}, headers=headers)
    assert response.status_code == 200, response.text
    return client, headers, response.json()['user_id'], calls


def submit(visitor, content=b'page', key=None, **body):
    client, headers, *_ = visitor
    key = key or str(uuid4())
    return client.put('/v1/guest/translations/' + key, json={
        'image': descriptor(content), 'mode': 'classic', 'target_language': 'zh-Hans', **body}, headers=headers)


def cancel(visitor, value):
    client, headers, *_ = visitor
    response = client.post('/v1/guest/translations/' + value['id'] + '/cancel', headers=headers)
    assert response.status_code == 200, response.text


def test_guest_identity_is_not_a_registered_account(visitor):
    client, headers, owner, _ = visitor
    with session_factory()() as db:
        user = db.get(User, owner)
        assert user.kind == 'guest' and user.subject is None and user.role == 'user'
        row = db.scalar(select(GuestSession))
        cookie = client.cookies.get('nc-guest')
        assert cookie and row.token_hash != cookie and len(row.token_hash) == 64
    assert client.get('/v1/me', headers=headers).status_code == 401
    assert client.put('/v1/translations/' + str(uuid4()), json={}, headers=headers).status_code == 401
    admin = login(client, 'admin')
    accounts = client.get('/v1/admin/users', headers=admin).json()
    assert owner not in {row['id'] for row in accounts['items']}
    assert accounts['total'] == len(accounts['items']) == 1


def test_origin_protocol_and_proof_are_all_required(visitor):
    client, headers, *_ = visitor
    assert client.get('/v1/guest/session', headers={'X-Guest-Request': '0'}).status_code == 403
    assert client.post('/v1/guest/session', json={'token':'test-proof'}, headers={**headers,'Origin':'https://evil.example'}).status_code == 403
    payload = {'image': descriptor(b'page'), 'mode':'classic','target_language':'en'}
    url = '/v1/guest/translations/' + str(uuid4())
    assert client.put(url, json=payload, headers={**headers,'X-Translation-Protocol':'wrong'}).status_code == 409
    assert client.put(url, json=payload, headers={**headers,'X-Turnstile-Token':'bad'}).status_code == 403
    assert submit(visitor, mode='redraw').status_code == 403


def test_durable_five_attempts_replay_conflict_and_cancel(visitor):
    client, headers, owner, calls = visitor
    for index in range(5):
        key = str(uuid4())
        accepted = submit(visitor, f'page-{index}'.encode(), key)
        assert accepted.status_code == 202, accepted.text
        before = len(calls)
        replay = client.put('/v1/guest/translations/' + key, headers={**headers,'X-Turnstile-Token':''},
            json={'image':descriptor(f'page-{index}'.encode()),'mode':'classic','target_language':'zh-Hans'})
        assert replay.status_code == 202 and len(calls) == before
        assert submit(visitor, b'changed', key).status_code == 409
        cancel(visitor, accepted.json())
    assert submit(visitor, b'sixth').json()['error']['code'] == 'GUEST_DAILY_LIMIT'
    assert client.get('/v1/guest/session', headers=headers).json()['remaining'] == 0
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job).where(Job.owner_id == owner)) == 5
        assert db.scalar(select(func.sum(GuestDailyUsage.accepted_count))) == 5
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind=='guest_admit')) == 5


def test_network_budget_survives_cookie_reset_and_ip_header_spoof(visitor):
    client, headers, _, _ = visitor
    settings().guest_network_daily_limit = 1
    first = submit(visitor)
    assert first.status_code == 202, first.text
    cancel(visitor, first.json())
    client.cookies.clear()
    recreated = client.post('/v1/guest/session', json={'token':'test-proof'}, headers=headers)
    assert recreated.status_code == 200
    headers['X-Forwarded-For'] = '203.0.113.9'
    headers['CF-Connecting-IP'] = '203.0.113.9'
    assert submit(visitor, b'another').json()['error']['code'] == 'GUEST_NETWORK_LIMIT'
    assert client.get('/v1/guest/translations/' + first.json()['id'], headers=headers).status_code == 404
    assert client.get('/v1/guest/translations/' + first.json()['id'] + '/result', headers=headers).status_code == 404


def test_same_content_reuses_job_and_concurrent_new_content_has_one_slot(visitor):
    first = submit(visitor)
    second = submit(visitor)
    assert first.status_code == second.status_code == 202
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.sum(GuestDailyUsage.accepted_count))) == 1
    assert submit(visitor, b'other').json()['error']['code'] == 'GUEST_BUSY'
    cancel(visitor, first.json())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda index: submit(visitor, f'concurrent-{index}'.encode()), range(2)))
    assert sorted(response.status_code for response in results) == [202,429]


def test_global_budget_rollback_does_not_consume_guest_or_network(visitor):
    settings().guest_global_daily_limit = 1
    first = submit(visitor)
    assert first.status_code == 202
    cancel(visitor, first.json())
    response = submit(visitor,b'next')
    assert response.json()['error']['code'] == 'GUEST_GLOBAL_LIMIT'
    with session_factory()() as db:
        assert db.scalar(select(func.sum(GuestDailyUsage.accepted_count))) == 1
        assert sorted(db.scalars(select(GuestDailyBudget.accepted_count))) == [1,1]


@pytest.mark.parametrize(('setting','code'),[
    ('guest_network_daily_limit','GUEST_NETWORK_LIMIT'),
    ('guest_global_daily_limit','GUEST_GLOBAL_LIMIT'),
    ('guest_global_concurrency','GUEST_BUSY'),
])
def test_independent_guests_cannot_race_past_shared_limits(visitor,setting,code):
    from threading import Barrier
    client,headers,first_owner,_=visitor
    first_cookie=client.cookies.get('nc-guest')
    client.cookies.clear()
    second=client.post('/v1/guest/session',json={'token':'test-proof'},headers=headers)
    assert second.status_code==200 and second.json()['user_id']!=first_owner
    second_cookie=client.cookies.get('nc-guest')
    client.cookies.clear()
    setattr(settings(),setting,1)
    barrier=Barrier(2)
    def create(cookie):
        barrier.wait(timeout=10)
        return client.put('/v1/guest/translations/'+str(uuid4()),
            headers={**headers,'Cookie':'nc-guest='+cookie},
            json={'image':descriptor(cookie.encode()),'mode':'classic','target_language':'zh-Hans'})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(create,[first_cookie,second_cookie]))
    assert sorted(response.status_code for response in results)==[202,429]
    rejected=next(response for response in results if response.status_code==429)
    assert rejected.json()['error']['code']==code
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job))==1
        assert db.scalar(select(func.sum(GuestDailyUsage.accepted_count)))==1
        assert sorted(db.scalars(select(GuestDailyBudget.accepted_count)))==[1,1]
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind=='guest_admit'))==1


def test_upload_read_and_guest_result_expiry(visitor,png):
    client, headers, owner, _ = visitor
    accepted = submit(visitor,png).json()
    url='/v1/guest/translations/'+accepted['id']
    uploaded = client.put(url+'/input', content=png, headers={**headers,'Content-Type':'image/png'})
    assert uploaded.status_code in (200,202), uploaded.text
    with session_factory()() as db:
        entry=db.get(Job,db.get(TranslationRequest,(owner,accepted['id'])).job_id)
        entry.status='no_text';entry.completed_at=now()-timedelta(hours=25)
        db.commit()
    assert client.get(url,headers=headers).json()['error']['code']=='TRANSLATION_UNAVAILABLE'
    assert client.get(url+'/result',headers=headers).status_code==410
    from app.dispatcher import cleanup
    with session_factory()() as db:
        cleanup(db)
        assert db.get(TranslationRequest,(owner,accepted['id'])).revoked_at
        assert db.scalar(select(func.sum(GuestDailyUsage.accepted_count)))==1


def test_activity_and_manual_grants_cannot_award_visitors(visitor):
    client, headers, owner, _ = visitor
    from app.quota_campaigns import award_campaigns
    with session_factory()() as db:
        assert award_campaigns(db,db.get(User,owner))==0
    auth=login(client,'admin')
    for path,body in [('/quota-grants',{'mode':'classic','pages':10,'note':'test'}),('/membership',{'action':'extend','months':1,'note':'test'})]:
        response=client.post('/v1/admin/users/'+owner+path,headers={**auth,'Idempotency-Key':str(uuid4())},json=body)
        assert response.status_code==403,response.text


def test_disabled_feature_still_allows_existing_task_reads(visitor):
    client,headers,_,_=visitor
    accepted=submit(visitor).json()
    settings().guest_enabled=False
    assert client.get('/v1/guest/translations/'+accepted['id'],headers=headers).status_code==200
    # Real verifier performs the enablement check before contacting Cloudflare.
    with pytest.raises(Exception) as caught: guests.require_enabled()
    assert caught.value.status_code==503


def test_network_ipv6_uses_prefix_and_ignores_forwarded_headers(visitor):
    def req(ip):return SimpleNamespace(client=SimpleNamespace(host=ip),headers={'X-Forwarded-For':'8.8.8.8'})
    assert guests.network_key(req('2001:db8::1'))==guests.network_key(req('2001:db8::abcd'))
    assert guests.network_key(req('2001:db8::1'))!=guests.network_key(req('2001:db8:1::1'))
    assert guests.network_key(req('::ffff:127.0.0.1'))==guests.network_key(req('127.0.0.1'))


@pytest.mark.parametrize('payload', [None, {}, [], {'success':False},
    {'success':True,'hostname':'evil.example','action':'guest_translate'},
    {'success':True,'hostname':'testserver','action':'guest_session'},
    {'success':True,'hostname':'testserver','action':'guest_translate'}])
def test_real_verifier_requires_provider_success_hostname_and_action(visitor,monkeypatch,payload):
    import httpx
    client_type=httpx.Client
    def handle(request):
        assert str(request.url)=='https://challenges.cloudflare.com/turnstile/v0/siteverify'
        assert b'response=proof' in request.content
        return httpx.Response(200,content=b'invalid-json' if payload is None else __import__('json').dumps(payload).encode())
    monkeypatch.setattr(guests.httpx,'Client',lambda **kwargs:client_type(transport=httpx.MockTransport(handle),**kwargs))
    if payload=={'success':True,'hostname':'testserver','action':'guest_translate'}:
        real_verify('proof','guest_translate')
    else:
        with pytest.raises(Exception) as caught:real_verify('proof','guest_translate')
        assert caught.value.status_code in (403,503)


def test_real_verifier_network_failure_is_fail_closed(visitor,monkeypatch):
    import httpx
    client_type=httpx.Client
    def handle(request):raise httpx.ConnectError('synthetic outage')
    monkeypatch.setattr(guests.httpx,'Client',lambda **kwargs:client_type(transport=httpx.MockTransport(handle),**kwargs))
    with pytest.raises(Exception) as caught:real_verify('proof','guest_translate')
    assert caught.value.status_code==503


def test_guest_settings_reject_incomplete_or_production_test_configuration(monkeypatch):
    from test_identity_config import production
    from pydantic import ValidationError
    for values in [{'guest_enabled':True}, {'guest_enabled':True,'turnstile_site_key':'real-site',
            'turnstile_secret_key':'1x0000000000000000000000000000000AA','guest_hash_secret':'x'*32},
            {'guest_enabled':True,'guest_origin':'http://localhost','turnstile_site_key':'real-site',
            'turnstile_secret_key':'real-secret','guest_hash_secret':'x'*32}]:
        with pytest.raises(ValidationError):production(**values)
    assert production(guest_enabled=False).guest_enabled is False


def test_redis_outage_blocks_anonymous_api_before_new_admission(visitor,monkeypatch):
    from app.redis_state import AdmissionUnavailable
    client,headers,_,_=visitor
    monkeypatch.setattr(guests,'throttle',real_throttle)
    def unavailable(*args,**kwargs):raise AdmissionUnavailable()
    monkeypatch.setattr(guests.redis_state,'bucket',unavailable)
    response=submit(visitor)
    assert response.status_code==503
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job))==0


def test_guest_session_status_shares_the_read_request_limit(visitor, monkeypatch):
    client, headers, _, _ = visitor
    monkeypatch.setattr(guests, 'throttle', real_throttle)
    for _ in range(30):
        assert client.get('/v1/guest/session', headers=headers).status_code == 200
    response = client.get('/v1/guest/session', headers=headers)
    assert response.status_code == 429
    assert response.headers['Retry-After']


def test_remote_verification_releases_database_connection(visitor, monkeypatch):
    from app.db import engine
    client, headers, _, _ = visitor
    actions = []
    def verify(token, action):
        assert engine().pool.checkedout() == 0
        actions.append(action)
    monkeypatch.setattr(guests, 'verify', verify)
    client.cookies.clear()
    response = client.post('/v1/guest/session', json={'token': 'test-proof'}, headers=headers)
    assert response.status_code == 200, response.text
    assert submit(visitor).status_code == 202
    assert actions == ['guest_session', 'guest_translate']


def test_expired_sessions_bound_unused_owner_cleanup_and_keep_task_evidence(visitor):
    _, _, owner, _ = visitor
    accepted = submit(visitor).json()
    cancel(visitor, accepted)
    with session_factory()() as db:
        stamp = now()
        db.scalar(select(GuestSession).where(GuestSession.user_id == owner)).expires_at = stamp - timedelta(seconds=1)
        for index in range(201):
            user = User(id='expired-unused-' + str(index), kind='guest', subject=None, name='unused',
                role='user', created_at=stamp - timedelta(days=30))
            db.add(user)
            db.flush()
            db.add(GuestSession(user_id=user.id, token_hash=f'{index:064x}', expires_at=stamp - timedelta(seconds=1)))
        db.commit()
        guests.expire_guests(db)
        db.commit()
        assert db.scalar(select(func.count()).select_from(GuestSession)) == 2
        guests.expire_guests(db)
        db.commit()
        assert db.scalar(select(func.count()).select_from(GuestSession)) == 0
        assert list(db.scalars(select(User.id).where(User.kind == 'guest'))) == [owner]
        assert db.get(TranslationRequest, (owner, accepted['id'])) is not None
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'guest_admit')) == 1


def test_guest_credentials_are_not_an_oidc_account_and_identity_constraints_hold(visitor):
    from app.auth import token_for
    from sqlalchemy.exc import IntegrityError
    client,headers,owner,_=visitor
    with session_factory()() as db:
        user=db.get(User,owner)
        token=token_for(user)
        assert client.get('/v1/me',headers={'Authorization':'Bearer '+token}).status_code==401
        user.role='admin'
        with pytest.raises(IntegrityError):db.flush()
        db.rollback()
