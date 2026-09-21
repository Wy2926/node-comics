"""Exercise the real node scheduler with eight leases and four upload workers.

The controller, LLM and storage are explicitly local simulations. --models
uses real detection/OCR/LaMa/rendering on a generated, non-private page.
"""
import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Lock
import time
from types import SimpleNamespace

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from classic_node.agent import Agent
from classic_node.journal import Journal
from classic_node.protocol import digest, pack_result, png64


def fixture_image():
    image = Image.new('RGB', (720, 600), 'white')
    draw = ImageDraw.Draw(image)
    from manhua_engine.layout import font_paths
    font = ImageFont.truetype(font_paths((), 'en')[0], 42)
    draw.text((160, 260), 'Hello world', font=font, fill='black')
    out = BytesIO()
    image.save(out, 'PNG')
    return out.getvalue()


class FixtureRuntime:
    version = 'pressure-fixture'
    languages = ['en']

    def decode(self, data, metadata):
        return np.array(Image.open(BytesIO(data)).convert('RGB')), None

    def analyze(self, rgb, input_hash):
        time.sleep(.005)
        mask = Image.new('L', (rgb.shape[1], rgb.shape[0]))
        ImageDraw.Draw(mask).rectangle((160, 260, 410, 310), fill=255)
        return {'version': self.version, 'input_hash': input_hash,
                'width': rgb.shape[1], 'height': rgb.shape[0],
                'segments': [{'id': '0', 'source': 'Hello world'}],
                'regions': [], 'mask': png64(mask)}

    def inpaint(self, rgb, analysis):
        time.sleep(.005)
        return rgb.copy()

    def render(self, cleaned, analysis, translated, language, alpha):
        image = Image.fromarray(cleaned)
        image.putpixel((10, 10), (1, 2, 3))
        return pack_result(image, self.version, analysis, translated)


class SimulatedTransport:
    """Event-gated dependencies, with claim receipts and bounded admission."""
    def __init__(self, runtime, scenario, total, data):
        self.runtime, self.scenario, self.total, self.data = runtime, scenario, total, data
        self.control = SimpleNamespace(timeout=3)
        self.config = {'version': 1, 'enabled': True, 'execution_slots': 8,
                       'request_seconds': 3, 'heartbeat_seconds': .1, 'poll_seconds': .02}
        self.released = Event()
        self.lock = Lock()
        self.leases, self.analyses, self.results, self.done, self.receipts = {}, {}, {}, {}, {}
        self.counts, self.active, self.peak = Counter(), Counter(), Counter()
        self.events = []
        self.started = time.monotonic()
        self.claimed = self.heartbeats = self.peak_leases = 0

    def clock(self):
        now = datetime.now(timezone.utc)
        return now.isoformat(), (now + timedelta(seconds=300)).isoformat()

    def gate(self, stage, key):
        held = (self.scenario == 'upload' and stage == 'upload' or
                self.scenario == 'mixed' and (stage, key) in {
                    ('download', '0'), ('analysis', '1'), ('upload', '3'), ('complete', '4')})
        with self.lock:
            self.counts[stage] += 1
            self.active[stage] += 1
            self.peak[stage] = max(self.peak[stage], self.active[stage])
            self.events.append((time.monotonic() - self.started, stage, key))
        try:
            if held and not self.released.wait(180):
                raise TimeoutError('Simulation gate was not released')
            time.sleep(.005)
        finally:
            with self.lock:
                self.active[stage] -= 1

    def post(self, path, body):
        server, expires = self.clock()
        if path.endswith('/register'):
            return {'protocol_version': 2, 'config': self.config, 'leases': [], 'server_time': server}
        if path.endswith('/updates'):
            time.sleep(.05)
            return {'revision': body['revision'] + 1}
        if path.endswith('/claim'):
            with self.lock:
                if body['request_id'] in self.receipts:
                    return self.receipts[body['request_id']]
                remaining = 8 - (len(self.leases) - len(self.done))
                assert body['count'] <= remaining
                leases = []
                for _ in range(min(body['count'], self.total - self.claimed)):
                    key = str(self.claimed)
                    self.claimed += 1
                    with Image.open(BytesIO(self.data)) as image:
                        width, height = image.size
                    lease = {'lease_id': key, 'lease_token': 'fixture-token-' + key,
                        'status': 'active', 'expires_at': expires, 'language': 'en',
                        'config': {'engine': {'version': self.runtime.version}},
                        'input': {'sha256': hashlib.sha256(self.data).hexdigest(), 'byte_size': len(self.data),
                                  'width': width, 'height': height, 'mime': 'image/png',
                                  'url': 'https://fixture.invalid/' + key,
                                  'server_time': server, 'url_expires_at': expires}}
                    self.leases[key] = lease
                    leases.append(lease)
                self.peak_leases = max(self.peak_leases, len(self.leases) - len(self.done))
                reply = {'request_id': body['request_id'], 'server_time': server, 'leases': leases}
                self.receipts[body['request_id']] = reply
                return reply
        if path.endswith('/heartbeat'):
            with self.lock:
                self.heartbeats += 1
                entries = []
                for entry in body['leases']:
                    key = entry['lease_id']
                    item = {'lease_id': key, 'status': 'active', 'expires_at': expires}
                    if key in self.done:
                        item.update(self.done[key])
                    elif key in self.analyses and (self.released.is_set() or not (
                            self.scenario == 'text' or self.scenario == 'mixed' and key == '2')):
                        analysis = self.analyses[key]
                        item['translations'] = {'revision': '1', 'analysis_hash': digest(analysis),
                            'language': 'en', 'translations': {s['id']: 'Translated text' for s in analysis['segments']}}
                    entries.append(item)
                return {'server_time': server, 'leases': entries}
        key = path.split('/')[2]
        if path.endswith('/analysis'):
            self.gate('analysis', key)
            with self.lock:
                self.analyses[key] = body['analysis']
            return {'receipt': None}
        if path.endswith('/output/authorize'):
            self.results[key] = body['result']
            return {'result_hash': digest(body['result']), 'key': key}
        if path.endswith('/complete'):
            self.gate('complete', key)
            assert 'error' not in body, body.get('error')
            assert body['etag'] == self.results[key]['output']['md5']
            receipt = {'status': 'terminal', 'lease_id': key}
            with self.lock:
                assert key not in self.done, 'Duplicate settlement'
                self.done[key] = receipt
            return receipt
        raise AssertionError('Unexpected endpoint: ' + path)

    def download(self, metadata, check):
        self.gate('download', metadata['url'].rsplit('/', 1)[-1])
        check()
        return self.data

    def upload(self, authorization, data, info, check):
        self.gate('upload', authorization['key'])
        check()
        assert len(data) == info['byte_size']
        assert hashlib.sha256(data).hexdigest() == info['sha256']
        with Image.open(BytesIO(data)) as image:
            image.load()
            assert image.size == (info['width'], info['height'])
        return info['md5']


