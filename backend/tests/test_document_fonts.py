"""Documents keep their public API while freezing and fencing the language font."""
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.db import session_factory
from app.documents.api import DocumentInput
from app.models import Job, now
from app.providers import digest
from app.translation_fonts import DEFAULT_FONTS, FONT_LANGUAGES
from test_compute_v3 import PREFIX as IMAGE_PREFIX, v3  # noqa: F401
from test_document_compute import claim, create, documents  # noqa: F401
from test_document_quota_api import body, create as create_upload, document_case  # noqa: F401


def test_document_creation_freezes_language_default_without_changing_uuid_identity(document_case, monkeypatch):
    case = document_case
    for language, default in tuple(DEFAULT_FONTS.items()):
        key = create_upload(case, target_language=language)
        with session_factory()() as db:
            entry = db.scalar(select(Job).where(Job.owner_id == case.owner, Job.idempotency_key == key))
            assert entry.config['font_id'] == default
            assert entry.request_hash == digest(DocumentInput.model_validate(body(case, target_language=language)).model_dump())
            original_config, job_id = entry.config, entry.id
        replacement = next(font for font, languages in FONT_LANGUAGES.items() if language in languages and font != default)
        monkeypatch.setitem(DEFAULT_FONTS, language, replacement)
        assert create_upload(case, key=key, target_language=language) == key
        with session_factory()() as db:
            assert db.get(Job, job_id).config == original_config
        new = create_upload(case, target_language=language)
        with session_factory()() as db:
            entry = db.scalar(select(Job).where(Job.owner_id == case.owner, Job.idempotency_key == new))
            assert entry.config['font_id'] == replacement
    # Font selection remains a plugin/image feature, not a new document API.
    response = case.client.put('/v1/documents/' + str(uuid4()), headers=case.auth,
        json=body(case, font_id=DEFAULT_FONTS['zh-Hans']))
    assert response.status_code == 422


def test_historical_document_replay_preserves_its_original_configuration(document_case):
    case, key = document_case, create_upload(document_case)
    with session_factory()() as db:
        entry = db.scalar(select(Job).where(Job.owner_id == case.owner, Job.idempotency_key == key))
        entry.config = {key: value for key, value in entry.config.items() if key != 'font_id'}
        entry.status, entry.completed_at = 'succeeded', now()
        job_id, original_config = entry.id, entry.config
        db.commit()
    assert create_upload(case, key=key) == key
    with session_factory()() as db:
        entry = db.get(Job, job_id)
        assert entry.config == original_config and entry.status == 'succeeded'


@pytest.mark.parametrize('legacy', [False, True])
def test_document_claim_and_resume_require_the_effective_language_font(documents, legacy):
    case, node = documents, documents.v3
    client, default = node['client'], DEFAULT_FONTS['zh-Hans']
    unsupported = {key: value for key, value in node['registration'].items() if key != 'supported_font_ids'}
    unsupported['document_protocol'] = 2
    assert client.post(IMAGE_PREFIX + '/nodes/register', headers=node['auth'], json=unsupported).status_code == 200
    job_id = create(case, prepared=False)
    if legacy:
        with session_factory()() as db:
            entry = db.get(Job, job_id)
            entry.config = {key: value for key, value in entry.config.items() if key != 'font_id'}
            db.commit()
    assert claim(case).json()['leases'] == []
    alternative = next(font for font, languages in FONT_LANGUAGES.items() if 'zh-Hans' in languages and font != default)
    wrong = {**unsupported, 'supported_font_ids': [alternative]}
    assert client.post(IMAGE_PREFIX + '/nodes/register', headers=node['auth'], json=wrong).status_code == 200
    assert claim(case).json()['leases'] == []
    supported = {**unsupported, 'supported_font_ids': [default]}
    assert client.post(IMAGE_PREFIX + '/nodes/register', headers=node['auth'], json=supported).status_code == 200
    lease = claim(case).json()['leases'][0]
    assert lease['job_id'] == job_id and lease['config']['font_id'] == default
    from test_document_compute import request
    resumed = request(case, f'/nodes/{node["node"]["node_id"]}/sync', {'workspace_ids': [job_id]})
    assert resumed.status_code == 200 and resumed.json()['leases'][0]['config']['font_id'] == default
    response = client.post(IMAGE_PREFIX + '/nodes/register', headers=node['auth'], json=wrong)
    assert response.status_code == 409 and response.json()['error']['code'] == 'NODE_FONT_CAPABILITY_CONFLICT'


@pytest.mark.parametrize('legacy', [False, True])
def test_document_owned_workspace_cannot_downgrade_between_gpu_leases(documents, legacy):
    case, node = documents, documents.v3
    job_id = create(case)
    if legacy:
        with session_factory()() as db:
            entry = db.get(Job, job_id)
            entry.config = {key: value for key, value in entry.config.items() if key != 'font_id'}
            db.commit()
    unsupported = {**node['registration'], 'document_protocol': 2, 'supported_font_ids': []}
    response = node['client'].post(IMAGE_PREFIX + '/nodes/register', headers=node['auth'], json=unsupported)
    assert response.status_code == 409 and response.json()['error']['code'] == 'NODE_FONT_CAPABILITY_CONFLICT'
    with session_factory()() as db:
        entry = db.get(Job, job_id)
        entry.status, entry.completed_at = 'failed', now()
        db.commit()
    assert node['client'].post(IMAGE_PREFIX + '/nodes/register', headers=node['auth'], json=unsupported).status_code == 200
