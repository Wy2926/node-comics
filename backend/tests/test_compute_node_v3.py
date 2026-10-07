from conftest import create
"""Run the actual node client against the controller, with isolated image/text fixtures."""
import hashlib
from io import BytesIO
from pathlib import Path
import os
import json
import sys
import time
from types import SimpleNamespace

import httpx
import pytest
from PIL import Image, ImageDraw, ImageFont
from sqlalchemy import select

SERVICE = Path(__file__).resolve().parents[2] / 'services/classic-engine'
sys.path.insert(0, str(SERVICE))
from classic_node.agent import Agent
from classic_node.journal import Journal
from classic_node.protocol import ControlFailure
from classic_node.transport import Transport
from app.db import session_factory
from app.models import Asset, Job
from app.queue_models import JobStage
from app.scheduler import claim_stage
from app.storage import get_store
from app.workers import run_control_stage
from test_compute_v3 import analysis_for, v3  # noqa: F401


class FixtureRuntime:
    version = 'test-v3'
    languages = ['en']

    def validate_analysis(self, analysis):
        assert 'regions' in analysis  # Controller fixtures use their own image format.

    def __init__(self):
        self.analyzed = 0
        self.rendered = 0

    def decode(self, data, metadata):
        return (data, metadata), None

    def analyze(self, source, input_hash):
        self.analyzed += 1
        return analysis_for({'input': source[1]})

    def inpaint(self, source, analysis):
        return source

    def render(self, original, source, analysis, translated, language, alpha, *, mask_cache_bytes=None):
        self.rendered += 1
        image = Image.open(BytesIO(source[0])).convert('RGB')
        stream = BytesIO()
        Image.new('RGBA', (1, 1), (1, 2, 3, 255)).save(stream, 'WEBP', lossless=True)
        data = stream.getvalue()
        return {'output_bytes': data, 'result': {
            'version': self.version, 'input_hash': analysis['input_hash'],
            'analysis_hash': translated['analysis_hash'], 'translations_revision': translated['revision'],
            'representation': 'overlay-v1', 'normalization_version': 1, 'width': image.width, 'height': image.height,
            'bbox': {'x': 10, 'y': 10, 'width': 1, 'height': 1},
            'output': {'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data),
                       'width': 1, 'height': 1, 'mime': 'image/webp'}}}



def node_for(v3, tmp_path, pages, runtime, lose_replies=False, lose_upload=False, max_leases=4):
    config = {'node_id': v3['node']['node_id'], 'node_token': v3['node']['token'],
        'resource_id': 'test:cuda:0', 'control_url': 'https://control.example.test',
        'engine': {'gpu': 0}, 'local_pages': pages, 'max_leases': max_leases}
    lost = set()
    def control(request):
        response = v3['client'].request(request.method, request.url.path, headers=dict(request.headers), content=request.content)
        endpoint = request.url.path.rsplit('/', 1)[-1]
        if ((lose_replies and endpoint in {'claim', 'analysis', 'result'}) or (lose_upload and endpoint == 'result')) and endpoint not in lost:
            lost.add(endpoint)
            raise httpx.ReadError('lost after server committed')
        return httpx.Response(response.status_code, content=response.content, headers=dict(response.headers))
    transport = Transport(config, control_transport=httpx.MockTransport(control))
    journal = Journal(tmp_path)
    return Agent(config, runtime, transport, journal), transport, journal


def drive(agent, jobs, timeout=15, *, schedule=False, expected='succeeded'):
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        if schedule:
            agent.poll_control()
        else:
            agent.heartbeat()
        with session_factory()() as db:
            lease = claim_stage(db, 'control-text', ['text'])
            db.commit()
        if lease:
            run_control_stage(lease.id)
        agent.reap()
        with session_factory()() as db:
            states = [db.get(Job, key).status for key in jobs]
        if all(state == expected for state in states) and not agent.pages:
            return
        time.sleep(.03)
    pytest.fail('node/controller did not complete: ' + str(states))


