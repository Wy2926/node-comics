"""Plan-aware admission with real entitlement rules and isolated model calls."""
from collections import Counter
from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import event, func, select

from app import classic
from app.adapters.llm import TextResponse
from app.billing_models import BillingPlan, BillingTerm
from app.db import engine, session_factory
from app.models import Job, Ledger, TextCall, User, now
from app.providers import configuration, configuration_resolver, digest
from app.translation_models import TranslationProvider
from app.translation_providers import has_provider, provider_profile, resolve_credentials
from app.translation_requests import TranslationRequest
from admission_test_utils import window_count
from conftest import login, login_plus, request_record
from test_classic import text_database, text_case  # noqa: F401
from test_cluster_submissions import cluster, descriptor, submit  # noqa: F401
from test_hourly_image_limit import lite  # noqa: F401
from test_stripe_billing import billing, invoice  # noqa: F401
from test_translation_providers import PATH, admin_case, body, create  # noqa: F401
from test_website_guests import visitor, submit as guest_submit  # noqa: F401


def supplier(case, plans, name='Plan supplier', **config):
    return create(case, {**body(name, **config), 'text_plan_ids': plans})


def job_for(client, auth, response):
    assert response.status_code == 202, response.text
    row = request_record(client, auth, response.json()['id'])
    with session_factory()() as db:
        return db.get(Job, row.job_id)


def test_admin_plan_validation_and_omitted_update_preserves_restrictions(admin_case):
    client, auth = admin_case
    for invalid in ([], ['missing'], [''], ['PLUS'], [True], 'plus', ['plus'] * 101):
        response = client.post(PATH, headers=auth, json={**body(), 'text_plan_ids': invalid})
        assert response.status_code == 422, response.text
    provider = supplier(admin_case, ['plus', 'free', 'plus'])
    assert provider['text_plan_ids'] == ['free', 'plus']
    assert {item['id'] for item in client.get(PATH, headers=auth).json()['plans']} >= {'guest', 'free', 'plus'}
    payload = {key: provider[key] for key in ('name', 'channel', 'enabled', 'text_weight', 'title_weight', 'config')}
    legacy = client.put(PATH + '/' + provider['id'], headers=auth, json=payload).json()
    assert legacy['text_plan_ids'] == ['free', 'plus']
    for scope in (['plus'], None):
        updated = client.put(PATH + '/' + provider['id'], headers=auth, json={**payload, 'text_plan_ids': scope})
        assert updated.status_code == 200, updated.text
        assert updated.json()['text_plan_ids'] == scope
        assert updated.json()['revision_id'] == provider['revision_id']
        assert 'isolated-new-key' not in updated.text


