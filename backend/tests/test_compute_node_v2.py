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
        agent.pool.shutdown(wait=True)
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
        agent.pool.shutdown(wait=True)
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
        agent.pool.shutdown(wait=True)
        transport.close()
        journal.close()
        runtime.close()