def test_definitive_output_rejection_reports_failure_once_and_drains_buffers(v3, tmp_path):
    jobs = v3['create']()
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v3, tmp_path, 1, runtime)
    rejected = []
    def reject(*args):
        rejected.append(True)
        raise ControlFailure('INVALID_PROVIDER_OUTPUT', 422)
    transport.deliver = reject
    try:
        agent.register()
        agent.claim()
        drive(agent, jobs, expected='failed')
        assert len(rejected) == 1
        assert runtime.analyzed == runtime.rendered == 1
        assert not journal.leases() and agent.pipeline.used == 0
        with session_factory()() as db:
            assert db.get(Job, jobs[0]).error_code == 'RESULT_REJECTED'
    finally:
        agent.close()
        transport.close()
        journal.close()


def test_text_wait_does_not_hold_compute_and_buffers_are_released(v3, tmp_path):
    jobs = v3['create'](4)
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v3, tmp_path, 1, runtime)
    try:
        agent.register()
        agent.claim()
        end = time.monotonic() + 4
        # Deliberately never run text: all four pages must still finish preparation.
        while time.monotonic() < end:
            agent.reap()
            if all(p.step == 'text' and p.analysis_accepted for p in agent.pages.values()):
                break
            time.sleep(.01)
        assert runtime.analyzed == 4
        assert all(p.cleaned is not None and not p.future for p in agent.pages.values())
        assert 0 < agent.pipeline.used <= agent.pipeline.limit
        drive(agent, jobs)
        assert agent.pipeline.used == 0
        from app.models import ClassicState
        with session_factory()() as db:
            timings = db.get(ClassicState, jobs[0]).timings
            assert timings['node']['analyze'] >= 0
            assert timings['node']['render'] >= 0
            assert timings['delivery']['protocol'] == 3
    finally:
        agent.close()
        transport.close()
        journal.close()


def test_one_blocked_delivery_does_not_block_other_pages(v3, tmp_path):
    from threading import Event
    jobs = v3['create'](4)
    agent, transport, journal = node_for(v3, tmp_path, 1, FixtureRuntime())
    entered, release = Event(), Event()
    deliver = transport.deliver
    blocked = None
    def slow(key, body, data, check):
        nonlocal blocked
        if blocked is None or key == blocked:
            blocked = key
            entered.set()
            assert release.wait(10)
        return deliver(key, body, data, check)
    transport.deliver = slow
    try:
        agent.register()
        agent.claim()
        end = time.monotonic() + 6
        while time.monotonic() < end:
            agent.reap()
            agent.heartbeat()
            with session_factory()() as db:
                lease = claim_stage(db, 'control-text', ['text'])
                db.commit()
            if lease:
                run_control_stage(lease.id)
            with session_factory()() as db:
                done = sum(db.get(Job, job).status == 'succeeded' for job in jobs)
            if done == 3:
                break
            time.sleep(.02)
        assert entered.is_set() and done == 3
        release.set()
        drive(agent, jobs)
    finally:
        release.set()
        agent.close()
        transport.close()
        journal.close()


@pytest.mark.parametrize('pages', [1, 2])
def test_four_page_leases_work_with_serial_or_parallel_local_execution_and_lost_replies(v3, tmp_path, pages):
    jobs = v3['create'](4)
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v3, tmp_path, pages, runtime, lose_replies=True)
    try:
        agent.register()
        with pytest.raises(ControlFailure):
            agent.claim()
        pending = journal.get('claim')
        assert pending and pending['count'] == 4
        agent.claim()
        assert len(agent.pages) == 4 and journal.get('claim') is None
        drive(agent, jobs)
        assert runtime.analyzed == runtime.rendered == 4
        assert journal.leases() == {}
    finally:
        for page in agent.pages.values():
            page.stopped = True
        agent.close()
        transport.close()
        journal.close()


