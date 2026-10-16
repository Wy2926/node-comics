"""Editable guidance, immutable jobs and cache boundaries; no live model calls."""
import json
from hashlib import sha256

import pytest
from sqlalchemy import select

from app import classic, comic_titles
from app.adapters import text as page_text
from app.adapters.llm import TextResponse
from app.db import session_factory
from app.documents import text as document_text
from app.jobs import content_key
from app.models import Job, TextCall
from app.providers import digest
from app.translation_models import TranslationProvider
from app.translation_prompts import PROMPT_DEFAULTS
from conftest import configure_system_limits, login, request_record
from test_classic import SEGMENTS, text_case, text_database  # noqa: F401
from test_cluster_submissions import descriptor, submit
from test_document_quota_api import document_case, create as create_document  # noqa: F401


FROZEN_V11_SYSTEM = 'Previously saved v11 system and contract.\nDo not rewrite.'


def persisted_job(client, auth, response):
    assert response.status_code in (200, 202), response.text
    record = request_record(client, auth, response.json()['id'])
    with session_factory()() as db:
        return db.get(Job, record.job_id)


@pytest.mark.parametrize('explicit', [False, True])
def test_prompt_changes_new_page_identity_but_not_uuid_or_title_only_changes(client, explicit):
    auth = login(client)
    with session_factory()() as db:
        provider = db.scalar(select(TranslationProvider))
        fields = {'model_id': provider.id} if explicit else {}
    image = descriptor(b'prompt-identity')
    original = persisted_job(client, auth, submit(client, auth, image, key='original', **fields))
    assert original.config['text_prompt'] == page_text.system_prompt(PROMPT_DEFAULTS['comic_translation_prompt'])
    assert original.config['prompt_version'] == page_text.PROMPT_VERSION
    assert 'text_prompt' not in client.get('/v1/translations/' + request_record(
        client, auth, 'original').id, headers=auth).text
    configure_system_limits(comic_title_prompt='A different title-search policy.')
    reused = persisted_job(client, auth, submit(client, auth, image, key='same-body', **fields))
    assert reused.id == original.id and reused.cache_key == original.cache_key
    guidance = 'Preserve 幻影術 as a name, not an ordinary word.'
    configure_system_limits(comic_translation_prompt=guidance)
    changed = persisted_job(client, auth, submit(client, auth, image, key='changed', **fields))
    assert changed.id != original.id and changed.cache_key != original.cache_key
    assert changed.config['version'] != original.config['version']
    assert changed.config['text'] == original.config['text']
    assert changed.config['text_prompt'] == page_text.system_prompt(guidance)
    replay = persisted_job(client, auth, submit(client, auth, image, key='original', **fields))
    assert replay.id == original.id and replay.config == original.config
    # Explicit/default selection of the same provider still reuses one identity.
    same = persisted_job(client, auth, submit(client, auth, image, key='current', model_id=provider.id))
    assert same.id == changed.id


@pytest.mark.parametrize('generation', ['legacy', 'stored-v11'])
def test_legacy_page_uuid_replays_while_new_request_uses_new_prompt_identity(client, generation):
    auth = login(client)
    image = descriptor(b'legacy-prompt-identity')
    original = persisted_job(client, auth, submit(client, auth, image, key='legacy'))
    with session_factory()() as db:
        job = db.get(Job, original.id)
        legacy = {key: value for key, value in job.config.items() if key != 'version'}
        if generation == 'legacy':
            legacy.pop('text_prompt')
            legacy['prompt_version'] = 'comic-json-v9'
        else:
            legacy['text_prompt'] = FROZEN_V11_SYSTEM
            legacy['prompt_version'] = 'comic-json-v11'
        job.config = {**legacy, 'version': digest(legacy)}
        job.cache_key = content_key(job.source_sha256, job.mode, job.target_language, job.config)
        db.commit()
        frozen = dict(job.config)
        previous_key = job.cache_key
    replay = persisted_job(client, auth, submit(client, auth, image, key='legacy'))
    assert replay.id == original.id and replay.config == frozen
    current = persisted_job(client, auth, submit(client, auth, image, key='new-intent'))
    assert current.id != original.id and current.cache_key != previous_key
    assert current.config['text_prompt'] == page_text.SYSTEM
    if generation == 'stored-v11':
        assert current.config['prompt_version'] == page_text.PROMPT_VERSION
        assert frozen['prompt_version'] == 'comic-json-v11'
        assert current.config['text_prompt'] != frozen['text_prompt']


