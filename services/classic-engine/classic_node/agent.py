"""One page lease from claim through acknowledged delivery, with batch heartbeats."""
from .pipeline import Pipeline
from concurrent.futures import ThreadPoolExecutor
import logging
from threading import Condition, Event, Lock
import time
from uuid import uuid4

from .protocol import ControlFailure, NodeFailure, timestamp
from .operations import NetworkLog, utc_now

LOG = logging.getLogger('classic-node')


class Page:
    def __init__(self, lease, server_time, sent_at):
        self.lease = lease
        self.condition = Condition()
        self.deadline = 0
        self.renewed_at = 0
        self.terminal = None
        self.stopped = False
        self.phase = 'queued'
        self.step = 'download'
        self.ready_at = time.monotonic()
        self.timings = {}
        self.future = self.analysis_future = self.pending_error = None
        self.analysis_accepted = False
        self.reserved = 0
        self.render_cache_reserved = 0
        self.next_stop = 0
        self.data = self.metadata = self.rgb = self.cleaned = self.analysis = self.alpha = self.completion = None
        self.received_at = sent_at
        self.translations = lease.get('translations')
        self.update(lease, server_time, sent_at)

    def update(self, reply, server_time=None, sent_at=None):
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
                if sent_at is not None and sent_at >= self.renewed_at:
                    # Only registration/claim/heartbeat renew execution rights.
                    # A long-poll update carries no expiry and never extends them.
                    self.deadline = sent_at + max(0, timestamp(reply['expires_at']) - timestamp(server_time) - 2)
                    self.lease['expires_at'] = reply['expires_at']
                    self.renewed_at = sent_at
                if reply.get('translations'):
                    self.translations = reply['translations']
            self.condition.notify_all()

    def check(self):
        with self.condition:
            if self.terminal or self.stopped or time.monotonic() >= self.deadline:
                self.stopped = True
                raise NodeFailure('LEASE_STOPPED')


