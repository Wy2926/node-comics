"""Body translation uses OCR and frozen guidance, without work-title metadata."""
import json

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from app import classic
from app.adapters import text as page_text
from app.adapters.llm import TextResponse
from app.db import session_factory
from app.documents.api import DocumentInput
from app.models import ClassicState, Job, TextCall
from app.providers import digest
from app.translation_api import TranslationInput
from conftest import configure_system_limits, login, request_id, request_record
from test_classic import analysis, text_case, text_database  # noqa: F401
from test_cluster_submissions import cluster, descriptor, submit  # noqa: F401
from test_document_quota_api import body as document_body, create as create_document, document_case  # noqa: F401
from test_translation_prompts import persisted_job
from test_website_guests import visitor, submit as guest_submit  # noqa: F401


@pytest.mark.parametrize('kind', ['page', 'document'])
@pytest.mark.parametrize('value', [None, '', 'A work name'])
def test_body_request_models_do_not_accept_removed_title_context(kind, value):
    with pytest.raises(ValidationError) as error:
        if kind == 'page':
            TranslationInput(image=descriptor(b'page'), mode='classic', target_language='zh-Hans', comic_title=value)
        else:
            DocumentInput(filename='not-a-title.zip', source_type='zip', byte_size=1234,
                          sha256='a' * 64, target_language='zh-Hans', comic_title=value)
    assert error.value.errors()[0]['type'] == 'extra_forbidden'


@pytest.mark.parametrize('kind', ['page', 'document'])
def test_removed_title_http_response_does_not_echo_private_input(document_case, kind):
    case = document_case
    if kind == 'page':
        path = '/v1/translations/' + request_id('removed-title')
        body = {'image': descriptor(b'page'), 'mode': 'classic', 'target_language': 'zh-Hans'}
    else:
        path, body = '/v1/documents/' + request_id('removed-title'), document_body(case)
    response = case.client.put(path, headers=case.auth, json={**body, 'comic_title': 'PRIVATE_TITLE_MARKER'})
    assert response.status_code == 422
    assert 'PRIVATE_TITLE_MARKER' not in response.text and 'input' not in response.text


def test_page_request_keeps_existing_hash_and_one_job_without_title(client):
    auth, image = login(client), descriptor(b'no-title')
    expected = digest({'image': {**image, 'normalization_version': 1}, 'mode': 'classic',
        'target_language': 'zh-Hans', 'retry_of': None, 'regenerate_of': None, 'acknowledge_unknown_cost': False})
    response = submit(client, auth, image, key='no-title')
    original = persisted_job(client, auth, response)
    repeated = persisted_job(client, auth, submit(client, auth, image, key='no-title'))
    reused = persisted_job(client, auth, submit(client, auth, image, key='another-no-title'))
    assert repeated.id == reused.id == original.id and 'comic_title' not in original.config
    assert 'comic_title' not in response.json()
    assert request_record(client, auth, response.json()['id']).request_hash == expected


def test_document_request_keeps_existing_hash_without_guessing_filename(document_case):
    case = document_case
    key = request_id('document-no-title')
    for _ in range(2):
        assert create_document(case, key=key, filename='A Famous Manga Chapter 01.zip') == key
    with session_factory()() as db:
        jobs = db.scalars(select(Job).where(Job.owner_id == case.owner, Job.idempotency_key == key)).all()
        assert len(jobs) == 1 and 'comic_title' not in jobs[0].config
        assert jobs[0].request_hash == digest(document_body(case, filename='A Famous Manga Chapter 01.zip'))


def test_guest_body_request_rejects_removed_title_context(visitor):
    assert guest_submit(visitor, comic_title='PRIVATE_TITLE_MARKER').status_code == 422


@pytest.mark.parametrize('repair', [False, True])
def test_frozen_guidance_and_ocr_ids_survive_repair_and_paid_replay(text_case, monkeypatch, repair):
    job_id, lease_id = text_case
    segments = [{'id': 'comic_title', 'source': 'This is a dialogue ID, not metadata.'},
                {'id': 'b001', 'source': 'Hello!'}]
    translated = {'comic_title': '这是台词。', 'b001': '你好！'}
    with session_factory()() as db:
        frozen = dict(db.get(Job, job_id).config)
        db.get(ClassicState, job_id).analysis = analysis(segments)
        db.commit()
    configure_system_limits(comic_translation_prompt='A changed instruction only for future jobs.')
    calls = []

    def invoke(messages, profile, *, json_schema):
        calls.append(messages)
        assert messages[0]['content'] == frozen['text_prompt'] + '\nTarget: "zh-Hans"'
        assert [row['role'] for row in messages] == ['system', 'user']
        assert json.loads(messages[1]['content']) == {row['id']: row['source'] for row in segments}
        assert json_schema['schema']['required'] == ['comic_title', 'b001']
        if repair and len(calls) == 1:
            configure_system_limits(comic_translation_prompt='Changed again during format repair.')
            return TextResponse('invalid', None, 'format-repair')
        return TextResponse(json.dumps(translated), {'input_tokens': 10, 'output_tokens': 2}, 'translated')

    monkeypatch.setattr(page_text, 'call_messages', invoke)
    monkeypatch.setattr(classic, 'call_text', page_text.call_text)
    monkeypatch.setattr(classic, 'wait_for_retry', lambda *args: None)
    assert classic.run_text_stage(job_id, lease_id) == {'translations': translated}
    assert classic.run_text_stage(job_id, lease_id) == {'translations': translated}
    assert len(calls) == (2 if repair else 1)
    bound = page_text.input_bound(segments, 'zh-Hans', frozen['text_prompt'])
    expected_cost = classic._cost_micros(frozen['text'], bound, frozen['text']['max_output_tokens'])
    with session_factory()() as db:
        records = db.scalars(select(TextCall).where(TextCall.job_id == job_id)).all()
        assert len(records) == len(calls) and all(row.reserved_micros == expected_cost for row in records)
        assert db.get(Job, job_id).config == frozen
