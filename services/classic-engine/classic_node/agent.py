"""One page lease from claim through acknowledged delivery, with batch heartbeats."""
from .pipeline import Pipeline
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
        self.step = 'download'
        self.ready_at = time.monotonic()
        self.timings = {}
        self.future = self.analysis_future = self.pending_error = None
        self.analysis_accepted = False
        self.reserved = 0
        self.next_stop = 0
        self.data = self.metadata = self.rgb = self.cleaned = self.analysis = self.completion = None
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
        self.wake = Event()
        self.pipeline = Pipeline(self)
        self.next_claim = 0
        self.control_pool = ThreadPoolExecutor(1, thread_name_prefix='heartbeat-claim')
        self.notice_pool = ThreadPoolExecutor(1, thread_name_prefix='updates')
        self.control_future = self.notice_future = None
        self.revision = 0
        self.next_notice = 0
        self.stop = Event()
        self.last_heartbeat = 0

    def apply_config(self, config):
        if config is not None:
            self.config = config
            self.transport.control.timeout = config['request_seconds']

    def adopt(self, lease, server_time, sent_at):
        key = lease['lease_id']
        if key in self.pages:
            self.pages[key].update(lease, server_time, sent_at)
            return
        if lease['status'] == 'terminal':
            self.journal.remove('lease:' + key)
            return
        saved = self.journal.get('lease:' + key, {})
        # Never persist signed URLs. Restart always obtains fresh authorization.
        public_lease = {k: v for k, v in lease.items() if k != 'input'}
        self.journal.put('lease:' + key, {**saved, 'lease': public_lease})
        page = Page(lease, server_time, sent_at)
        page.analysis = lease.get('analysis') or saved.get('analysis')
        page.completion = saved.get('completion')
        if page.stopped or page.completion:
            page.step = 'deliver'
        elif lease['config']['engine']['version'] != self.runtime.version:
            self.pipeline.error(page, NodeFailure('ENGINE_VERSION_MISMATCH'))
        self.pages[key] = page
        self.wake.set()

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
        for key, page in list(self.pages.items()):
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
            page = self.pages.get(item['lease_id'])
            if page:
                page.update(item, response['server_time'], sent_at)
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

    def deliver(self, page, body):
        page.phase = 'deliver'
        reply = self.retry(page, lambda: self.transport.post(f'/leases/{page.lease["lease_id"]}/complete', body))
        if reply.get('status') != 'terminal':
            raise ControlFailure('CONTROL_INVALID_RESPONSE')
        return reply

    def reap(self):
        self.pipeline.tick()
        for key, page in list(self.pages.items()):
            if page.future or page.analysis_future:
                continue
            try:
                page.check()
            except NodeFailure:
                pass
            if not page.terminal and page.stopped:
                if time.monotonic() >= page.next_stop:
                    page.next_stop = time.monotonic() + 1
                    page.step = 'deliver'
                    page.future = self.pipeline.delivery.submit(self.transport.post, f'/leases/{key}/complete',
                        {'lease_token': page.lease['lease_token'], 'error': {'code': 'LEASE_STOPPED'}})
                    page.future.add_done_callback(lambda _: self.wake.set())
                continue
            if page.terminal:
                self.pipeline.release(page)
                self.journal.remove('lease:' + key)
                del self.pages[key]
                self.next_claim = 0

    def close(self):
        self.stop.set()
        self.control_pool.shutdown(wait=True)
        for page in list(self.pages.values()):
            page.stopped = True
        self.wake.set()
        self.notice_pool.shutdown(wait=True)
        self.pipeline.close()

    def poll_control(self):
        if self.notice_future and self.notice_future.done():
            try:
                self.revision = self.notice_future.result()['revision']
                self.last_heartbeat = 0
                self.next_claim = 0
            except NodeFailure as error:
                LOG.warning('updates: %s', error.code)
                self.next_notice = time.monotonic() + 1
            self.notice_future = None
        if not self.notice_future and not self.stop.is_set() and time.monotonic() >= self.next_notice:
            self.next_notice = time.monotonic() + .05
            self.notice_future = self.notice_pool.submit(self.transport.post,
                f'/nodes/{self.local["node_id"]}/updates', {'revision': self.revision,
                    'wait_seconds': min(20, max(0, self.config['request_seconds'] - 2))})
            self.notice_future.add_done_callback(lambda _: self.wake.set())
        if self.control_future and self.control_future.done():
            try:
                self.control_future.result()
            except NodeFailure as error:
                LOG.warning('control: %s', error.code)
            self.control_future = None
        if not self.control_future:
            if time.monotonic() - self.last_heartbeat >= self.config['heartbeat_seconds']:
                self.last_heartbeat = time.monotonic()
                self.control_future = self.control_pool.submit(self.heartbeat)
            elif not self.stop.is_set() and time.monotonic() >= self.next_claim:
                self.next_claim = time.monotonic() + self.config['poll_seconds']
                self.control_future = self.control_pool.submit(self.claim)
            if self.control_future:
                self.control_future.add_done_callback(lambda _: self.wake.set())

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
            self.next_claim = 0
            while not self.stop.is_set() or self.pages:
                try:
                    self.poll_control()
                    self.reap()
                    if self.stop.is_set() and all(not p.future and not p.analysis_future for p in self.pages.values()):
                        break  # Keep uncertain deliveries in the journal for startup reconciliation.
                except NodeFailure as error:
                    LOG.warning('control: %s', error.code)
                self.wake.wait(.02)
                self.wake.clear()
        finally:
            self.close()
