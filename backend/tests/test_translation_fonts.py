"""Font choices are frozen request identity, never a mutable rendering preference."""
from datetime import timedelta
import json
from pathlib import Path
from typing import get_args
import pytest
from sqlalchemy import func, select

from app.db import session_factory
from app.entitlements import settle
from app.languages import LANGUAGES
from app.models import Job, now
from app.providers import digest
from app.queue_models import ComputeNode, ExecutionLease, JobStage
from app.translation_fonts import DEFAULT_FONTS, FONT_LANGUAGES, FontId, font_catalog
from conftest import create, login, login_plus, request_id, request_record, upload
from test_cluster_submissions import descriptor, submit
from test_compute_v3 import PREFIX, analyze, claim, text, v3  # noqa: F401


def job(client, auth, response):
    assert response.status_code < 300, response.text
    record = request_record(client, auth, response.json()['id'])
    with session_factory()() as db:
        return db.get(Job, record.job_id)


def test_font_catalog_covers_every_target_language(client):
    response = client.get('/v1/capabilities').json()
    assert response['translation_fonts'] == font_catalog()
    assert set().union(*map(set, FONT_LANGUAGES.values())) == set(LANGUAGES)
    assert all(sum(language in languages for languages in FONT_LANGUAGES.values()) >= 5 for language in LANGUAGES)
    assert set(DEFAULT_FONTS) == set(LANGUAGES)
    assert all(language in FONT_LANGUAGES[font] for language, font in DEFAULT_FONTS.items())
    root = Path(__file__).resolve().parents[2]
    for path in ('services/compute-node/assets.json', 'backend/shared/translation-fonts.json'):
        fonts = json.loads((root / path).read_text(encoding='utf-8'))['fonts']
        selectable = [item for item in fonts if 'id' in item]
        assert len(selectable) == len(FONT_LANGUAGES)
        assert {item['id']: tuple(item['languages']) for item in selectable} == FONT_LANGUAGES
    assert json.loads((root / 'backend/shared/translation-fonts.json').read_text(encoding='utf-8'))['defaults'] == DEFAULT_FONTS
    assert set(get_args(FontId)) == set(FONT_LANGUAGES)
    from app.compute_v3 import Registration
    schema = Registration.model_json_schema()['properties']['supported_font_ids']
    assert schema['maxItems'] == len(FONT_LANGUAGES)
    assert set(schema['items']['enum']) == set(FONT_LANGUAGES)


def test_omitted_null_and_empty_font_preserve_legacy_request_but_freeze_default(client):
    auth = login(client)
    payload = {'image': descriptor(b'legacy'), 'mode': 'classic', 'target_language': 'en'}
    expected = digest({**payload, 'image': {**payload['image'], 'normalization_version': 1},
        'retry_of': None, 'regenerate_of': None, 'acknowledge_unknown_cost': False})
    path = '/v1/translations/' + request_id('legacy')
    first = client.put(path, headers=auth, json=payload)
    original = job(client, auth, first)
    assert first.json()['font_id'] == original.config['font_id'] == DEFAULT_FONTS['en']
    assert request_record(client, auth, first.json()['id']).request_hash == expected
    for value in (None, ''):
        assert client.put(path, headers=auth, json={**payload, 'font_id': value}).json() == first.json()
        reused = submit(client, auth, payload['image'], key='reuse' + str(value), target_language='en', font_id=value)
        assert job(client, auth, reused).id == original.id
    explicit = submit(client, auth, payload['image'], key='explicit', target_language='en', font_id=DEFAULT_FONTS['en'])
    assert job(client, auth, explicit).id == original.id