def test_plan_pools_keep_stable_weights_and_read_candidates_once(admin_case):
    with session_factory()() as db:
        db.add(BillingPlan(id='lite', name='Lite'))
        db.commit()
    free = supplier(admin_case, ['free'], 'Free')
    plus = supplier(admin_case, ['plus'], 'Plus')
    lite_a = supplier(admin_case, ['lite'], 'Lite A', text_weight=3)
    lite_b = supplier(admin_case, ['lite'], 'Lite B', text_weight=1)
    statements = []
    def track(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('SELECT'):
            statements.append(statement)
    with session_factory()() as db:
        event.listen(engine(), 'before_cursor_execute', track)
        try:
            resolve = configuration_resolver(db, 'classic', 'en', plan_id='lite')
            keys = [digest(index) for index in range(4000)]
            chosen = [resolve(key)['text']['provider_id'] for key in keys]
            assert chosen == [resolve(key)['text']['provider_id'] for key in keys]
            assert len(statements) == 1
            statements.clear()
            assert has_provider(db, plan_id='lite') and not has_provider(db, plan_id='guest')
            assert len(statements) == 2
            assert all('translation_provider_revisions.config' not in statement for statement in statements)
        finally:
            event.remove(engine(), 'before_cursor_execute', track)
        counts = Counter(chosen)
        assert counts.keys() == {lite_a['id'], lite_b['id']}
        assert 2850 < counts[lite_a['id']] < 3150
        for plan, expected in [('free', free), ('plus', plus)]:
            assert configuration(db, 'classic', 'en', plan_id=plan)['text']['provider_id'] == expected['id']
        with pytest.raises(HTTPException) as denied:
            configuration(db, 'classic', 'en', plus['id'], plan_id='free')
        assert denied.value.status_code == 503


@pytest.mark.parametrize('change', [{'text_weight': 0}, {'enabled': False}, {'text_plan_ids': ['free']}])
def test_stopped_plan_pool_cannot_fall_back_to_another_plan(admin_case, change):
    premium = supplier(admin_case, ['plus'], 'Premium')
    supplier(admin_case, ['free'], 'Other pool')
    with session_factory()() as db:
        original = configuration_resolver(db, 'classic', 'en', plan_id='plus')
        provider = db.get(TranslationProvider, premium['id'])
        for key, value in change.items():
            setattr(provider, key, value)
        db.commit()
        assert not has_provider(db, plan_id='plus')
        with pytest.raises(HTTPException) as denied:
            configuration(db, 'classic', 'en', plan_id='plus')
        assert denied.value.status_code == 503
        # A resolver already created for a request retains its frozen choices.
        assert original()['text']['provider_id'] == premium['id']


def test_missing_plan_fails_before_quota_and_capabilities_match_user(admin_case):
    client, _ = admin_case
    premium = supplier(admin_case, ['plus'])
    auth, paid = login(client), login_plus(client, 'paid')
    for headers, expected in (({}, False), (auth, False), (paid, True)):
        caps = client.get('/v1/capabilities', headers=headers).json()
        assert next(mode for mode in caps['modes'] if mode['id'] == 'classic')['enabled'] is expected
    denied = submit(client, auth, descriptor(b'page'))
    assert denied.status_code == 503
    assert denied.json()['error']['code'] == 'TRANSLATION_PROVIDER_UNAVAILABLE'
    assert window_count('image') == 0
    with session_factory()() as db:
        assert all(db.scalar(select(func.count()).select_from(model)) == 0 for model in (Job, Ledger, TranslationRequest))
        # Title lookup deliberately retains its independent shared pool.
        assert provider_profile(db, purpose='comic_title')['provider_id'] == premium['id']
    for injected in ({'plan_id': 'plus'}, {'provider_id': premium['id']}, {'text_plan_ids': ['plus']}):
        assert submit(client, auth, descriptor(b'page'), **injected).status_code == 422


def test_membership_changes_separate_new_models_but_replay_and_reuse_do_not_rebill(admin_case):
    client, _ = admin_case
    free = supplier(admin_case, ['free'], 'Free model', model='free-model')
    plus = supplier(admin_case, ['plus'], 'Plus model', model='plus-model')
    auth = login(client)
    image = descriptor(b'same-page')
    first = job_for(client, auth, submit(client, auth, image, key='first'))
    assert first.config['text']['provider_id'] == free['id'] and first.entitlement['plan'] == 'free'
    login_plus(client)
    assert job_for(client, auth, submit(client, auth, image, key='first')).id == first.id
    upgraded = job_for(client, auth, submit(client, auth, image, key='upgraded'))
    assert upgraded.config['text']['provider_id'] == plus['id'] and upgraded.entitlement['plan'] == 'plus'
    assert upgraded.cache_key != first.cache_key
    assert job_for(client, auth, submit(client, auth, image, key='reused')).id == upgraded.id
    with session_factory()() as db:
        owner = db.get(User, first.owner_id)
        owner.plus_expires_at = now() - timedelta(seconds=1)
        db.commit()
    assert job_for(client, auth, submit(client, auth, image, key='downgraded')).id == first.id
    other = login_plus(client, 'other')
    isolated = job_for(client, other, submit(client, other, image, key='first'))
    assert isolated.id != upgraded.id and isolated.owner_id != upgraded.owner_id
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job).where(Job.owner_id == first.owner_id)) == 2
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.owner_id == first.owner_id, Ledger.kind == 'reserve')) == 1


def test_completed_same_model_result_reuses_across_plan_change_without_new_admission(admin_case):
    from app.entitlements import settle
    client, _ = admin_case
    supplier(admin_case, None, 'Shared model')
    auth = login(client)
    image = descriptor(b'completed')
    job = job_for(client, auth, submit(client, auth, image, key='completed'))
    with session_factory()() as db:
        entry = db.get(Job, job.id)
        entry.status, entry.completed_at = 'no_text', now()
        settle(db, entry, success=True)
        db.commit()
    login_plus(client)
    reused = submit(client, auth, image, key='same-model')
    assert reused.status_code == 200 and reused.json()['state'] == 'succeeded'
    assert request_record(client, auth, reused.json()['id']).job_id == job.id
    assert window_count('image') == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'settle')) == 1