class Agent:
    def __init__(self, config, runtime, transport, journal, *, stop=None, operations=None):
        self.local, self.runtime, self.transport, self.journal = config, runtime, transport, journal
        self.config = None
        self.config_lock = Lock()
        self.pages = {}
        self.wake = Event()
        self.pipeline = Pipeline(self)
        self.next_claim = 0
        self.claim_wake_version = self.claim_started_wake_version = 0
        self.claim_retry_after = None
        self.heartbeat_pool = ThreadPoolExecutor(1, thread_name_prefix='heartbeat')
        self.claim_pool = ThreadPoolExecutor(1, thread_name_prefix='claim')
        self.notice_pool = ThreadPoolExecutor(1, thread_name_prefix='updates')
        self.heartbeat_future = self.claim_future = self.notice_future = None
        self.claim_generation = self.notice_claim_generation = 0
        self.revision = 0
        self.next_notice = 0
        self.stop = stop if stop is not None else Event()
        self.operations = operations
        self.network_log = NetworkLog()
        self.heartbeat_at = None
        self.heartbeat_monotonic = 0
        self.heartbeat_logged = 0
        self.last_heartbeat = 0

    def connected(self, action):
        self.network_log.succeeded(action)
        self.heartbeat_at = utc_now()
        self.heartbeat_monotonic = time.monotonic()
        if action == 'registration' or self.heartbeat_monotonic - self.heartbeat_logged >= 60:
            LOG.info('event=%s config_version=%s active_leases=%s', action, self.config['version'], len(self.pages))
            self.heartbeat_logged = self.heartbeat_monotonic

    def apply_config(self, config):
        with self.config_lock:
            if config is not None and (self.config is None or config['version'] >= self.config['version']):
                changed = self.config is None or config['version'] != self.config['version']
                self.config = config
                self.transport.control.timeout = config['request_seconds']
                if changed:
                    self.claim_wake_version += 1
                    self.next_claim = 0
                    self.wake.set()

    def claim_capacity(self):
        if not self.config['enabled'] or self.stop.is_set():
            return 0
        slots = min(self.config['execution_slots'], self.local['max_leases']) - len(self.pages)
        return max(0, min(slots, self.pipeline.claim_capacity()))

    def request_claim(self):
        with self.config_lock:
            self.claim_wake_version += 1
            self.next_claim = 0
        self.wake.set()

    def lease_entries(self, *, phases=False):
        entries = []
        for key, page in list(self.pages.items()):
            with page.condition:
                if page.stopped or page.terminal:
                    continue
                item = {'lease_id': key, 'lease_token': page.lease['lease_token'],
                        'translations_revision': page.translations['revision'] if page.translations else None}
                if phases:
                    item['phase'] = page.phase
                entries.append(item)
        return entries

    def adopt(self, lease, server_time, sent_at):
        key = lease['lease_id']
        if key in self.pages:
            self.pages[key].update(lease, server_time, sent_at)
            return
        if lease['status'] == 'terminal':
            self.journal.remove('lease:' + key)
            return
        saved = self.journal.get('lease:' + key, {})
        # Registration revalidates every input descriptor and execution lease.
        public_lease = {k: v for k, v in lease.items() if k != 'input'}
        self.journal.put('lease:' + key, {**saved, 'lease': public_lease})
        page = Page(lease, server_time, sent_at)
        page.analysis = lease.get('analysis') or saved.get('analysis')
        page.completion = saved.get('completion')
        if page.stopped or page.completion:
            page.step = 'deliver'
            if page.completion:
                self.pipeline.resize_reservation(page, self.pipeline.delivery_reservation(page.completion))
        elif lease['config']['engine']['protocol_version'] != 3:
            self.pipeline.error(page, NodeFailure('PROTOCOL_MISMATCH'))
        self.pages[key] = page
        self.wake.set()

    def register(self):
        sent_at = time.monotonic()
        response = self.transport.post('/nodes/register', {'protocol_version': 3,
            'engine_version': self.runtime.version, 'resource_id': self.local['resource_id'],
            'device': 'cuda:' + str(self.local['engine']['gpu']),
            'supported_languages': self.runtime.languages, 'ready': True, 'result_formats': ['overlay-v1', 'overlay-tiles-v1']})
        if response['protocol_version'] != 3:
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
        self.connected('registration')

    def heartbeat(self):
        entries = self.lease_entries(phases=True)
        sent_at = time.monotonic()
        response = self.transport.post(f'/nodes/{self.local["node_id"]}/heartbeat',
            {'config_version': self.config['version'], 'leases': entries})
        self.apply_config(response.get('config'))
        for item in response['leases']:
            page = self.pages.get(item['lease_id'])
            if page:
                page.update(item, response['server_time'], sent_at)
        self.connected('heartbeat')

    def claim(self):
        self.claim_retry_after = None
        pending = self.journal.get('claim')
        count = self.claim_capacity()
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
                self.last_heartbeat = 0
            else:
                raise
            return
        if response['request_id'] != pending['request_id']:
            raise NodeFailure('CONTROL_INVALID_RESPONSE')
        self.apply_config(response.get('config'))
        retry_after = response.get('retry_after_seconds')
        if retry_after is not None and (type(retry_after) not in (int, float)
                or not .1 <= retry_after <= self.config['poll_seconds']):
            raise ControlFailure('CONTROL_INVALID_RESPONSE')
        for lease in response['leases']:
            self.adopt(lease, response['server_time'], sent_at)
        self.journal.remove('claim')  # Only after every returned lease is durable.
        if not response['leases']:
            self.claim_retry_after = retry_after
        return bool(response['leases'])

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
        if not metadata:
            raise ControlFailure('CONTROL_INVALID_RESPONSE')
        data = self.retry(page, lambda: self.transport.download(page.lease['lease_id'],
            page.lease['lease_token'], metadata, page.check))
        return data, metadata

    def deliver(self, page, body):
        page.phase = 'deliver'
        key = page.lease['lease_id']
        if 'result' in body:
            data = self.journal.output('lease:' + key)
            reply = self.retry(page, lambda: self.transport.deliver(key, body, data, page.check))
        else:
            reply = self.retry(page, lambda: self.transport.post(f'/leases/{key}/complete', body))
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
                self.request_claim()

    def close(self):
        self.stop.set()
        if self.operations:
            self.operations.stopping()
        self.claim_pool.shutdown(wait=True)
        self.heartbeat_pool.shutdown(wait=True)
        for page in list(self.pages.values()):
            page.stopped = True
        self.wake.set()
        self.notice_pool.shutdown(wait=True)
        self.pipeline.close()

    def poll_control(self):
        if self.claim_future and self.claim_future.done():
            try:
                claimed = self.claim_future.result()
                self.network_log.succeeded('claim')
                with self.config_lock:
                    # Preserve only a new wake, not the initial zero deadline or
                    # a fallback that elapsed while the network request ran.
                    awakened = self.claim_wake_version != self.claim_started_wake_version
                    delay = self.claim_retry_after if self.claim_retry_after is not None else self.config['poll_seconds']
                    self.next_claim = 0 if claimed or awakened else time.monotonic() + delay
            except NodeFailure as error:
                self.network_log.failed('claim', error)
                self.next_claim = time.monotonic() + 1
            self.claim_future = None
        if self.heartbeat_future and self.heartbeat_future.done():
            try:
                self.heartbeat_future.result()
                self.network_log.succeeded('heartbeat')
            except NodeFailure as error:
                self.network_log.failed('heartbeat', error)
            self.heartbeat_future = None
        if self.notice_future and self.notice_future.done():
            try:
                response = self.notice_future.result()
                self.revision = response['revision']
                self.apply_config(response.get('config'))
                for item in response.get('leases', []):
                    page = self.pages.get(item['lease_id'])
                    if page:
                        page.update(item)
                self.network_log.succeeded('updates')
                if response.get('claim_ready') and self.notice_claim_generation == self.claim_generation:
                    self.request_claim()
            except NodeFailure as error:
                self.network_log.failed('updates', error)
                self.next_notice = time.monotonic() + 1
            self.notice_future = None
        if not self.heartbeat_future and time.monotonic() - self.last_heartbeat >= self.config['heartbeat_seconds']:
            self.last_heartbeat = time.monotonic()
            self.heartbeat_future = self.heartbeat_pool.submit(self.heartbeat)
            self.heartbeat_future.add_done_callback(lambda _: self.wake.set())
        if (not self.claim_future and not self.stop.is_set() and time.monotonic() >= self.next_claim
                and (self.journal.get('claim') or self.claim_capacity())):
            self.claim_generation += 1
            with self.config_lock:
                self.claim_started_wake_version = self.claim_wake_version
                self.next_claim = time.monotonic() + self.config['poll_seconds']
            self.claim_future = self.claim_pool.submit(self.claim)
            self.claim_future.add_done_callback(lambda _: self.wake.set())
        if not self.notice_future and not self.stop.is_set() and time.monotonic() >= self.next_notice:
            self.next_notice = time.monotonic() + .05
            # Readiness observed before an in-flight claim finishes can be stale.
            self.notice_claim_generation = self.claim_generation - bool(self.claim_future)
            self.notice_future = self.notice_pool.submit(self.transport.post,
                f'/nodes/{self.local["node_id"]}/updates', {'revision': self.revision,
                    'wait_seconds': min(20, max(0, self.config['request_seconds'] - 2)),
                    'config_version': self.config['version'], 'can_claim': bool(self.claim_capacity()),
                    'leases': self.lease_entries()})
            self.notice_future.add_done_callback(lambda _: self.wake.set())

    def run(self):
        try:
            delay = 1
            while not self.stop.is_set():
                if self.operations:
                    self.operations.pulse()
                try:
                    self.register()
                    break
                except ControlFailure as error:
                    self.network_log.failed('registration', error)
                    if error.status and error.status < 500 and error.status != 429:
                        raise
                    self.stop.wait(delay)
                    delay = min(30, delay * 2)
            self.next_claim = 0
            while not self.stop.is_set() or self.pages:
                if self.operations:
                    self.operations.pulse()
                try:
                    self.poll_control()
                    self.reap()
                    if self.stop.is_set() and all(not p.future and not p.analysis_future for p in self.pages.values()):
                        break  # Keep uncertain deliveries in the journal for startup reconciliation.
                except NodeFailure as error:
                    self.network_log.failed('control', error)
                self.wake.wait(.02)
                self.wake.clear()
        finally:
            self.close()