def test_defaults_cover_every_language_and_replay_after_default_changes(client, monkeypatch):
    from test_translation_requests import high_control_budget
    high_control_budget()
    auth = login_plus(client)
    for language in LANGUAGES:
        image = descriptor(b'default-language')
        first = submit(client, auth, image, key=language, target_language=language)
        original = job(client, auth, first)
        assert first.json()['font_id'] == original.config['font_id'] == DEFAULT_FONTS[language]
        replacement = next(font for font, languages in FONT_LANGUAGES.items()
                           if language in languages and font != DEFAULT_FONTS[language])
        monkeypatch.setitem(DEFAULT_FONTS, language, replacement)
        for value in (None, ''):
            replay = submit(client, auth, image, key=language, target_language=language, font_id=value)
            assert replay.json() == first.json()
        new = submit(client, auth, image, key=language + '-new', target_language=language)
        assert new.json()['font_id'] == replacement
        assert job(client, auth, new).id != original.id


def test_historical_uuid_replay_does_not_relabel_or_regenerate_completed_results(client):
    from app.jobs import content_key
    auth = login_plus(client)
    image = descriptor(b'historical-result')
    original = job(client, auth, submit(client, auth, image, key='old', target_language='en'))
    with session_factory()() as db:
        entry = db.get(Job, original.id)
        config = {key: value for key, value in entry.config.items() if key != 'font_id'}
        config['version'] = 'legacy-render-version'
        entry.config = config
        entry.cache_key = content_key(entry.source_sha256, entry.mode, entry.target_language, config)
        entry.status, entry.completed_at = 'no_text', now()
        settle(db, entry, success=False)
        from app.translation_requests import TranslationRequest
        row = db.get(TranslationRequest, (entry.owner_id, request_id('old')))
        row.descriptor = {key: value for key, value in row.descriptor.items() if key != 'font_id'}
        old_hash, old_cache_key = row.request_hash, entry.cache_key
        db.commit()
    for fields in ({}, {'font_id': None}, {'font_id': ''}):
        replay = submit(client, auth, image, key='old', target_language='en', **fields)
        old = job(client, auth, replay)
        assert old.id == original.id and replay.json()['font_id'] is None
        assert old.config == config and old.cache_key == old_cache_key
        assert request_record(client, auth, replay.json()['id']).request_hash == old_hash
    new = job(client, auth, submit(client, auth, image, key='new', target_language='en'))
    assert new.id != original.id and new.cache_key != old_cache_key
    assert new.config['font_id'] == DEFAULT_FONTS['en']


@pytest.mark.parametrize('font_id,languages', FONT_LANGUAGES.items())
def test_each_font_accepts_only_its_languages(client, font_id, languages):
    auth = login_plus(client)
    for language in LANGUAGES:
        result = submit(client, auth, descriptor(b'font-language'), key=language,
            target_language=language, font_id=font_id)
        if language in languages:
            assert result.status_code == 202, result.text
            assert result.json()['font_id'] == font_id
        else:
            assert result.status_code == 422, result.text
            assert result.json()['error']['code'] == 'TRANSLATION_FONT_LANGUAGE_UNSUPPORTED'


def test_unknown_font_is_rejected_without_admission(client):
    auth = login(client)
    for value in ('unknown', '../../font.ttf', ' ', 1, {}, []):
        assert submit(client, auth, descriptor(b'font'), font_id=value).status_code == 422
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 0


def test_font_is_part_of_uuid_and_account_owned_result_identity(client):
    auth = login_plus(client)
    image = descriptor(b'same page')
    default = DEFAULT_FONTS['en']
    alternative = next(font for font, languages in FONT_LANGUAGES.items() if 'en' in languages and font != default)
    base = job(client, auth, submit(client, auth, image, key='base', target_language='en'))
    first = submit(client, auth, image, key='font', target_language='en', font_id=default)
    selected = job(client, auth, first)
    other = job(client, auth, submit(client, auth, image, key='other', target_language='en', font_id=alternative))
    assert base.id == selected.id
    assert len({base.id, selected.id, other.id}) == len({base.cache_key, selected.cache_key, other.cache_key}) == 2
    assert selected.config['font_id'] == default
    for value in (None, alternative):
        conflict = submit(client, auth, image, key='font', target_language='en', font_id=value)
        assert conflict.status_code == 409 and conflict.json()['error']['code'] == 'IDEMPOTENCY_CONFLICT'
    reused = submit(client, auth, image, key='reuse', target_language='en', font_id=default)
    assert job(client, auth, reused).id == selected.id
    stranger = login_plus(client, 'bob')
    private = submit(client, stranger, image, key='font', target_language='en', font_id=default)
    assert job(client, stranger, private).id != selected.id
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job).where(Job.owner_id == selected.owner_id)) == 2