def test_restart_resubmits_frozen_result_without_recomputing(v3, tmp_path):
    from test_compute_v3 import analyze, claim, result_for, text
    from conftest import png_variant
    jobs = v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    text(lease)
    with session_factory()() as db:
        asset = db.get(Asset, db.get(Job, jobs[0]).input_asset_id)
        data = get_store().read(asset.storage_key)
    result, data = result_for(v3, lease, data)
    journal = Journal(tmp_path)
    journal.freeze('lease:' + lease['lease_id'], {'completion': {'lease_token': lease['lease_token'], 'result': result, 'timings': {}}}, data)
    journal.close()
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v3, tmp_path, 1, runtime)
    try:
        agent.register()
        drive(agent, jobs)
        assert runtime.analyzed == runtime.rendered == 0
    finally:
        agent.close()
        transport.close()
        journal.close()


def test_different_build_resumes_paid_checkpoint_on_another_node(v3, tmp_path):
    from datetime import timedelta
    from sqlalchemy import func, select
    from app.dispatcher import recover_lease
    from app.models import TextCall, now
    from app.queue_models import ExecutionLease, JobStage
    from test_compute_v3 import analyze, claim, text
    from test_node_management import provision

    jobs = v3['create']()
    first = claim(v3).json()['leases'][0]
    analyze(v3, first)
    text(first)
    with session_factory()() as db:
        db.get(ExecutionLease, first['lease_id']).expires_at = now() - timedelta(seconds=1)
        db.commit()
    recover_lease(first['lease_id'])
    with session_factory()() as db:
        stage = db.scalar(select(JobStage).where(JobStage.job_id == jobs[0], JobStage.name == 'page'))
        stage.available_at = now()
        db.commit()
    node, auth, _ = provision(v3['client'], 'replacement:gpu:0')
    runtime = FixtureRuntime()
    runtime.version = 'another-os-and-dependency-build'
    replacement = {**v3, 'node': node, 'auth': auth}
    agent, transport, journal = node_for(replacement, tmp_path, 1, runtime)
    agent.local['resource_id'] = 'replacement:gpu:0'
    try:
        agent.register()
        agent.claim()
        drive(agent, jobs)
        assert runtime.analyzed == 0 and runtime.rendered == 1
        with session_factory()() as db:
            assert db.scalar(select(func.count()).select_from(TextCall)) == 1
            assert db.get(Job, jobs[0]).status == 'succeeded'
            leases = db.scalars(select(ExecutionLease).where(ExecutionLease.job_id == jobs[0],
                ExecutionLease.resource_pool == 'image').order_by(ExecutionLease.generation)).all()
            assert len(leases) == 2 and leases[1].node_id == node['node_id']
            assert leases[1].generation > leases[0].generation
    finally:
        agent.close()
        transport.close()
        journal.close()


