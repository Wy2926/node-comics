"""Host-affine documents: local page checkpoints, only source/final ZIP on R2."""
from concurrent.futures import ThreadPoolExecutor
import json
import logging
import math
from pathlib import Path
from threading import RLock
import re
import time
from uuid import uuid4

from .object_transfer import ObjectTransfer
from .operations import report_page_failure
from .protocol import ControlFailure, NodeFailure, MAX_CHECKPOINT_BYTES
from .timing import WIRE_FIELDS

PREFIX = 'document-lease:'
LOG = logging.getLogger('classic-node')
LOCAL_TIMINGS = WIRE_FIELDS | frozenset((
    'prepare', 'prepare_queue', 'package', 'package_queue', 'persist', 'persist_queue',
    'deliver', 'deliver_queue', 'download_sign', 'download_sign_attempts',
    'download_get', 'download_get_attempts', 'download_retries',
    'upload_sign', 'upload_sign_attempts', 'upload_put', 'upload_put_attempts',
    'upload_retries', 'complete', 'complete_attempts', 'complete_retries',
    'inpaint_prepare', 'inpaint_solid_fill', 'inpaint_lama'))


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()


def safe_timings(values):
    return {name: round(value, 6) for name, value in values.items() if name in LOCAL_TIMINGS
            and type(value) in (int, float) and math.isfinite(value) and value >= 0}


