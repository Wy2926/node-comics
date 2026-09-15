"""Controlled branch interleavings: no timing-based speed assertions or real providers."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from io import BytesIO
import base64
import json

import pytest
from PIL import Image
from sqlalchemy import func, select

from conftest import claim_job, run_job
from test_classic import configured, submit, status, encoded, SEGMENTS
from app import classic
from app.adapters.text import TextError, TextResponse
from app.assets import create_asset
from app.config import settings
from app.db import session_factory
from app.models import Asset, ClassicState, Job, Ledger, TextCall, uid


def test_branches_overlap_and_render_waits_for_both_checkpoints(configured, monkeypatch):
    text_started, erase_started = Event(), Event()
    text_done, erase_done = Event(), Event()
    original_text, original_engine = classic.call_text, classic.engine_request
    job = submit(configured)

    def text(*args):
        text_started.set()
        assert erase_started.wait(5), 'Inpainting must start before translation finishes'
        result = original_text(*args)
        text_done.set()
        return result

    def engine(stage, *args, **kwargs):
        if stage == 'inpaint':
            erase_started.set()
            assert text_started.wait(5), 'Translation must start before inpainting finishes'
            erase_done.set()
        if stage == 'render':
            assert text_done.is_set() and erase_done.is_set()
            with session_factory()() as db:
                state = db.get(ClassicState, job)
                assert state.translations and state.artifacts['cleaned']
                assert db.get(Asset, state.artifacts['cleaned']).storage_backend == 'local'
        return original_engine(stage, *args, **kwargs)

    monkeypatch.setattr(classic, 'call_text', text)
    monkeypatch.setattr(classic, 'engine_request', engine)
    run_job(job)
    assert status(configured, job)['status'] == 'succeeded'
    with session_factory()() as db:
        assert db.get(ClassicState, job).timings == {'inpaint': 0.2, 'render': 0.1}
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.job_id == job, Ledger.kind == 'settle')) == 1


def test_local_failure_stops_new_groups_and_recovery_reuses_successful_text(configured, monkeypatch):
    monkeypatch.setenv('TEXT_GROUP_BYTES', '128')
    settings.cache_clear()
    segments = [{'id': f'b{n:03}', 'source': 'a' * 70} for n in (1, 2)]
    original_engine = classic.engine_request
    text_started, erase_failed = Event(), Event()
    calls, erase_calls = [], []

    def engine(stage, *args, **kwargs):
        if stage == 'inpaint':
            erase_calls.append(stage)
            if len(erase_calls) == 1:
                assert text_started.wait(5)
                erase_failed.set()
                raise classic.ProcessingError('CLASSIC_INPAINT_FAILED', 'controlled failure')
        result = original_engine(stage, *args, **kwargs)
        if stage == 'analyze':
            result.update(segments=segments, regions=[{}, {}])
        return result

    def text(group, *args):
        calls.append(group[0]['id'])
        text_started.set()
        assert erase_failed.wait(5)
        return TextResponse(json.dumps({'translations': [{'id': group[0]['id'], 'text': '你好'}]}),
                            {'input_tokens': 80, 'output_tokens': 20}, 'isolated-text')

    monkeypatch.setattr(classic, 'engine_request', engine)
    monkeypatch.setattr(classic, 'call_text', text)
    job = submit(configured)
    run_job(job)
    assert status(configured, job)['status'] == 'queued'
    assert calls == ['b001'] and configured[3]['render'] == 0
    run_job(job)
    assert status(configured, job)['status'] == 'succeeded'
    assert calls == ['b001', 'b002'] and len(erase_calls) == 2
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall).where(TextCall.job_id == job)) == 2


def test_text_failure_joins_local_work_and_never_renders(configured, monkeypatch):
    erase_started, text_failed, release_erase = Event(), Event(), Event()
    original_engine = classic.engine_request

    def engine(stage, *args, **kwargs):
        if stage == 'inpaint':
            erase_started.set()
            assert release_erase.wait(5)
        return original_engine(stage, *args, **kwargs)

    def text(*args):
        assert erase_started.wait(5)
        text_failed.set()
        raise TextError('TEXT_AUTH_FAILED', 'controlled rejection')

    monkeypatch.setattr(classic, 'engine_request', engine)
    monkeypatch.setattr(classic, 'call_text', text)
    job = submit(configured)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(run_job, job)
        try:
            assert text_failed.wait(5)
            assert not future.done()
            assert status(configured, job)['status'] == 'running'
        finally:
            release_erase.set()
        future.result(timeout=10)
    result = status(configured, job)
    assert result['status'] == 'failed' and result['settlement'] == 'released'
    assert result['error']['code'] == 'TEXT_AUTH_FAILED' and configured[3]['render'] == 0


@pytest.mark.parametrize('action', ['cancel', 'delete'])
def test_cancel_or_delete_during_both_branches_discards_late_images_and_accounts_text(configured, monkeypatch, action):
    text_started, erase_started, release = Event(), Event(), Event()
    original_text, original_engine = classic.call_text, classic.engine_request

    def text(*args):
        text_started.set()
        assert release.wait(5)
        return original_text(*args)

    def engine(stage, *args, **kwargs):
        if stage == 'inpaint':
            erase_started.set()
            assert release.wait(5)
        return original_engine(stage, *args, **kwargs)

    monkeypatch.setattr(classic, 'call_text', text)
    monkeypatch.setattr(classic, 'engine_request', engine)
    client, auth, asset_id, calls = configured
    job = submit(configured)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(run_job, job)
        try:
            assert text_started.wait(5) and erase_started.wait(5)
            response = (client.post(f'/v1/jobs/{job}/cancel', headers=auth) if action == 'cancel'
                        else client.delete(f'/v1/images/{asset_id}', headers=auth))
            assert response.is_success
        finally:
            release.set()
        future.result(timeout=10)
    assert calls['render'] == 0
    with session_factory()() as db:
        assert db.get(Job, job).output_asset_id is None
        assert db.get(Job, job).settlement == 'released'
        assert db.scalar(select(TextCall).where(TextCall.job_id == job)).usage == {'input_tokens': 100, 'output_tokens': 20}
        assert db.scalar(select(func.count()).select_from(Asset).where(Asset.parent_id == asset_id, Asset.kind == 'classic_stage')) == 0


def test_old_inpaint_reply_cannot_replace_new_attempt_checkpoint(configured, monkeypatch):
    original_engine = classic.engine_request
    started, release = Event(), Event()
    job = submit(configured)
    attempt = claim_job(job)
    with session_factory()() as db:
        source = db.get(Asset, configured[2])
        raw = classic.read_asset(source)
        config = db.get(Job, job).config
        analysis = original_engine('analyze', raw, config)
        db.add(ClassicState(job_id=job, analysis=analysis))
        db.commit()

    def delayed(stage, *args, **kwargs):
        assert stage == 'inpaint'
        started.set()
        assert release.wait(5)
        return original_engine(stage, *args, **kwargs)

    monkeypatch.setattr(classic, 'engine_request', delayed)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(classic.inpaint_checkpoint, job, attempt, raw, analysis, config)
        try:
            assert started.wait(5)
            with session_factory()() as db:
                record = db.get(Job, job)
                record.attempt_id = uid()
                newer = create_asset(db, record.owner_id, raw, kind='classic_stage', parent_id=record.input_asset_id)
                db.get(ClassicState, job).artifacts = {'cleaned': newer.id}
                db.commit()
                newer_id = newer.id
        finally:
            release.set()
        with pytest.raises(classic.ProcessingError, match='CLASSIC_SUPERSEDED'):
            future.result(timeout=10)
    with session_factory()() as db:
        assert db.get(ClassicState, job).artifacts == {'cleaned': newer_id}


def test_invalid_cleaned_background_never_reaches_render(configured, monkeypatch):
    original = classic.engine_request

    def corrupt(stage, *args, **kwargs):
        result = original(stage, *args, **kwargs)
        if stage == 'inpaint':
            image = Image.open(BytesIO(base64.b64decode(result['cleaned']))).convert('RGB')
            image.putpixel((0, 0), (255, 0, 0))
            result['cleaned'] = encoded(image)
        return result

    monkeypatch.setattr(classic, 'engine_request', corrupt)
    job = submit(configured)
    run_job(job)
    result = status(configured, job)
    assert result['status'] == 'failed' and result['error']['code'] == 'CLASSIC_INPAINT_INVALID'
    assert configured[3]['render'] == 0