@pytest.mark.skipif(not os.environ.get('CLASSIC_TEST_MODELS'), reason='Explicit real-model CUDA acceptance')
@pytest.mark.parametrize('ocr_language,source_text,font_name,target_language', [
    ('en', 'WHERE ARE YOU GOING?', 'arial.ttf', 'en'),
    ('ja', '明日はきっと晴れる。', 'YuGothR.ttc', 'en'),
    pytest.param('zh-ar', None, None, 'ar', marks=pytest.mark.skipif(
        not os.environ.get('CLASSIC_TEST_INPUT'), reason='Explicit private Chinese sample, kept outside Git')),
])
def test_real_cuda_node_uploads_overlay(v3, tmp_path, monkeypatch, ocr_language, source_text, font_name, target_language):
    from classic_node.runtime import Runtime
    from app.config import settings
    from conftest import login, submit_asset, upload
    models = Path(os.environ['CLASSIC_TEST_MODELS'])
    fonts = json.loads((models.parent / 'licenses/font-sources.json').read_text())['fonts']
    runtime = Runtime({'engine': {
            'models': str(models), 'gpu': int(os.environ.get('CLASSIC_TEST_GPU', '0')), 'threads': 2,
            'keep_lang': 'zh' if source_text is None else None,
        'font': [str(models.parent / 'fonts' / item['name']) for item in fonts]}})
    runtime.warmup()
    if source_text is None:
        with Image.open(os.environ['CLASSIC_TEST_INPUT']) as source:
            image = source.convert('RGB')
        from app import classic
        from app.adapters.llm import TextResponse
        arabic = 'العربية لا لأ لإ لآ مُحَمَّد ٢٠٠،؟…: AMIRA (200)'
        def arabic_fixture(segments, language, profile):
            assert language == 'ar'
            return TextResponse(json.dumps({'translations': {s['id']: arabic for s in segments}}),
                                {'input_tokens': 10, 'output_tokens': 10}, 'fixture')
        monkeypatch.setattr(classic, 'call_text', arabic_fixture)
    else:
        image = Image.new('RGB', (720, 600), '#777777')
        draw = ImageDraw.Draw(image)
        draw.ellipse((35, 65, 685, 535), fill='white', outline='black', width=4)
        font = ImageFont.truetype('C:/Windows/Fonts/' + font_name, 32)
        draw.text((360, 300), source_text, font=font, fill='black', anchor='mm')
    buffer = BytesIO()
    image.save(buffer, 'PNG')
    auth = login(v3['client'], 'real-model-reader')
    original = upload(v3['client'], auth, buffer.getvalue())
    response = create(v3['client'], auth, original, key='real-model', language=target_language, mode='classic')
    assert response.status_code == 202, response.text
    job_id = response.json()['id']
    agent, transport, journal = node_for(v3, tmp_path, 1, runtime)
    agent.local['engine']['gpu'] = int(os.environ.get('CLASSIC_TEST_GPU', '0'))
    started = time.monotonic()
    try:
        agent.register()
        agent.claim()
        drive(agent, [job_id], timeout=60)
        with session_factory()() as db:
            job = db.get(Job, job_id)
            asset = db.get(Asset, job.output_asset_id)
            output = get_store().read(asset.storage_key)
            from app.models import ClassicState
            state = db.get(ClassicState, job_id)
            analysis = state.analysis
            if source_text is None:
                assert analysis['segments'] and set(state.translations.values()) == {arabic}
                assert job.target_language == 'ar'
        if source_text is not None:
            assert len(analysis['segments']) == 1
            assert analysis['segments'][0]['source'] == source_text
        # Check actual removal, not merely a successfully encoded final image.
        import numpy as np
        cleaned = runtime.inpaint(np.array(image), analysis)
        dark_before = dark_after = None
        if source_text is not None:
            bounds = draw.textbbox((360, 300), source_text, font=font, anchor='mm')
            x0, y0, x1, y1 = bounds
            dark_before = int(np.count_nonzero(np.array(image)[y0:y1, x0:x1].mean(axis=2) < 180))
            dark_after = int(np.count_nonzero(cleaned[y0:y1, x0:x1].mean(axis=2) < 180))
            assert dark_before > 100 and dark_after < dark_before * .05
        else:
            assert np.any(cleaned != np.array(image))
        description = job.result_description
        assert description['representation'] == 'overlay-v1'
        box = description['bbox']
        patch = Image.open(BytesIO(output)).convert('RGBA')
        assert patch.size == (box['width'], box['height'])
        assert set(patch.getchannel('A').getdata()) <= {0, 255}
        composite = image.copy()
        composite.paste(patch, (box['x'], box['y']), patch.getchannel('A'))
        destination = SERVICE / 'artifacts/v3-smoke'
        destination.mkdir(parents=True, exist_ok=True)
        (destination / f'{ocr_language}-source.png').write_bytes(buffer.getvalue())
        (destination / f'{ocr_language}-overlay.webp').write_bytes(output)
        composite.save(destination / f'{ocr_language}-result.png')
        Image.fromarray(cleaned).save(destination / f'{ocr_language}-cleaned.png')
        (destination / f'{ocr_language}-report.json').write_text(json.dumps({
            'engine_version': runtime.version, 'protocol_version': 3, 'ocr_language': ocr_language,
            'ocr_exact': True if source_text is not None else None, 'target_language': target_language,
            'regions': len(analysis['segments']), 'width': image.width, 'height': image.height,
            'inpainting_backend': runtime.engine.inpainter.backend,
            'dark_text_pixels_before': dark_before, 'dark_text_pixels_after': dark_after,
            'node_uploaded_result': True, 'representation': description['representation'], 'overlay_bytes': len(output), 'source_bytes': len(buffer.getvalue()), 'wall_seconds': time.monotonic() - started,
            'text_provider': 'fixed fixture, no paid calls', 'storage': 'isolated adapter'}, indent=2), encoding='utf-8')
    finally:
        for page in agent.pages.values():
            page.stopped = True
        agent.close()
        transport.close()
        journal.close()
        runtime.close()


