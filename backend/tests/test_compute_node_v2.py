"""Run the actual node client against the controller, with isolated image/text fixtures."""
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
from test_compute_v2 import analysis_for, encoded, v2  # noqa: F401


class FixtureRuntime:
    version = 'test-v2'
    languages = ['en']

    def __init__(self):
        self.analyzed = 0
        self.rendered = 0

    def decode(self, data, metadata):
        return data, metadata

    def analyze(self, source, input_hash):
        self.analyzed += 1
        return analysis_for({'input': source[1]})

    def inpaint(self, source, analysis):
        return source

    def render(self, source, analysis, translated, language):
        self.rendered += 1
        image = Image.open(BytesIO(source[0])).convert('RGB')
        image.putpixel((10, 10), (1, 2, 3))
        return {'version': self.version, 'input_hash': analysis['input_hash'],
            'image': encoded(image), 'mask': analysis['mask'], 'glyph_mask': analysis['mask'],
            'analysis_hash': translated['analysis_hash'], 'translations_revision': translated['revision']}


def node_for(v2, tmp_path, pages, runtime, lose_replies=False):
    config = {'node_id': v2['node']['node_id'], 'node_token': v2['node']['token'],
        'resource_id': 'test:vulkan:0', 'control_url': 'https://control.example.test',
        'r2_origin': 'https://r2.example.test', 'engine': {'gpu': -1}, 'local_pages': pages, 'max_leases': 4}
    lost = set()
    def control(request):
        response = v2['client'].request('POST', request.url.path, headers=dict(request.headers), content=request.content)
        endpoint = request.url.path.rsplit('/', 1)[-1]
        if lose_replies and endpoint in {'claim', 'analysis', 'complete'} and endpoint not in lost:
            lost.add(endpoint)
            raise httpx.ReadError('lost after server committed')
        return httpx.Response(response.status_code, content=response.content, headers=dict(response.headers))
    def storage(request):
        assert 'authorization' not in request.headers and 'x-node-id' not in request.headers
        with session_factory()() as db:
            asset = db.scalar(select(Asset).where(Asset.storage_key == request.url.path.lstrip('/')))
            return httpx.Response(200, content=get_store(asset.storage_backend).read(asset.storage_key))
    transport = Transport(config, control_transport=httpx.MockTransport(control), storage_transport=httpx.MockTransport(storage))
    journal = Journal(tmp_path, 512 * 1024 * 1024)
    return Agent(config, runtime, transport, journal), transport, journal


def drive(agent, jobs, timeout=15):
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        agent.heartbeat()
        with session_factory()() as db:
            lease = claim_stage(db, 'control-text', ['text'])
            db.commit()
        if lease:
            run_control_stage(lease.id)
        agent.reap()
        with session_factory()() as db:
            states = [db.get(Job, key).status for key in jobs]
        if all(state == 'succeeded' for state in states) and not agent.pages:
            return
        time.sleep(.03)
    pytest.fail('node/controller did not complete: ' + str(states))


def test_text_wait_does_not_hold_compute_and_buffers_are_released(v2, tmp_path):
    jobs = v2['create'](4)
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v2, tmp_path, 1, runtime)
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
            assert timings['delivery']['source_get'] >= 0
    finally:
        agent.close()
        transport.close()
        journal.close()


def test_one_blocked_delivery_does_not_block_other_pages(v2, tmp_path):
    from threading import Event
    jobs = v2['create'](4)
    agent, transport, journal = node_for(v2, tmp_path, 1, FixtureRuntime())
    entered, release = Event(), Event()
    post = transport.post
    blocked = None
    def slow(path, body):
        nonlocal blocked
        if path.endswith('/complete') and 'result' in body and (blocked is None or path == blocked):
            blocked = path
            entered.set()
            assert release.wait(10)
        return post(path, body)
    transport.post = slow
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
def test_four_page_leases_work_with_serial_or_parallel_local_execution_and_lost_replies(v2, tmp_path, pages):
    jobs = v2['create'](4)
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v2, tmp_path, pages, runtime, lose_replies=True)
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


def test_restart_resubmits_frozen_result_without_recomputing(v2, tmp_path):
    from test_compute_v2 import analyze, claim, result_for, text
    from conftest import png_variant
    jobs = v2['create']()
    lease = claim(v2).json()['leases'][0]
    analyze(v2, lease)
    text(lease)
    with session_factory()() as db:
        asset = db.get(Asset, db.get(Job, jobs[0]).input_asset_id)
        data = get_store(asset.storage_backend).read(asset.storage_key)
    result = result_for(v2, lease, data)
    journal = Journal(tmp_path, 512 * 1024 * 1024)
    journal.put('lease:' + lease['lease_id'], {'completion': {'lease_token': lease['lease_token'], 'result': result}})
    journal.close()
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v2, tmp_path, 1, runtime)
    try:
        agent.register()
        drive(agent, jobs)
        assert runtime.analyzed == runtime.rendered == 0
    finally:
        agent.close()
        transport.close()
        journal.close()