def test_retry_inherits_font_and_regeneration_can_keep_change_or_reset(client):
    auth = login_plus(client)
    first = submit(client, auth, descriptor(b'page'), target_language='en', font_id='patrick-hand')
    original = job(client, auth, first)
    assert client.post('/v1/translations/' + first.json()['id'] + '/cancel', headers=auth).status_code == 200
    retry_path = '/v1/translations/' + request_id('retry')
    retry_body = {'retry_of': first.json()['id']}
    assert client.put(retry_path, headers=auth, json={**retry_body, 'font_id': 'comic-relief'}).status_code == 409
    retry = client.put(retry_path, headers=auth, json=retry_body)
    retried = job(client, auth, retry)
    assert retried.id != original.id and retried.config['font_id'] == retry.json()['font_id'] == 'patrick-hand'
    for value in (None, ''):
        assert client.put(retry_path, headers=auth, json={**retry_body, 'font_id': value}).json() == retry.json()
    with session_factory()() as db:
        entry = db.get(Job, retried.id)
        entry.status, entry.completed_at = 'no_text', now()
        settle(db, entry, success=False)
        db.commit()
    body = {'regenerate_of': retry.json()['id']}
    keep_path = '/v1/translations/' + request_id('keep')
    kept = job(client, auth, client.put(keep_path, headers=auth, json=body))
    assert kept.config['font_id'] == 'patrick-hand'
    assert client.put(keep_path, headers=auth, json={**body, 'font_id': None}).status_code == 409
    changed = job(client, auth, client.put('/v1/translations/' + request_id('change'), headers=auth,
        json={**body, 'font_id': 'comic-relief'}))
    assert changed.config['font_id'] == 'comic-relief'
    reset_path = '/v1/translations/' + request_id('reset')
    reset = client.put(reset_path, headers=auth, json={**body, 'font_id': None})
    assert job(client, auth, reset).config['font_id'] == reset.json()['font_id'] == DEFAULT_FONTS['en']
    assert client.put(reset_path, headers=auth, json={**body, 'font_id': ''}).json() == reset.json()
    assert client.put(reset_path, headers=auth, json=body).status_code == 409


@pytest.mark.parametrize('action', ['retry', 'regenerate'])
def test_historical_requests_without_a_frozen_font_resolve_the_default_when_reexecuted(client, action):
    auth = login_plus(client)
    source = submit(client, auth, descriptor(b'historical-source'), target_language='en')
    original = job(client, auth, source)
    with session_factory()() as db:
        entry = db.get(Job, original.id)
        entry.config = {key: value for key, value in entry.config.items() if key != 'font_id'}
        entry.status, entry.completed_at = ('cancelled' if action == 'retry' else 'no_text'), now()
        settle(db, entry, success=False)
        db.commit()
    for index, fields in enumerate(({}, {'font_id': None}, {'font_id': ''})):
        response = client.put('/v1/translations/' + request_id('rerun-' + str(index)), headers=auth,
            json={action + '_of': source.json()['id'], **fields})
        assert job(client, auth, response).config['font_id'] == response.json()['font_id'] == DEFAULT_FONTS['en']


@pytest.mark.parametrize('fields,legacy_font', [({}, False), ({'font_id': None}, False),
    ({'font_id': ''}, False), ({}, None), ({}, '')])