@pytest.mark.parametrize('generation', ['current', 'stored-v11', 'stored-v10', 'legacy'])
def test_page_retry_and_checkpoint_replay_use_frozen_prompt_and_exact_cost(text_case, monkeypatch, generation):
    job_id, lease_id = text_case
    with session_factory()() as db:
        job = db.get(Job, job_id)
        if generation == 'legacy':
            job.config = {key: value for key, value in job.config.items() if key != 'text_prompt'}
            job.config = {**job.config, 'prompt_version': 'comic-json-v9'}
        elif generation == 'stored-v10':
            job.config = {**job.config, 'text_prompt': 'Previously saved v10 system and contract.\nDo not rewrite.',
                          'prompt_version': 'comic-json-v10'}
        elif generation == 'stored-v11':
            job.config = {**job.config, 'text_prompt': FROZEN_V11_SYSTEM,
                          'prompt_version': 'comic-json-v11'}
        db.commit()
        frozen = dict(job.config)
    expected = page_text.LEGACY_SYSTEM if generation == 'legacy' else frozen['text_prompt']
    configure_system_limits(comic_translation_prompt='A different future instruction. ' * 100)
    calls = []

    def invoke(segments, language, profile, prompt):
        calls.append(prompt)
        assert prompt == expected and profile == frozen['text']
        if len(calls) == 1:
            configure_system_limits(comic_translation_prompt='Changed between automatic format-repair calls.')
        return TextResponse('invalid' if len(calls) == 1 else '{"b001":"你好！"}',
                            None if len(calls) == 1 else {'input_tokens': 10, 'output_tokens': 2}, 'fixture')

    monkeypatch.setattr(classic, 'call_text', invoke)
    monkeypatch.setattr(classic, 'wait_for_retry', lambda *args: None)
    assert classic.run_text_stage(job_id, lease_id) == {'translations': {'b001': '你好！'}}
    configure_system_limits(comic_translation_prompt='Changed again after completion.')
    assert classic.run_text_stage(job_id, lease_id) == {'translations': {'b001': '你好！'}}
    assert calls == [expected, expected]
    expected_cost = classic._cost_micros(frozen['text'], page_text.input_bound(
        SEGMENTS, 'zh-Hans', expected),
                                       frozen['text']['max_output_tokens'])
    with session_factory()() as db:
        records = db.scalars(select(TextCall).where(TextCall.job_id == job_id).order_by(TextCall.sequence)).all()
        assert len(records) == 2 and all(call.reserved_micros == expected_cost for call in records)
        assert records[0].accounted_micros == expected_cost and records[0].error_code == 'TEXT_INVALID_RESPONSE'
        assert records[1].accounted_micros == classic._cost_micros(frozen['text'], 10, 2)
        assert db.get(Job, job_id).config == frozen


def test_document_admission_freezes_current_guidance_and_original_uuid(document_case):
    case = document_case
    configure_system_limits(free_daily_pages=5, comic_translation_prompt='Original document terminology.')
    first = create_document(case)
    with session_factory()() as db:
        original = db.scalar(select(Job).where(Job.owner_id == case.owner, Job.idempotency_key == first))
        original_id, frozen = original.id, original.config
    assert frozen['prompt_version'] == document_text.PROMPT_VERSION
    assert frozen['text_prompt'] == document_text.system_prompt('Original document terminology.')
    configure_system_limits(comic_translation_prompt='Updated document terminology.')
    assert create_document(case, key=first) == first
    second = create_document(case)
    with session_factory()() as db:
        assert db.get(Job, original_id).config == frozen
        updated = db.scalar(select(Job).where(Job.owner_id == case.owner, Job.idempotency_key == second))
        assert updated.config['text_prompt'] == document_text.system_prompt('Updated document terminology.')
        assert updated.config['version'] != frozen['version']
        assert updated.config['text'] == frozen['text']


def test_title_only_reads_current_guidance_on_cache_miss(client, monkeypatch):
    auth = login(client)
    configure_system_limits(comic_title_prompt='Preserve title wordplay and distinctive names.')
    reads, calls = [], []
    original = comic_titles.get_request_limits

    def current(db):
        reads.append(1)
        return original(db)

    def invoke(messages, profile):
        calls.append(messages)
        body = json.loads(messages[1]['content'])
        translated = {'月影の旅人': 'Moonshadow Wanderer', '夜明けの剣': 'Sword of Dawn'}[body['name']]
        return TextResponse(json.dumps({'name': translated, 'target_language': 'en'}), None, None)

    monkeypatch.setattr(comic_titles, 'get_request_limits', current)
    monkeypatch.setattr(comic_titles, 'call_messages', invoke)
    body = {'name': '月影の旅人', 'target_language': 'en'}
    first = client.post('/v1/comic-titles/translate', headers=auth, json=body)
    assert first.status_code == 200, first.text
    configure_system_limits(comic_title_prompt='Use consistent names; preserve uncertainty.')
    assert client.post('/v1/comic-titles/translate', headers=auth, json=body).json() == first.json()
    assert len(reads) == len(calls) == 1
    second = client.post('/v1/comic-titles/translate', headers=auth, json={**body, 'name': '夜明けの剣'})
    assert second.status_code == 200, second.text
    assert len(reads) == len(calls) == 2
    for call, guidance in zip(calls, ['Preserve title wordplay and distinctive names.',
                                     'Use consistent names; preserve uncertainty.']):
        assert call[0] == {'role': 'system', 'content': comic_titles.title_instructions(guidance)}
        assert call[0]['content'].endswith(comic_titles.TITLE_CONTRACT)
        assert [message['role'] for message in call] == ['system', 'user']


def test_guidance_is_literal_and_task_contract_cannot_be_removed():
    guidance = 'Preserve {name} and $Target as literal codes.\nReturn a glossary.'
    for build, contract in [(page_text.system_prompt, page_text.CONTRACT),
                            (document_text.system_prompt, document_text.CONTRACT),
                            (comic_titles.title_instructions, comic_titles.TITLE_CONTRACT)]:
        assert build(guidance) == guidance + '\n\n' + contract


def test_legacy_prompt_bytes_match_the_original_pre_settings_contract():
    # Hashes of the pre-settings SYSTEM literals: old jobs cannot silently adopt
    # revised instructions and paid whole-document responses must remain replayable.
    assert sha256(page_text.LEGACY_SYSTEM.encode()).hexdigest() == 'd7e7f42a6c0ecaf0f80172e142649ba28e771a222174988f35d1254790e83a8e'
    assert sha256(document_text.LEGACY_SYSTEM.encode()).hexdigest() == '9243cff365b50941c872e25f3ce2e26468cbcffadc6eebe743c13cc003cf27e0'