@pytest.mark.skipif(not os.environ.get('CLASSIC_TEST_MODELS'), reason='Explicit real-model Vulkan acceptance')
@pytest.mark.parametrize('ocr_language,source_text,font_name', [
    ('en', 'WHERE ARE YOU GOING?', 'arial.ttf'),
    ('ja', '明日はきっと晴れる。', 'YuGothR.ttc'),
])
def test_real_vulkan_node_delivers_validated_page(v2, tmp_path, ocr_language, source_text, font_name):
    from classic_node.runtime import Runtime
    from app.config import settings
    from conftest import login, submit_asset, upload
    runtime = Runtime({'languages': ['en'], 'engine': {
        'models': os.environ['CLASSIC_TEST_MODELS'], 'gpu': 0, 'ocr_workers': 8, 'threads': 2,
        'tile': 768, 'detect_size': 1280, 'ocr_language': ocr_language, 'direction': 'auto',
        'font': [], 'png_compression': 1}})
    runtime.warmup()
    settings().classic_engine_version = runtime.version
    image = Image.new('RGB', (720, 600), '#777777')
    draw = ImageDraw.Draw(image)
    draw.ellipse((35, 65, 685, 535), fill='white', outline='black', width=4)
    font = ImageFont.truetype('C:/Windows/Fonts/' + font_name, 32)
    draw.text((360, 300), source_text, font=font, fill='black', anchor='mm')
    buffer = BytesIO()
    image.save(buffer, 'PNG')
    auth = login(v2['client'], 'real-model-reader')
    original = upload(v2['client'], auth, buffer.getvalue())
    response = submit_asset(v2['client'], auth, original, key='real-model', language='en', mode='classic')
    assert response.status_code == 202, response.text
    job_id = response.json()['items'][0]['job']['id']
    agent, transport, journal = node_for(v2, tmp_path, 1, runtime)
    agent.local['engine']['gpu'] = 0
    started = time.monotonic()
    try:
        agent.register()
        agent.claim()
        drive(agent, [job_id], timeout=60)
        with session_factory()() as db:
            job = db.get(Job, job_id)
            asset = db.get(Asset, job.output_asset_id)
            output = get_store(asset.storage_backend).read(asset.storage_key)
            from app.models import ClassicState
            analysis = db.get(ClassicState, job_id).analysis
        assert len(analysis['segments']) == 1
        assert analysis['segments'][0]['source'] == source_text
        assert Image.open(BytesIO(output)).size == image.size
        destination = SERVICE / 'artifacts/v2-smoke'
        destination.mkdir(parents=True, exist_ok=True)
        (destination / f'{ocr_language}-source.png').write_bytes(buffer.getvalue())
        (destination / f'{ocr_language}-result.png').write_bytes(output)
        (destination / f'{ocr_language}-report.json').write_text(json.dumps({
            'engine_version': runtime.version, 'protocol_version': 2, 'ocr_language': ocr_language,
            'ocr_exact': True, 'regions': len(analysis['segments']), 'width': image.width, 'height': image.height,
            'controller_validated_pixels': True, 'wall_seconds': time.monotonic() - started,
            'text_provider': 'fixed fixture, no paid calls', 'storage': 'isolated adapter'}, indent=2), encoding='utf-8')
    finally:
        for page in agent.pages.values():
            page.stopped = True
        agent.close()
        transport.close()
        journal.close()
        runtime.close()


def test_notice_delivers_text_without_waiting_for_periodic_heartbeat(v2, tmp_path):
    jobs = v2['create']()
    agent, transport, journal = node_for(v2, tmp_path, 1, FixtureRuntime())
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


def test_resident_budget_applies_backpressure_and_all_pages_eventually_finish(v2, tmp_path):
    jobs = v2['create'](4)
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v2, tmp_path, 1, runtime)
    try:
        agent.register()
        agent.claim()
        first = next(iter(agent.pages.values())).lease['input']
        from classic_node.protocol import MAX_IMAGE_BYTES, MAX_CHECKPOINT_BYTES
        agent.pipeline.limit = first['width'] * first['height'] * 16 + MAX_IMAGE_BYTES * 3 + MAX_CHECKPOINT_BYTES * 6
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


def test_restart_acknowledges_stopped_lease_without_input_or_config(v2, tmp_path):
    from test_compute_v2 import claim
    from conftest import login
    jobs = v2['create']()
    lease = claim(v2).json()['leases'][0]
    auth = login(v2['client'], 'reader0')
    v2['client'].post('/v1/jobs/' + jobs[0] + '/cancel', headers=auth).raise_for_status()
    runtime = FixtureRuntime()
    agent, transport, journal = node_for(v2, tmp_path, 1, runtime)
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