def test_explicit_retry_is_a_new_admission_using_current_plan(admin_case):
    from conftest import request_id
    client, _ = admin_case
    supplier(admin_case, ['free'], 'Free model')
    plus = supplier(admin_case, ['plus'], 'Plus model')
    auth = login(client)
    original = submit(client, auth, descriptor(b'retry'), key='failed')
    previous = job_for(client, auth, original)
    assert client.post('/v1/translations/' + original.json()['id'] + '/cancel', headers=auth).status_code == 200
    login_plus(client)
    def retry():
        return client.put('/v1/translations/' + request_id('retry'), headers=auth, json={'retry_of': original.json()['id']})
    retried = job_for(client, auth, retry())
    assert retried.id != previous.id and retried.config['text']['provider_id'] == plus['id']
    assert retried.entitlement['plan'] == 'plus'
    assert job_for(client, auth, retry()).id == retried.id
    assert window_count('image') == 2


@pytest.mark.parametrize('state', ['trial', 'paid', 'expired', 'revoked', 'scheduled', 'pending_gift'])
def test_lite_routes_from_granted_terms_not_subscription_or_pending_gifts(lite, state):
    client, auth = lite['client'], lite['auth']
    with session_factory()() as db:
        for provider in db.scalars(select(TranslationProvider)):
            provider.text_plan_ids = ['free']
        db.commit()
    selected = supplier((client, auth), ['lite'], 'Lite model', model='lite-model')
    if state == 'paid':
        from app.billing_sync import sync_subscription
        invoice(lite, total=599)
        sync_subscription('sub_fixture')
    elif state in {'expired', 'revoked', 'scheduled'}:
        with session_factory()() as db:
            for term in db.scalars(select(BillingTerm).where(BillingTerm.owner_id == lite['owner'])):
                if state == 'expired':
                    term.ends_at = now() - timedelta(seconds=1)
                elif state == 'revoked':
                    term.revoked_at = now()
                else:
                    term.starts_at = now() + timedelta(days=1)
            db.commit()
    elif state == 'pending_gift':
        login_plus(client, 'buyer')
        with session_factory()() as db:
            db.get(User, lite['owner']).plus_pending = True
            db.commit()
    accepted = job_for(client, auth, submit(client, auth, descriptor(b'lite-page')))
    expected_plan = 'free' if state in {'expired', 'revoked', 'scheduled'} else 'lite'
    assert accepted.entitlement['plan'] == expected_plan
    assert (accepted.config['text']['provider_id'] == selected['id']) is (expected_plan == 'lite')


def test_guest_has_an_independent_pool(visitor):
    client, _, owner, _ = visitor
    with session_factory()() as db:
        for provider in db.scalars(select(TranslationProvider)):
            provider.text_plan_ids = ['free']
        db.commit()
    assert guest_submit(visitor).status_code == 503
    provider = supplier((client, login(client, 'admin')), ['guest'], 'Guest model')
    response = guest_submit(visitor)
    assert response.status_code == 202, response.text
    with session_factory()() as db:
        job = db.scalar(select(Job).where(Job.owner_id == owner))
        assert job.entitlement['plan'] == 'guest'
        assert job.config['text']['provider_id'] == provider['id']


def test_worker_uses_frozen_model_after_plan_scope_and_revision_changes(text_case, monkeypatch):
    from app.translation_providers import ProviderWrite, write_provider
    job_id, lease_id = text_case
    with session_factory()() as db:
        job = db.get(Job, job_id)
        original = job.config['text']
        provider = db.get(TranslationProvider, original['provider_id'])
        write_provider(db, ProviderWrite(**{**body(model='replacement-model'), 'text_plan_ids': ['plus']}), provider)
        db.commit()
    assert resolve_credentials(original) == 'isolated-test-text-key'
    calls = []
    def model(segments, language, profile):
        calls.append(profile)
        return TextResponse('{"translations":{"b001":"你好"}}', {'input_tokens': 10, 'output_tokens': 2}, 'frozen')
    monkeypatch.setattr(classic, 'call_text', model)
    for _ in range(2):
        assert classic.run_text_stage(job_id, lease_id) == {'translations': {'b001': '你好'}}
    assert calls == [original]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
        assert db.get(Job, job_id).config['text'] == original