def exercise(directory, scenario, runtime=None, *, total=24, timeout=120, local_pages=2):
    runtime = runtime or FixtureRuntime()
    data = fixture_image()
    transport = SimulatedTransport(runtime, scenario, total, data)
    journal = Journal(directory, 512 * 1024 * 1024)
    config = {'node_id': 'pressure', 'resource_id': 'fixture', 'engine': {'gpu': 0},
              'max_leases': 8, 'local_pages': local_pages, 'delivery_workers': 4,
              'download_workers': 4, 'resident_bytes': 1024 * 1024 * 1024}
    agent = Agent(config, runtime, transport, journal)
    peak_reserved = 0
    snapshot = None
    started = time.monotonic()
    try:
        agent.register()
        while time.monotonic() - started < timeout:
            agent.poll_control()
            agent.reap()
            peak_reserved = max(peak_reserved, agent.pipeline.used)
            assert agent.pipeline.used <= agent.pipeline.limit
            assert len(agent.pages) <= 8
            if snapshot is None:
                if scenario == 'text':
                    ready = len(agent.pages) == 8 and all(p.step == 'text' and p.cleaned is not None
                        and p.analysis_accepted and not p.future for p in agent.pages.values())
                elif scenario == 'upload':
                    ready = len(agent.pages) == 8 and all(p.step == 'deliver' and p.cleaned is None
                        and p.completion for p in agent.pages.values()) and transport.active['upload'] == 4
                else:
                    # Five blocked pages remain; the other nineteen pass and new
                    # claims continue over several admission windows.
                    ready = len(transport.done) == total - 5
                if ready and transport.heartbeats >= 2 and time.monotonic() - started >= 1:
                    snapshot = {'claimed': transport.claimed, 'completed': len(transport.done),
                        'resident_pages': len(agent.pages), 'phases': dict(Counter(p.step for p in agent.pages.values())),
                        'active_network': dict(transport.active), 'heartbeats': transport.heartbeats,
                        'elapsed_s': time.monotonic() - started}
                    assert transport.heartbeats > 0
                    if scenario in {'text', 'upload'}:
                        assert transport.claimed == 8 and not transport.done
                    else:
                        assert transport.claimed == total
                    transport.released.set()
            if len(transport.done) == total and not agent.pages:
                break
            time.sleep(.005)
        assert snapshot is not None, {'scenario': scenario, 'completed': len(transport.done),
                                     'phases': dict(Counter(p.step for p in agent.pages.values()))}
        assert len(transport.done) == total and not agent.pages
        assert agent.pipeline.used == 0 and journal.leases() == {}
        assert transport.peak['upload'] <= 4 and transport.peak_leases == 8
        assert transport.counts['analysis'] == transport.counts['upload'] == transport.counts['complete'] == total
        return {'scenario': scenario, 'local_pages': local_pages, 'total': total,
                'wall_s': time.monotonic() - started, 'blocked_snapshot': snapshot,
                'network_peak': dict(transport.peak), 'peak_reserved_bytes': peak_reserved,
                'completed': len(transport.done), 'heartbeats': transport.heartbeats,
                'journal_empty': True, 'passed': True}
    finally:
        transport.released.set()
        agent.close()
        journal.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=Path)
    parser.add_argument('--output', type=Path, default=Path('artifacts/lama-pressure.json'))
    parser.add_argument('--timeout', type=float, default=180)
    parser.add_argument('--local-pages', type=int, default=2)
    args = parser.parse_args()
    runtime = None
    if args.models:
        from classic_node.runtime import Runtime
        runtime = Runtime({'engine': {'models': str(args.models), 'gpu': 0, 'ocr_language': 'en',
            'threads': 2, 'ocr_workers': 8, 'tile': 768, 'detect_size': 1280}, 'languages': ['en']})
        runtime.warmup()
    try:
        rows = []
        for scenario in ('text', 'upload', 'mixed'):
            with TemporaryDirectory(prefix='classic-pressure-') as directory:
                row = exercise(directory, scenario, runtime, timeout=args.timeout, local_pages=args.local_pages)
            rows.append(row)
            print(json.dumps(row), flush=True)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps({'real_image_models': bool(runtime),
                'engine_version': runtime.version if runtime else 'fixture',
                'external_llm_or_r2': False, 'rows': rows}, indent=2), encoding='utf-8')
    finally:
        if runtime:
            runtime.close()


if __name__ == '__main__':
    main()
