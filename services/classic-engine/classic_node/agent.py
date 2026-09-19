"""One page lease from claim through acknowledged delivery, with batch heartbeats."""
from concurrent.futures import ThreadPoolExecutor
import logging
from threading import Condition, Event
import time
from uuid import uuid4

from .protocol import ControlFailure, NodeFailure, digest, timestamp

LOG = logging.getLogger('classic-node')


class Page:
    def __init__(self, lease, server_time, sent_at):
        self.lease = lease
        self.condition = Condition()
        self.deadline = 0
        self.terminal = None
        self.stopped = False
        self.phase = 'queued'
        self.received_at = sent_at
        self.translations = lease.get('translations')
        self.update(lease, server_time, sent_at)

    def update(self, reply, server_time, sent_at):
        with self.condition:
            status = reply['status']
            if status == 'terminal':
                self.terminal = reply
            elif status == 'stop':
                self.stopped = True
            elif not self.stopped and not self.terminal:
                if self.deadline and time.monotonic() >= self.deadline:
                    self.stopped = True
                    self.condition.notify_all()
                    return
                # Account for network round-trip and never resurrect local expiry.
                self.deadline = sent_at + max(0, timestamp(reply['expires_at']) - timestamp(server_time) - 2)
                self.lease['expires_at'] = reply['expires_at']
                if reply.get('translations'):
                    self.translations = reply['translations']
            self.condition.notify_all()

    def check(self):
        with self.condition:
            if self.terminal or self.stopped or time.monotonic() >= self.deadline:
                self.stopped = True
                raise NodeFailure('LEASE_STOPPED')


