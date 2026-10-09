"""Explicit model selection, legacy UUIDs and entitlement-isolated choices; no upstream calls."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import pytest
from sqlalchemy import event, select

from app.db import engine, session_factory
from app.entitlements import settle
from app.models import Job, User, now
from app.providers import digest
from app.translation_api import TranslationInput
from app.translation_models import TranslationProvider
from conftest import configure_system_limits, login, login_plus, request_id, request_record
from test_cluster_submissions import cluster, descriptor, submit  # noqa: F401
from test_quota_purchase_admission import seed_purchase
from test_translation_providers import admin_case, body, create  # noqa: F401
from test_translation_requests import high_control_budget
from test_website_guests import visitor, submit as guest_submit  # noqa: F401


def model(case, plans=None, name='Public model', **values):
    return create(case, {**body(name, **values), 'text_plan_ids': plans})


def job(client, auth, response):
    assert response.status_code in (200, 202), response.text
    record = request_record(client, auth, response.json()['id'])
    with session_factory()() as db:
        return db.get(Job, record.job_id)


def test_catalog_displays_allowed_and_locked_models_without_secrets(admin_case):
    client, _ = admin_case
    free = model(admin_case)
    paid = model(admin_case, ['plus'], 'Advanced')
    model(admin_case, text_weight=0)
    auth = login(client)
    for headers in ({}, auth):
        response = client.get('/v1/capabilities', headers=headers)
        values = response.json()['translation_models']
        assert [item['id'] for item in values] == [free['id'], paid['id']]
        assert values[0]['available'] and not values[0]['requires_paid']
        assert not values[1]['available'] and values[1]['unavailable_reason'] == 'not_allowed'
        for private in ('revision_id', 'base_url', 'api_key', 'contract-text-model', 'isolated-new-key'):
            assert private not in response.text
    login_plus(client)
    assert all(item['available'] for item in client.get('/v1/capabilities', headers=auth).json()['translation_models'])


def test_catalog_reads_candidates_once_and_reuses_same_scope_queries(admin_case):
    client, _ = admin_case
    model(admin_case)
    model(admin_case, ['plus'])
    auth = login(client)
    def statements():
        found = []
        def track(_c, _cur, sql, _p, _ctx, _many):
            if sql.startswith('SELECT'):
                found.append(sql)
        event.listen(engine(), 'before_cursor_execute', track)
        try:
            assert client.get('/v1/capabilities', headers=auth).status_code == 200
        finally:
            event.remove(engine(), 'before_cursor_execute', track)
        return found
    baseline = statements()
    for index in range(5):
        model(admin_case, ['plus'], f'Advanced {index}')
    current = statements()
    assert len(current) == len(baseline)
    candidates = [sql for sql in current if 'JOIN translation_provider_revisions' in sql]
    assert len(candidates) == 1 and 'translation_provider_revisions.config' not in candidates[0]


def test_omitted_and_null_model_keep_exact_legacy_hash_and_uuid(admin_case):
    client, _ = admin_case
    model(admin_case)
    auth = login(client)
    payload = {'image': descriptor(b'legacy'), 'mode': 'classic', 'target_language': 'en'}
    expected = digest({**payload, 'image': {**payload['image'], 'normalization_version': 1},
                       'retry_of': None, 'regenerate_of': None, 'acknowledge_unknown_cost': False})
    assert digest(TranslationInput(**payload).model_dump(mode='json')) == expected
    url = '/v1/translations/' + request_id('legacy')
    first = client.put(url, headers=auth, json=payload)
    assert first.status_code == 202
    assert request_record(client, auth, first.json()['id']).request_hash == expected
    assert client.put(url, headers=auth, json={**payload, 'model_id': None}).json()['id'] == first.json()['id']


def test_selection_rejects_forged_locked_disabled_and_zero_weight(admin_case):
    client, _ = admin_case
    paid = model(admin_case, ['plus'])
    zero = model(admin_case, text_weight=0)
    disabled = model(admin_case)
    with session_factory()() as db:
        db.get(TranslationProvider, disabled['id']).enabled = False
        db.commit()
    auth = login(client)
    for model_id, status, code in [(paid['id'], 403, 'TRANSLATION_MODEL_NOT_ALLOWED'),
                                  (zero['id'], 503, 'TRANSLATION_MODEL_UNAVAILABLE'),
                                  (disabled['id'], 503, 'TRANSLATION_MODEL_UNAVAILABLE'),
                                  ('unknown', 422, 'TRANSLATION_MODEL_INVALID')]:
        response = submit(client, auth, descriptor(b'page'), model_id=model_id)
        assert response.status_code == status and response.json()['error']['code'] == code, response.text
    for invalid in ('', ' ', 1, {}, 'a' * 37):
        assert submit(client, auth, descriptor(b'page'), model_id=invalid).status_code == 422


def test_explicit_models_separate_results_reuse_auto_and_free_charge_order(admin_case):
    client, _ = admin_case
    free = model(admin_case)
    auth = login_plus(client, pages=2)
    image = descriptor(b'same')
    automatic = job(client, auth, submit(client, auth, image, key='automatic'))
    selected = submit(client, auth, image, key='selected', model_id=free['id'])
    assert job(client, auth, selected).id == automatic.id
    assert selected.json()['model'] == {'id': free['id'], 'name': free['name']}
    assert automatic.quota_kind == 'classic_daily'
    premium = model(admin_case, ['plus'])
    other = job(client, auth, submit(client, auth, image, key='premium', model_id=premium['id']))
    assert other.id != automatic.id and other.quota_kind == 'classic_monthly'
    assert submit(client, auth, image, key='selected', model_id=premium['id']).status_code == 409


def test_model_snapshot_replay_retry_and_regenerate(admin_case):
    client, _ = admin_case
    selected = model(admin_case)
    other = model(admin_case, name='Other')
    auth = login(client)
    response = submit(client, auth, descriptor(b'page'), key='first', model_id=selected['id'])
    original = job(client, auth, response)
    with session_factory()() as db:
        provider = db.get(TranslationProvider, selected['id'])
        provider.name, provider.enabled = 'Renamed', False
        db.commit()
    replay = submit(client, auth, descriptor(b'page'), key='first', model_id=selected['id'])
    assert replay.json()['model']['name'] == selected['name']
    assert client.post('/v1/translations/' + response.json()['id'] + '/cancel', headers=auth).status_code == 200
    url = '/v1/translations/' + request_id('retry')
    payload = {'retry_of': response.json()['id']}
    assert client.put(url, headers=auth, json={**payload, 'model_id': other['id']}).status_code == 409
    assert client.put(url, headers=auth, json=payload).status_code == 503
    with session_factory()() as db:
        db.get(TranslationProvider, selected['id']).enabled = True
        db.commit()
    retried = client.put(url, headers=auth, json=payload)
    current = job(client, auth, retried)
    assert current.id != original.id and current.config['text']['provider_id'] == selected['id']
    assert retried.json()['requested_model_id'] == selected['id']
    with session_factory()() as db:
        entry = db.get(Job, current.id)
        entry.status, entry.completed_at = 'no_text', now()
        settle(db, entry, success=False)
        db.commit()
    regenerated = client.put('/v1/translations/' + request_id('regenerate'), headers=auth,
        json={'regenerate_of': retried.json()['id'], 'model_id': other['id']})
    assert job(client, auth, regenerated).config['text']['provider_id'] == other['id']


def test_expired_rights_allow_owned_reuse_but_not_new_paid_jobs(admin_case):
    client, _ = admin_case
    paid = model(admin_case, ['plus'])
    auth = login_plus(client)
    image = descriptor(b'owned')
    first = job(client, auth, submit(client, auth, image, model_id=paid['id']))
    with session_factory()() as db:
        db.get(User, first.owner_id).plus_expires_at = now() - timedelta(seconds=1)
        db.commit()
    assert job(client, auth, submit(client, auth, image, key='reuse', model_id=paid['id'])).id == first.id
    assert submit(client, auth, descriptor(b'new'), key='new', model_id=paid['id']).status_code == 403
    stranger = login(client, 'stranger')
    assert submit(client, stranger, image, model_id=paid['id']).status_code == 403


def test_matching_purchase_skips_incompatible_earlier_bucket_and_last_page_race(admin_case):
    client, _ = admin_case
    auth = login(client)
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    with session_factory()() as db:
        wrong = seed_purchase(db, owner, pages=2, service='lite', end=now() + timedelta(hours=1))
        correct = seed_purchase(db, owner, pages=1, service='plus')
        wrong_id, correct_id = wrong.id, correct.id
        db.commit()
    paid = model(admin_case, ['plus'])
    high_control_budget()
    barrier = Barrier(2)
    def send(index):
        barrier.wait(timeout=10)
        return submit(client, auth, descriptor(str(index).encode()), key=str(index), model_id=paid['id'])
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(send, range(2)))
    assert sorted(response.status_code for response in results) == [202, 403]
    accepted = next(response for response in results if response.status_code == 202)
    assert job(client, auth, accepted).quota_period_id == correct_id
    with session_factory()() as db:
        from app.entitlement_models import QuotaPeriod
        assert db.get(QuotaPeriod, wrong_id).reserved == 0


def test_guest_uses_only_guest_models(visitor):
    client, _, _, _ = visitor
    admin = client, login(client, 'admin')
    free = model(admin)
    paid = model(admin, ['plus'])
    assert guest_submit(visitor, model_id=paid['id']).status_code == 403
    accepted = guest_submit(visitor, model_id=free['id'])
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()['model']['id'] == free['id']