def test_default_and_historical_dispatch_require_the_effective_default_font(v3, png, fields, legacy_font):
    client, default = v3['client'], DEFAULT_FONTS['en']
    old_registration = {key: value for key, value in v3['registration'].items() if key != 'supported_font_ids'}
    assert client.post(PREFIX + '/nodes/register', headers=v3['auth'], json=old_registration).status_code == 200
    auth = login(client, 'default-font-reader')
    asset = upload(client, auth, png)
    response = create(client, auth, asset, key='default-font', language='en', **fields)
    assert response.status_code == 202, response.text
    job_id = response.json()['id']
    if legacy_font is not False:
        with session_factory()() as db:
            entry = db.get(Job, job_id)
            entry.config = {key: value for key, value in entry.config.items() if key != 'font_id'}
            if legacy_font is not None:
                entry.config = {**entry.config, 'font_id': legacy_font}
            db.commit()
    assert claim(v3).json()['leases'] == []
    alternative = next(font for font, languages in FONT_LANGUAGES.items() if 'en' in languages and font != default)
    wrong_registration = {**old_registration, 'supported_font_ids': [alternative]}
    assert client.post(PREFIX + '/nodes/register', headers=v3['auth'], json=wrong_registration).status_code == 200
    assert claim(v3).json()['leases'] == []
    supported = {**old_registration, 'supported_font_ids': [default]}
    assert client.post(PREFIX + '/nodes/register', headers=v3['auth'], json=supported).status_code == 200
    lease = claim(v3).json()['leases'][0]
    assert lease['job_id'] == job_id and lease['config']['font_id'] == default
    resumed = client.post(PREFIX + '/nodes/register', headers=v3['auth'], json=supported)
    assert resumed.status_code == 200 and resumed.json()['leases'][0]['config']['font_id'] == default
    assert client.post(PREFIX + '/nodes/register', headers=v3['auth'], json=wrong_registration).status_code == 409


def test_selected_font_dispatch_and_checkpoint_recovery_require_capable_node(v3, png):
    from app.dispatcher import recover_lease
    from app.models import TextCall
    from app.scheduler import has_claimable_work

    client = v3['client']
    old_registration = {key: value for key, value in v3['registration'].items() if key != 'supported_font_ids'}
    assert client.post(PREFIX + '/nodes/register', headers=v3['auth'], json=old_registration).status_code == 200
    auth = login(client, 'font-reader')
    asset = upload(client, auth, png)
    result = create(client, auth, asset, key='font', language='en', font_id='comic-relief')
    assert result.status_code == 202, result.text
    job_id = result.json()['id']
    # Existing v3 nodes without a font catalog cannot ignore font_id.
    assert claim(v3).json()['leases'] == []
    with session_factory()() as db:
        assert not has_claimable_work(db, v3['node']['node_id'], ['page'])
    registration = {**v3['registration'], 'supported_font_ids': ['patrick-hand']}
    assert client.post(PREFIX + '/nodes/register', headers=v3['auth'], json=registration).status_code == 200
    assert claim(v3).json()['leases'] == []
    registration['supported_font_ids'] = ['comic-relief', 'comic-relief']
    assert client.post(PREFIX + '/nodes/register', headers=v3['auth'], json=registration).status_code == 200
    with session_factory()() as db:
        assert db.get(ComputeNode, v3['node']['node_id']).runtime_report['supported_font_ids'] == ['comic-relief']
    lease = claim(v3).json()['leases'][0]
    assert lease['job_id'] == job_id and lease['config']['font_id'] == 'comic-relief'
    analyze(v3, lease)
    text(lease)
    downgraded = client.post(PREFIX + '/nodes/register', headers=v3['auth'], json=old_registration)
    assert downgraded.status_code == 409 and downgraded.json()['error']['code'] == 'NODE_FONT_CAPABILITY_CONFLICT'
    resumed = client.post(PREFIX + '/nodes/register', headers=v3['auth'], json=registration).json()['leases'][0]
    assert resumed['config'] == lease['config'] and resumed['translations'] is not None
    with session_factory()() as db:
        db.get(ExecutionLease, lease['lease_id']).expires_at = now() - timedelta(seconds=1)
        db.commit()
    recover_lease(lease['lease_id'])
    with session_factory()() as db:
        db.scalar(select(JobStage).where(JobStage.job_id == job_id, JobStage.name == 'page')).available_at = now()
        db.commit()
    recovered = claim(v3).json()['leases'][0]
    assert recovered['config']['font_id'] == 'comic-relief'
    assert recovered['analysis_hash'] == resumed['analysis_hash']
    assert recovered['translations'] == resumed['translations']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