class DocumentRunner:
    def __init__(self, agent):
        self.agent = agent
        self.pages = {}
        self.adoption_lock = RLock()
        self.control = ThreadPoolExecutor(2, thread_name_prefix='document-control')
        self.claim_future = self.heartbeat_future = self.sync_future = None
        self.next_claim = self.next_heartbeat = self.next_sync = 0
        self.objects = ObjectTransfer()
        self.state_dir = Path(agent.local.get('state_dir') or agent.journal.root)
        self._protocol = False  # Probed once at registration, not on the hot path.

    def protocol(self):
        if self._protocol is False:
            try:
                from comic_document_files import check_parser_sandbox
                check_parser_sandbox(self.state_dir, require_sandbox=True)
                self._protocol = 2
            except Exception:
                self._protocol = None
                LOG.warning('event=document_capability_disabled code=DOCUMENT_PARSER_SANDBOX_UNAVAILABLE')
        return self._protocol

    def post(self, path, body):
        return self.agent.transport.document_post(path, body)

    @staticmethod
    def identity(page):
        return {'lease_token': page.lease['lease_token'],
                'workspace_generation': page.lease['workspace_generation']}

    def workspace(self, page):
        if not hasattr(page, 'document_workspace'):
            from comic_document_files import FileLimits
            from .document_workspace import DocumentWorkspace
            limits = dict(page.lease.get('file_limits') or {})
            for name in ('max_spool_bytes', 'max_output_bytes'):
                if name in page.lease.get('limits', {}):
                    limits[name] = page.lease['limits'][name]
            limits['max_spool_bytes'] = min(limits.get('max_spool_bytes', FileLimits().max_spool_bytes),
                                           self.agent.local.get('document_spool_bytes', 6 * 1024 ** 3))
            page.document_workspace = DocumentWorkspace(
                self.state_dir, page.lease['job_id'], page.lease['workspace_generation'],
                owner_id=self.agent.local['node_id'], limits=FileLimits(**limits),
                require_sandbox=True, create=page.lease['action'] == 'doc_prepare')
        return page.document_workspace

    def measured(self, page, name, operation):
        page.check()
        started = time.monotonic()
        page.timings[name + '_attempts'] = page.timings.get(name + '_attempts', 0) + 1
        try:
            return operation()
        finally:
            page.timings[name] = page.timings.get(name, 0.) + time.monotonic() - started

    def log_timings(self, page, stage):
        LOG.info('event=document_page_stage lease_id=%s action=%s stage=%s timings=%s',
                 page.lease['lease_id'], page.lease['action'], stage,
                 json.dumps(safe_timings(page.timings), sort_keys=True, separators=(',', ':')))

    def set_source(self, page, source, sent):
        if source['ref'] != page.lease['source']['ref']:
            raise NodeFailure('CONTROL_INVALID_RESPONSE')
        lifetime = source['transfer'].get('expires_in')
        if type(lifetime) not in (int, float) or not math.isfinite(lifetime) or lifetime < 0:
            raise NodeFailure('CONTROL_INVALID_RESPONSE')
        page.document_source = (source, sent + max(0, lifetime - 2))

    def refresh_source(self, page):
        sent = time.monotonic()
        reply = self.measured(page, 'download_sign', lambda: self.post(
            f'/leases/{page.lease["lease_id"]}/inputs', self.identity(page)))
        self.set_source(page, reply['source'], sent)

    def prepare(self, page):
        def download(ref, path, check):
            attempts, refreshed_forbidden = 0, False
            def transfer():
                item = page.document_source[0]
                return self.objects.download_to_file(ref, item['transfer'], path, check)
            def get_source():
                nonlocal attempts, refreshed_forbidden
                retrying = attempts > 0
                attempts += 1
                if retrying:
                    page.timings['download_retries'] = page.timings.get('download_retries', 0) + 1
                if retrying or time.monotonic() >= page.document_source[1]:
                    self.refresh_source(page)
                try:
                    return self.measured(page, 'download_get', transfer)
                except ControlFailure as error:
                    if error.code != 'DOCUMENT_TRANSFER_FAILED' or error.status != 403 or refreshed_forbidden:
                        raise
                    refreshed_forbidden = True
                    self.refresh_source(page)
                    return self.measured(page, 'download_get', transfer)
            return self.agent.retry(page, get_source)
        rows = self.workspace(page).prepare(page.lease['source']['ref'], page.lease['source_type'],
                                             download, check=page.check)
        return {'pages': [{'page_index': row['page_index'], 'source_name': row['source_name'],
                           'input_ref': {k: row[k] for k in ('sha256', 'byte_size', 'mime', 'width', 'height')}}
                          for row in rows]}

    def capacity(self):
        config = self.agent.config or {}
        if self._protocol is None or not config.get('enabled') or self.agent.stop.is_set():
            return 0
        maximum = config.get('document_slots', 0)
        slots = min(config.get('execution_slots', 0), self.agent.local['max_leases']) - len(self.agent.active_pages())
        return int(len(self.pages) < maximum and slots > 0 and self.agent.pipeline.claim_capacity() > 0)

    def sync(self):
        from .document_workspace import DocumentWorkspace
        inventory = DocumentWorkspace.inventory(self.state_dir)
        if not (self.agent.config or {}).get('document_slots', 0) and not self.agent.journal.leases(PREFIX) and not inventory:
            return
        # Cleanup runs on a bounded control worker, never in the scheduling tick.
        ids = list(dict.fromkeys(item['job_id'] for item in inventory))
        for offset in range(0, max(1, len(ids)), 200):
            sent = time.monotonic()
            reply = self.post(f'/nodes/{self.agent.local["node_id"]}/sync', {'workspace_ids': ids[offset:offset + 200]})
            self.agent.apply_config(reply.get('config'))
            active = {item['lease_id'] for item in reply['leases']}
            for key in self.agent.journal.leases(PREFIX):
                if key not in active and key not in self.pages:
                    self.agent.journal.remove(PREFIX + key)
            for lease in reply['leases']:
                self.adopt(lease, reply['server_time'], sent)
            states = {item['job_id']: item for item in reply.get('workspaces', [])}
            for item in inventory:
                state = states.get(item['job_id'])
                if not state:
                    continue  # Absence is not an authoritative cleanup instruction.
                terminal = state['status'] in ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
                generation = state.get('workspace_generation')
                obsolete = type(generation) is int and generation > item['workspace_generation']
                busy = any(p.lease['job_id'] == item['job_id'] for p in list(self.pages.values()))
                if (terminal or obsolete) and not busy:
                    DocumentWorkspace(self.state_dir, item['job_id'], item['workspace_generation'],
                                      owner_id=self.agent.local['node_id']).cleanup()

    def adopt(self, lease, server_time, sent):
        with self.adoption_lock:
            from .agent import Page
            key = lease['lease_id']
            if key in self.pages:
                page = self.pages[key]
                page.update(lease, server_time, sent)
                if lease['status'] == 'active' and lease['action'] == 'doc_prepare':
                    self.set_source(page, lease['source'], sent)
                return
            if lease['status'] != 'active':
                self.agent.journal.remove(PREFIX + key)
                return
            if lease.get('action') not in ('doc_prepare', 'doc_ocr', 'doc_render', 'doc_zip'):
                raise NodeFailure('PROTOCOL_MISMATCH')
            saved = self.agent.journal.get(PREFIX + key, {})
            page = Page(dict(lease), server_time, sent)
            if lease['action'] == 'doc_prepare':
                self.set_source(page, lease['source'], sent)
                page.step = 'prepare'
            elif lease['action'] == 'doc_zip':
                page.step = 'package'
            page.timings.update(safe_timings(saved.get('timings', {})))
            page.completion = saved.get('completion')
            if page.completion:
                if page.completion.get('workspace_generation') != lease['workspace_generation']:
                    raise NodeFailure('CONTROL_INVALID_RESPONSE')
                page.step = 'deliver'
            safe = {name: value for name, value in lease.items() if name != 'source'}
            self.agent.journal.put(PREFIX + key, {**saved, 'lease': safe})
            if page.completion:
                self.agent.pipeline.resize_reservation(page, MAX_CHECKPOINT_BYTES * 2)
            self.pages[key] = page

    def claim(self):
        pending = self.agent.journal.get('document-claim')
        if not pending:
            if not self.capacity():
                return False
            pending = {'request_id': 'doc_' + uuid4().hex, 'config_version': self.agent.config['version'], 'count': 1}
            self.agent.journal.put('document-claim', pending)
        sent = time.monotonic()
        try:
            reply = self.post(f'/nodes/{self.agent.local["node_id"]}/claim', pending)
        except ControlFailure as error:
            if error.code == 'NODE_CONFIG_CONFLICT':
                self.agent.journal.remove('document-claim')
                self.agent.last_heartbeat = 0
                return False
            raise
        if reply.get('request_id') != pending['request_id']:
            raise NodeFailure('CONTROL_INVALID_RESPONSE')
        self.agent.apply_config(reply.get('config'))
        for lease in reply['leases']:
            self.adopt(lease, reply['server_time'], sent)
        self.agent.journal.remove('document-claim')
        return bool(reply['leases'])

    def heartbeat(self):
        sent = time.monotonic()
        reply = self.post(f'/nodes/{self.agent.local["node_id"]}/heartbeat', {'leases': [
            {'lease_id': key, **self.identity(page)} for key, page in list(self.pages.items())]})
        self.agent.apply_config(reply.get('config'))
        for item in reply['leases']:
            if page := self.pages.get(item['lease_id']):
                page.update(item, reply['server_time'], sent)

    def poll_control(self):
        if self._protocol is None:
            return
        at = time.monotonic()
        for name in ('claim', 'heartbeat', 'sync'):
            future = getattr(self, name + '_future')
            if future and future.done():
                try:
                    result = future.result()
                    self.agent.network_log.succeeded('document-' + name)
                    if name == 'claim':
                        self.next_claim = at + (0 if result else self.agent.config['poll_seconds'])
                except Exception as error:
                    failure = error if isinstance(error, NodeFailure) else NodeFailure('DOCUMENT_WORKSPACE_UNAVAILABLE')
                    self.agent.network_log.failed('document-' + name, failure)
                    setattr(self, 'next_' + name, at + (30 if name == 'sync' else 1))
                setattr(self, name + '_future', None)
        if self.pages and self.heartbeat_future is None and at >= self.next_heartbeat:
            self.next_heartbeat = at + self.agent.config['heartbeat_seconds']
            self.heartbeat_future = self.control.submit(self.heartbeat)
            self.heartbeat_future.add_done_callback(lambda _: self.agent.wake.set())
        if self.sync_future is None and at >= self.next_sync and not self.agent.stop.is_set():
            self.next_sync = at + max(30, self.agent.config['poll_seconds'])
            self.sync_future = self.control.submit(self.sync)
            self.sync_future.add_done_callback(lambda _: self.agent.wake.set())
        if (self.claim_future is None and not self.agent.stop.is_set() and at >= self.next_claim
                and self.agent.claim_future is None and (self.agent.journal.get('document-claim') or self.capacity())):
            self.claim_future = self.control.submit(self.claim)
            self.claim_future.add_done_callback(lambda _: self.agent.wake.set())

    def download(self, page):
        page.check()
        workspace = self.workspace(page)
        saved = workspace.checkpoint(page.lease['page_index'], page.lease['action'])
        if saved:
            page.check()
            return {'completion': saved}
        value = {'input': workspace.input(page.lease['page_index'], page.lease['input'])}
        if page.lease['action'] == 'doc_render':
            value['analysis'] = workspace.analysis(page.lease['page_index'], page.lease['analysis_ref'])
        page.check()
        return value

    def analyze(self, page):
        rgb, alpha = self.agent.runtime.decode(page.data, {**page.lease['input'], 'normalization_version': 1})
        try:
            return self.agent.runtime.analyze(rgb, page.lease['input']['sha256'])
        finally:
            if alpha is not None:
                alpha.close()

    def inpaint(self, page):
        page.rgb, page.alpha = self.agent.runtime.decode(page.data, {**page.lease['input'], 'normalization_version': 1})
        page.data = None
        self.agent.runtime.restore_masks(page.analysis, (page.lease['input']['width'], page.lease['input']['height']), page.masks)
        return self.agent.runtime.inpaint(page.rgb, page.analysis, masks=page.masks)

    def persist(self, page):
        workspace = self.workspace(page)
        index = page.lease['page_index']
        if page.lease['action'] == 'doc_ocr':
            analysis_ref = workspace.save_analysis(index, page.analysis)
            body = {'analysis_ref': analysis_ref,
                    'text': {'page_index': index, 'analysis_hash': analysis_ref['sha256'], 'segments': page.analysis['segments']},
                    'no_text': not page.analysis['segments'], 'quality_flags': page.analysis.get('quality_flags', [])}
        else:
            body = {'output_ref': workspace.save_output(index, page.rendered['output_bytes'], page.rendered['result']['output']),
                    'quality_flags': page.analysis.get('quality_flags', [])}
        workspace.save_checkpoint(index, page.lease['action'], body)
        return body

    def package(self, page):
        path, ref = self.workspace(page).package(page.lease['pages'], check=page.check)
        page.document_package = (path, ref)
        return {'output_ref': {**ref, 'key': page.lease['output_key']}}

    def freeze(self, page, body):
        page.completion = {**body, **self.identity(page)}
        saved = self.agent.journal.get(PREFIX + page.lease['lease_id'], {})
        self.agent.journal.freeze(PREFIX + page.lease['lease_id'],
            {**saved, 'completion': page.completion, 'timings': safe_timings(page.timings)}, None)
        self.agent.pipeline.release_render_buffers(page)
        self.agent.pipeline.retain_masks(page)
        page.data = page.rgb = page.cleaned = page.analysis = page.translations = None
        page.rendered = None
        if page.alpha is not None:
            page.alpha.close()
            page.alpha = None
        self.agent.pipeline.resize_reservation(page, MAX_CHECKPOINT_BYTES * 2)
        page.step = 'deliver'

    def deliver(self, page):
        key, body = page.lease['lease_id'], page.completion
        saved = self.agent.journal.get(PREFIX + key, {})
        if page.lease['action'] == 'doc_zip' and body.get('output_ref') and not saved.get('uploaded'):
            packed = getattr(page, 'document_package', None)
            path, ref = packed if packed is not None else self.workspace(page).package(page.lease['pages'], check=page.check)
            if {**ref, 'key': page.lease['output_key']} != body['output_ref']:
                raise NodeFailure('DOCUMENT_OUTPUT_MISMATCH')
            attempts, refreshed_forbidden = 0, False
            def put_output():
                nonlocal attempts, refreshed_forbidden
                if attempts:
                    page.timings['upload_retries'] = page.timings.get('upload_retries', 0) + 1
                attempts += 1
                reply = self.measured(page, 'upload_sign', lambda: self.post(
                    f'/leases/{key}/uploads', {**self.identity(page), 'output_ref': body['output_ref']}))
                if reply.get('receipt'):
                    return reply['receipt']
                try:
                    self.measured(page, 'upload_put', lambda: self.objects.upload_file(
                        body['output_ref'], reply['uploads']['output'], path, page.check))
                except ControlFailure as error:
                    if error.code == 'DOCUMENT_TRANSFER_FAILED' and error.status == 403 and not refreshed_forbidden:
                        refreshed_forbidden = True
                        raise ControlFailure('DOCUMENT_TRANSFER_FAILED') from None
                    raise
            terminal = self.agent.retry(page, put_output)
            if terminal:
                return terminal
            self.agent.journal.put(PREFIX + key, {**saved, 'uploaded': True})
            self.log_timings(page, 'uploaded')
        attempts = 0
        def complete():
            nonlocal attempts
            if attempts:
                page.timings['complete_retries'] = page.timings.get('complete_retries', 0) + 1
            attempts += 1
            return self.measured(page, 'complete', lambda: self.post(f'/leases/{key}/complete', body))
        result = self.agent.retry(page, complete)
        if result.get('status') != 'terminal':
            raise ControlFailure('CONTROL_INVALID_RESPONSE')
        return result

    def fail(self, page, error):
        if isinstance(error, NodeFailure) and error.code == 'LEASE_STOPPED':
            page.stopped = True
            return
        candidate = getattr(error, 'code', '')
        code = candidate if isinstance(candidate, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,59}', candidate) else {
            'analyze': 'CLASSIC_ANALYZE_FAILED', 'inpaint': 'CLASSIC_INPAINT_FAILED',
            'render': 'CLASSIC_RENDER_FAILED', 'prepare': 'DOCUMENT_INVALID_FILE',
            'package': 'DOCUMENT_PACKAGE_FAILED',
        }.get(page.step, 'CLASSIC_LOCAL_INTERRUPTED')
        report_page_failure(page.lease['lease_id'], page.step, code, error)
        if page.completion and isinstance(error, ControlFailure) and (not error.status or error.status >= 500 or error.status == 429):
            page.step = 'deliver'
            return
        self.freeze(page, {'error': code})

    def advance(self, page):
        if page.future and page.future.done():
            future, page.future = page.future, None
            completed_step = page.step
            self.agent.pipeline.release_render_buffers(page)
            try:
                value = future.result()
                if page.step in ('prepare', 'package', 'persist'):
                    self.freeze(page, value)
                elif page.step == 'download':
                    if 'completion' in value:
                        self.freeze(page, value['completion'])
                    else:
                        page.data = value['input']
                        if page.lease['action'] == 'doc_ocr':
                            page.step = 'analyze'
                        else:
                            page.analysis, page.translations = value['analysis'], page.lease['translations']
                            if page.analysis.get('input_hash') != page.lease['input']['sha256']:
                                raise NodeFailure('INPUT_HASH_MISMATCH')
                            page.step = 'inpaint'
                elif page.step == 'analyze':
                    page.analysis, page.step = value, 'persist'
                elif page.step == 'inpaint':
                    page.cleaned = value
                    self.agent.pipeline.retain_masks(page, *('bubble_inset', 'bubble_labels', 'bubble_stats')
                        if 'bubble_inset' in page.masks else ('bubble_mask',))
                    page.step = 'render'
                elif page.step == 'render':
                    page.rendered, page.step = value, 'persist'
                elif page.step == 'deliver':
                    page.terminal = value
            except Exception as error:
                self.fail(page, error)
            if completed_step == 'deliver' and page.completion and not page.terminal:
                saved = self.agent.journal.get(PREFIX + page.lease['lease_id'], {})
                self.agent.journal.put(PREFIX + page.lease['lease_id'], {**saved, 'timings': safe_timings(page.timings)})
            self.log_timings(page, completed_step)
            page.ready_at = time.monotonic()
        if not page.future:
            page.phase = page.step

    def tick(self):
        pipeline = self.agent.pipeline
        for key, page in list(self.pages.items()):
            self.advance(page)
            if page.future:
                continue
            try:
                page.check()
            except NodeFailure:
                pass
            if page.terminal:
                pipeline.release(page)
                self.agent.journal.remove(PREFIX + key)
                del self.pages[key]
                self.next_claim = 0
                self.agent.request_claim()
                continue
            if page.stopped:
                pipeline.release(page)
                busy = sum(bool(p.future and p.step in ('persist', 'deliver')) for p in self.agent.active_pages())
                if time.monotonic() >= page.next_stop and busy < self.agent.local.get('delivery_workers', 4):
                    page.next_stop = time.monotonic() + 1
                    page.step = 'deliver'
                    page.future = pipeline.delivery.submit(self.post, f'/leases/{key}/complete',
                        {**self.identity(page), 'error': 'LEASE_STOPPED'})
                    page.future.add_done_callback(lambda _: self.agent.wake.set())
                continue
            if page.step in ('download', 'prepare', 'package'):
                reserve = pipeline.input_reservation(page) if page.step == 'download' else MAX_CHECKPOINT_BYTES * 2
                if reserve > pipeline.limit:
                    self.fail(page, NodeFailure('INPUT_MEMORY_EXCEEDED'))
                    continue
                if not pipeline.resize_reservation(page, reserve, bounded=True):
                    continue
                if page.step == 'download':
                    page.mask_reserved = page.lease['input']['width'] * page.lease['input']['height'] * 6
                if sum(bool(p.future and p.step in ('download', 'prepare', 'package')) for p in self.agent.active_pages()) >= self.agent.local.get('download_workers', 4):
                    continue
                pipeline.submit(page, pipeline.download, page.step, lambda p=page: getattr(self, p.step)(p))
            elif page.step in ('analyze', 'inpaint', 'render'):
                stages = {'render'} if page.step == 'render' else {'analyze', 'inpaint'}
                capacity = pipeline.render_workers if page.step == 'render' else self.agent.local['local_pages']
                if sum(bool(p.future and p.step in stages) for p in self.agent.active_pages()) >= capacity:
                    continue
                if page.step == 'analyze':
                    operation = lambda p=page: self.analyze(p)
                elif page.step == 'inpaint':
                    operation = lambda p=page: self.inpaint(p)
                else:
                    ipc, cache = pipeline.reserve_render_batch([page])[page]
                    operation = lambda p=page, cache=cache, ipc=ipc: self.agent.runtime.render(
                        p.rgb, p.cleaned, p.analysis, p.translations, p.lease['language'], p.alpha,
                        use_render_pool=bool(ipc), mask_cache_bytes=cache, check_cancelled=p.check, masks=p.masks,
                        full_image_max_bytes=self.workspace(p).limits.max_page_bytes)
                pipeline.submit(page, pipeline.render if page.step == 'render' else pipeline.compute, page.step, operation)
            elif page.step in ('persist', 'deliver'):
                if sum(bool(p.future and p.step in ('persist', 'deliver')) for p in self.agent.active_pages()) < self.agent.local.get('delivery_workers', 4):
                    pipeline.submit(page, pipeline.delivery, page.step, lambda p=page: getattr(self, p.step)(p))

    def close_control(self):
        self.control.shutdown(wait=True)

    def close(self):
        for page in self.pages.values():
            self.agent.pipeline.release(page)
        self.pages.clear()
        self.objects.close()