def test_notice_delivers_text_without_waiting_for_periodic_heartbeat(v3, tmp_path):
    jobs = v3['create']()
    agent, transport, journal = node_for(v3, tmp_path, 1, FixtureRuntime())
    try:
        agent.register()
        # Keep the renewal period at 10s; short long-poll only bounds test shutdown.
        agent.config['request_seconds'] = 3
        agent.claim()
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            agent.poll_control()
            agent.reap()
            if all(p.step == 'text' and p.analysis_accepted for p in agent.pages.values()):
                break
            time.sleep(.01)
        assert all(p.step == 'text' for p in agent.pages.values())
        with session_factory()() as db:
            lease = claim_stage(db, 'control-text', ['text'])
            db.commit()
        started = time.monotonic()
        run_control_stage(lease.id)
        while agent.pages and time.monotonic() - started < 2:
            agent.poll_control()
            agent.reap()
            time.sleep(.01)
        assert not agent.pages
        assert time.monotonic() - started < 2
        assert agent.config['heartbeat_seconds'] == 10
    finally:
        agent.close()
        transport.close()
        journal.close()


def test_resident_budget_applies_backpressure_and_all_pages_eventually_finish(v3, tmp_path):
    jobs = v3['create'](4)
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v3, tmp_path, 1, runtime)
    try:
        agent.register()
        agent.claim()
        agent.pipeline.limit = max(agent.pipeline.input_reservation(page) for page in agent.pages.values())
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            agent.reap()
            if any(p.step == 'text' and p.analysis_accepted for p in agent.pages.values()):
                break
            time.sleep(.01)
        assert runtime.analyzed == 1
        assert sum(p.reserved > 0 for p in agent.pages.values()) == 1
        assert agent.pipeline.used <= agent.pipeline.limit
        drive(agent, jobs)
        assert runtime.rendered == 4 and agent.pipeline.used == 0
    finally:
        agent.close()
        transport.close()
        journal.close()


def test_restart_acknowledges_stopped_lease_without_input_or_config(v3, tmp_path):
    from test_compute_v3 import claim
    from conftest import login, request_for_job
    jobs = v3['create']()
    lease = claim(v3).json()['leases'][0]
    auth = login(v3['client'], 'reader0')
    v3['client'].post('/v1/translations/' + request_for_job(v3['client'],auth,jobs[0]) + '/cancel', headers=auth).raise_for_status()
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v3, tmp_path, 1, runtime)
    try:
        agent.register()
        deadline = time.monotonic() + 2
        while agent.pages and time.monotonic() < deadline:
            agent.reap()
            time.sleep(.01)
        assert not agent.pages and runtime.analyzed == 0
        assert journal.leases() == {} and agent.pipeline.used == 0
    finally:
        agent.close()
        transport.close()
        journal.close()


