"""Upstream capacity is mutable supplier state, not model/cache identity."""
from app.db import session_factory
from app.providers import configuration
from app.translation_models import TranslationProviderRevision
from app.translation_providers import resolve_credentials
from test_translation_providers import PATH, admin_case, body, create


def test_upstream_limit_changes_preserve_legacy_revision_and_cache_identity(admin_case):
    client, auth = admin_case
    provider = create(admin_case)
    # Simulate an existing version saved before upstream limits were separated.
    with session_factory()() as db:
        revision = db.get(TranslationProviderRevision, provider['revision_id'])
        revision.config = {**revision.config, 'requests_per_minute': 60}
        db.commit()
        before = configuration(db, 'classic', 'en', provider['id'])
    listed = client.get(PATH, headers=auth).json()['items'][0]
    assert listed['requests_per_minute'] == 60
    assert 'requests_per_minute' not in listed['config']
    payload = {key: listed[key] for key in ['name', 'channel', 'enabled', 'text_weight', 'title_weight', 'config']}
    updated = client.put(PATH + '/' + provider['id'], headers=auth, json={**payload, 'requests_per_minute': 120})
    assert updated.status_code == 200, updated.text
    assert updated.json()['requests_per_minute'] == 120
    assert updated.json()['revision_id'] == provider['revision_id']
    with session_factory()() as db:
        assert configuration(db, 'classic', 'en', provider['id']) == before
        assert db.get(TranslationProviderRevision, provider['revision_id']).config['requests_per_minute'] == 60
    assert resolve_credentials(before['text']) == 'isolated-new-key'
    changed = client.put(PATH + '/' + provider['id'], headers=auth, json={**payload,
        'requests_per_minute': 120, 'config': {**payload['config'], 'model': 'different-model'}})
    assert changed.status_code == 200
    assert changed.json()['revision_id'] != provider['revision_id']
    with session_factory()() as db:
        assert 'requests_per_minute' not in db.get(TranslationProviderRevision, changed.json()['revision_id']).config


def test_legacy_admin_input_promotes_limit_and_new_top_level_value_takes_precedence(admin_case):
    legacy = body()
    legacy.pop('requests_per_minute')
    legacy['config']['requests_per_minute'] = 45
    first = create(admin_case, legacy)
    second = create(admin_case, {**legacy, 'name': 'Second', 'requests_per_minute': 90})
    assert first['requests_per_minute'] == 45 and second['requests_per_minute'] == 90
    assert 'requests_per_minute' not in first['config'] and 'requests_per_minute' not in second['config']
    client, auth = admin_case
    for value in [True, 0, -1, 10001, 1.5]:
        assert client.post(PATH, headers=auth, json={**body(), 'requests_per_minute': value}).status_code == 422


def test_old_form_enabling_default_reasoning_creates_new_version_but_preserves_old_tasks(admin_case):
    client, auth = admin_case
    provider = create(admin_case)
    with session_factory()() as db:
        revision = db.get(TranslationProviderRevision, provider['revision_id'])
        revision.config = {key: value for key, value in revision.config.items() if key != 'reasoning_effort'}
        db.commit()
        before = configuration(db, 'classic', 'en', provider['id'])
    listed = client.get(PATH, headers=auth).json()['items'][0]
    assert 'reasoning_effort' not in listed['config']
    payload = {key: listed[key] for key in ['name', 'channel', 'enabled', 'text_weight', 'title_weight']}
    updated = client.put(PATH + '/' + provider['id'], headers=auth, json={**payload,
        'requests_per_minute': 120, 'config': {**listed['config'], 'reasoning_effort': 'none'}})
    assert updated.status_code == 200, updated.text
    assert updated.json()['revision_id'] != provider['revision_id']
    assert updated.json()['config']['reasoning_effort'] == 'none'
    assert resolve_credentials(before['text']) == 'isolated-new-key'
    with session_factory()() as db:
        assert 'reasoning_effort' not in db.get(TranslationProviderRevision, provider['revision_id']).config