class Agent:
    def __init__(self, config, runtime, transport, journal):
        self.local, self.runtime, self.transport, self.journal = config, runtime, transport, journal
        self.config = None
        self.pages = {}
        self.futures = {}
        self.pool = ThreadPoolExecutor(config['local_pages'], thread_name_prefix='page')
        self.stop = Event()
        self.last_heartbeat = 0

    def apply_config(self, config):
        if config is not None:
            self.config = config
            self.transport.control.timeout = config['request_seconds']

    def adopt(self, lease, server_time, sent_at):
        key = lease['lease_id']
        if lease['status'] == 'terminal':
            self.journal.remove('lease:' + key)
            return
        if key in self.pages:
            self.pages[key].update(lease, server_time, sent_at)
            return
        saved = self.journal.get('lease:' + key, {})
        # Never persist signed URLs. Restart always obtains fresh authorization.
        public_lease = {k: v for k, v in lease.items() if k != 'input'}
        self.journal.put('lease:' + key, {**saved, 'lease': public_lease})
        page = Page(lease, server_time, sent_at)
        self.pages[key] = page
        self.futures[key] = self.pool.submit(self.execute, page)

    def register(self):
        sent_at = time.monotonic()
        response = self.transport.post('/nodes/register', {'protocol_version': 2,
            'engine_version': self.runtime.version, 'resource_id': self.local['resource_id'],
            'device': 'cpu' if self.local['engine']['gpu'] < 0 else 'vulkan:' + str(self.local['engine']['gpu']),
            'supported_languages': self.runtime.languages, 'ready': True})
        if response['protocol_version'] != 2:
            raise NodeFailure('PROTOCOL_MISMATCH')
        self.apply_config(response['config'])
        outstanding = {lease['lease_id'] for lease in response['leases']}
        # A completed/reclaimed lease absent from registration can be discarded.
        for key in self.journal.leases():
            if key not in outstanding:
                self.journal.remove('lease:' + key)
        for lease in response['leases']:
            self.adopt(lease, response['server_time'], sent_at)
        self.last_heartbeat = sent_at

    def heartbeat(self):
        entries = []
        for key, page in self.pages.items():
            with page.condition:
                if page.stopped or page.terminal:
                    continue
                entries.append({'lease_id': key, 'lease_token': page.lease['lease_token'],
                    'translations_revision': page.translations['revision'] if page.translations else None,
                    'phase': page.phase})
        sent_at = time.monotonic()
        response = self.transport.post(f'/nodes/{self.local["node_id"]}/heartbeat',
            {'config_version': self.config['version'], 'leases': entries})
        self.apply_config(response.get('config'))
        for item in response['leases']:
            if item['lease_id'] in self.pages:
                self.pages[item['lease_id']].update(item, response['server_time'], sent_at)
        self.last_heartbeat = sent_at

    def claim(self):
        pending = self.journal.get('claim')
        count = min(self.config['execution_slots'], self.local['max_leases']) - len(self.pages)
        if not pending:
            if not self.config['enabled'] or count <= 0 or self.stop.is_set():
                return
            pending = {'request_id': uuid4().hex, 'config_version': self.config['version'], 'count': count}
            self.journal.put('claim', pending)
        sent_at = time.monotonic()
        try:
            response = self.transport.post(f'/nodes/{self.local["node_id"]}/claim', pending)
        except ControlFailure as error:
            if error.code == 'NODE_CONFIG_CONFLICT':
                # The controller checks saved receipts before config conflicts.
                self.journal.remove('claim')
                self.heartbeat()
            else:
                raise
            return
        if response['request_id'] != pending['request_id']:
            raise NodeFailure('CONTROL_INVALID_RESPONSE')
        self.apply_config(response.get('config'))
        for lease in response['leases']:
            self.adopt(lease, response['server_time'], sent_at)
        self.journal.remove('claim')  # Only after every returned lease is durable.

    def retry(self, page, operation):
        while True:
            page.check()
            try:
                return operation()
            except ControlFailure as error:
                if error.status and error.status < 500 and error.status != 429:
                    if error.code in {'LEASE_EXPIRED', 'PAGE_DEADLINE_EXCEEDED', 'ASSET_EXPIRED'}:
                        raise NodeFailure('LEASE_STOPPED') from None
                    raise
                with page.condition:
                    page.condition.wait(.5)

    def input_bytes(self, page):
        metadata = page.lease.get('input')
        authorized_at = page.received_at
        for attempt in range(3):
            page.check()
            # Every startup claim/registration is authorization; renew near expiry.
            if (metadata is None or timestamp(metadata['url_expires_at']) - timestamp(metadata['server_time'])
                    <= time.monotonic() - authorized_at + 2):
                authorized_at = time.monotonic()
                metadata = self.retry(page, lambda: self.transport.post(
                    f'/leases/{page.lease["lease_id"]}/input/authorize', {'lease_token': page.lease['lease_token']}))
            try:
                return self.transport.download(metadata, page.check), metadata
            except NodeFailure as error:
                if error.code not in {'STORAGE_AUTH_FAILED', 'STORAGE_UNAVAILABLE'} or attempt == 2:
                    raise
                if error.code == 'STORAGE_AUTH_FAILED':
                    metadata = None
        raise NodeFailure('STORAGE_UNAVAILABLE')

    def execute(self, page):
        key = page.lease['lease_id']
        saved = self.journal.get('lease:' + key)
        try:
            page.check()
            if page.lease['config']['engine']['version'] != self.runtime.version:
                raise NodeFailure('ENGINE_VERSION_MISMATCH')
            if saved.get('completion'):
                self.deliver(page, saved['completion'])
                return
            page.phase = 'download'
            data, metadata = self.input_bytes(page)
            page.check()
            rgb = self.runtime.decode(data, metadata)
            analysis = page.lease.get('analysis') or saved.get('analysis')
            if analysis is None:
                page.phase = 'analyze'
                analysis = self.runtime.analyze(rgb, metadata['sha256'])
                saved['analysis'] = analysis
                self.journal.put('lease:' + key, saved)
            if analysis['input_hash'] != metadata['sha256'] or analysis['version'] != self.runtime.version:
                raise NodeFailure('ENGINE_VERSION_MISMATCH')
            page.check()
            reply = self.retry(page, lambda: self.transport.post(f'/leases/{key}/analysis',
                {'lease_token': page.lease['lease_token'], 'analysis': analysis, 'analysis_hash': digest(analysis)}))
            if reply['receipt']:
                page.terminal = reply['receipt']
                return
            page.check()
            page.phase = 'inpaint'
            cleaned = self.runtime.inpaint(rgb, analysis)
            page.check()
            page.phase = 'text'
            with page.condition:
                while not page.translations:
                    page.check()
                    page.condition.wait(.25)
            page.check()
            page.phase = 'render'
            result = self.runtime.render(cleaned, analysis, page.translations, page.lease['language'])
            page.check()
            body = {'lease_token': page.lease['lease_token'], 'result': result}
            saved['completion'] = body
            saved.pop('analysis', None)
            self.journal.put('lease:' + key, saved)
            self.deliver(page, body)
        except NodeFailure as error:
            if page.terminal:
                return
            if error.code == 'LEASE_STOPPED':
                page.phase = 'stopped'
                page.stopped = True
                return
            # Fixed, content-free diagnostics; no OCR, URL or exception text.
            code = error.code if error.code in {'ENGINE_VERSION_MISMATCH', 'INPUT_INVALID', 'INPUT_HASH_MISMATCH',
                'STORAGE_AUTH_FAILED', 'STORAGE_UNAVAILABLE', 'CLASSIC_ANALYZE_FAILED',
                'CLASSIC_INPAINT_FAILED', 'CLASSIC_RENDER_FAILED'} else 'CLASSIC_LOCAL_INTERRUPTED'
            self.report_failure(page, code)
        except Exception:
            self.report_failure(page, 'CLASSIC_LOCAL_INTERRUPTED')

    def report_failure(self, page, code):
        key = page.lease['lease_id']
        saved = self.journal.get('lease:' + key, {})
        # An uncertain successful result must never be replaced with an error.
        body = saved.get('completion') or {'lease_token': page.lease['lease_token'], 'error': {'code': code}}
        self.journal.put('lease:' + key, {**saved, 'completion': body})
        try:
            self.deliver(page, body)
        except NodeFailure:
            page.stopped = True
        LOG.warning('page %s: %s', key, code)

    def deliver(self, page, body):
        page.phase = 'deliver'
        reply = self.retry(page, lambda: self.transport.post(f'/leases/{page.lease["lease_id"]}/complete', body))
        if reply.get('status') != 'terminal':
            raise ControlFailure('CONTROL_INVALID_RESPONSE')
        page.terminal = reply

    def reap(self):
        for key, future in list(self.futures.items()):
            page = self.pages[key]
            if not future.done():
                continue
            try:
                future.result()
            except Exception:
                page.stopped = True
                LOG.error('page %s: LOCAL_WORKER_FAILED', key)
            if not page.terminal and page.stopped:
                # Acknowledge only after uninterruptible model work has drained.
                try:
                    page.terminal = self.transport.post(f'/leases/{key}/complete',
                        {'lease_token': page.lease['lease_token'], 'error': {'code': 'LEASE_STOPPED'}})
                except ControlFailure:
                    continue
            if page.terminal:
                self.journal.remove('lease:' + key)
                del self.pages[key]
                del self.futures[key]

    def run(self):
        try:
            while not self.stop.is_set():
                try:
                    self.register()
                    break
                except ControlFailure as error:
                    if error.status and error.status < 500 and error.status != 429:
                        raise
                    LOG.warning('registration: %s', error.code)
                    self.stop.wait(1)
            next_claim = 0
            while not self.stop.is_set() or self.pages:
                try:
                    interval = self.config['waiting_heartbeat_seconds'] if any(
                        page.phase == 'text' for page in self.pages.values()) else self.config['heartbeat_seconds']
                    if time.monotonic() - self.last_heartbeat >= interval:
                        self.heartbeat()
                    self.reap()
                    if self.stop.is_set() and all(future.done() for future in self.futures.values()):
                        break  # Keep uncertain deliveries in the journal for startup reconciliation.
                    if not self.stop.is_set() and time.monotonic() >= next_claim:
                        self.claim()
                        next_claim = time.monotonic() + self.config['poll_seconds']
                except NodeFailure as error:
                    LOG.warning('control: %s', error.code)
                time.sleep(min(.25, self.config['poll_seconds']))
        finally:
            self.pool.shutdown(wait=True)