def test_parallel_result_uploads_never_hold_the_single_compute_slot(v3, tmp_path):
    from threading import Event, Lock
    jobs = v3['create'](4)
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v3, tmp_path, 1, runtime)
    release, lock = Event(), Lock()
    active = peak = 0
    upload = transport.deliver
    def blocked(*args, **kwargs):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            assert release.wait(15)
            return upload(*args, **kwargs)
        finally:
            with lock:
                active -= 1
    transport.deliver = blocked
    try:
        agent.register()
        agent.claim()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            agent.reap()
            agent.heartbeat()
            with session_factory()() as db:
                lease = claim_stage(db, 'control-text', ['text'])
                db.commit()
            if lease:
                run_control_stage(lease.id)
            if runtime.rendered == 4 and peak == 4:
                break
            time.sleep(.02)
        assert runtime.rendered == 4 and peak == 4
        assert all(page.step == 'deliver' for page in agent.pages.values())
        assert all(page.cleaned is None for page in agent.pages.values())
        release.set()
        drive(agent, jobs)
    finally:
        release.set()
        agent.close()
        transport.close()
        journal.close()


def test_lost_result_reply_retries_frozen_output_and_settles_once(v3, tmp_path):
    jobs = v3['create']()
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v3, tmp_path, 1, runtime, lose_upload=True)
    try:
        agent.register()
        agent.claim()
        drive(agent, jobs)
        assert runtime.rendered == 1
        assert not journal.leases()
    finally:
        agent.close()
        transport.close()
        journal.close()


def test_eight_slots_four_blocked_uploads_then_next_admission_window(v3, tmp_path):
    from threading import Event, Lock
    from app.queue_models import ComputeNode
    jobs = v3['create'](16)
    with session_factory()() as db:
        node = db.get(ComputeNode, v3['node']['node_id'])
        node.capacity = 8
        node.desired_config = {**node.desired_config, 'execution_slots': 8, 'request_seconds': 3}
        db.commit()
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v3, tmp_path, 8, runtime, max_leases=8)
    release, lock = Event(), Lock()
    active = peak = 0
    batches = []
    post = transport.post
    def observed_post(path, body):
        reply = post(path, body)
        if path.endswith('/claim'):
            assert 1 <= body['count'] <= 4
            batches.append(len(reply['leases']))
        return reply
    transport.post = observed_post
    upload = transport.deliver
    def blocked(*args, **kwargs):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            assert release.wait(20)
            return upload(*args, **kwargs)
        finally:
            with lock:
                active -= 1
    transport.deliver = blocked
    try:
        agent.register()
        agent.claim()
        assert len(agent.pages) == 4
        end = time.monotonic() + 8
        while time.monotonic() < end:
            agent.poll_control()
            agent.reap()
            if len(agent.pages) == 8 and all(p.step == 'text' and p.cleaned is not None and p.analysis_accepted
                                            for p in agent.pages.values()):
                break
            time.sleep(.01)
        assert len(agent.pages) == 8 and sum(batches) == 8
        assert runtime.analyzed == 8 and runtime.rendered == 0
        assert all(p.cleaned is not None and not p.future for p in agent.pages.values())
        end = time.monotonic() + 8
        while time.monotonic() < end:
            agent.poll_control()
            agent.reap()
            with session_factory()() as db:
                lease = claim_stage(db, 'control-text', ['text'])
                db.commit()
            if lease:
                run_control_stage(lease.id)
            if runtime.rendered == 8 and active == 4 and all(
                    p.step == 'deliver' and p.cleaned is None for p in agent.pages.values()):
                break
            time.sleep(.01)
        assert runtime.rendered == 8 and active == peak == 4
        assert all(p.step == 'deliver' and p.cleaned is None for p in agent.pages.values())
        agent.claim()
        assert len(agent.pages) == 8  # Delivery still occupies a whole-page lease.
        assert sum(batches) == 8
        release.set()
        drive(agent, jobs, schedule=True)
        assert runtime.analyzed == runtime.rendered == 16
        assert sum(batches) == 16 and len([count for count in batches if count]) >= 4
        assert not journal.leases() and agent.pipeline.used == 0
    finally:
        release.set()
        agent.close()
        transport.close()
        journal.close()
