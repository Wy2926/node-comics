"""Bounded page state, with computation independent of network and text waits."""
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
import re
import time

from .protocol import MAX_CHECKPOINT_BYTES, ControlFailure, NodeFailure, digest
from .operations import report_page_failure
from .timing import collect, measured


class Pipeline:
    def __init__(self, agent):
        self.agent = agent
        cfg = agent.local
        self.compute = ThreadPoolExecutor(cfg['local_pages'], thread_name_prefix='compute')
        self.render_workers = cfg.get('render_workers', 1)
        self.render = ThreadPoolExecutor(self.render_workers, thread_name_prefix='render')
        self.download = ThreadPoolExecutor(cfg.get('download_workers', 4), thread_name_prefix='download')
        self.control = ThreadPoolExecutor(cfg.get('download_workers', 4), thread_name_prefix='analysis')
        self.delivery = ThreadPoolExecutor(cfg.get('delivery_workers', 4), thread_name_prefix='delivery')
        self.limit = cfg.get('resident_bytes', 1024 * 1024 * 1024)
        self.used = 0
        self.memory_lock = Lock()

    @staticmethod
    def input_reservation(page):
        metadata = page.lease.get('input') or {}
        pixels = metadata.get('width', 0) * metadata.get('height', 0)
        # Existing working/output allowance plus three cached uint8 masks.
        return pixels * 19 + metadata.get('byte_size', 0) * 3 + MAX_CHECKPOINT_BYTES * 6

    @staticmethod
    def delivery_reservation(body):
        # Binary journal readback and multipart transport; no base64 copies.
        output = body.get('result', {}).get('output')
        return (output['byte_size'] * 2 if output else 0) + MAX_CHECKPOINT_BYTES * 6

    def resize_reservation(self, page, amount, *, bounded=False):
        with self.memory_lock:
            previous = page.reserved
            if bounded and self.used + amount - previous > self.limit:
                return False
            self.used += amount - previous
            page.reserved = amount
        if amount < previous:
            self.agent.request_claim()
        return True

    def release_render_buffers(self, page):
        with self.memory_lock:
            amount = page.render_reserved
            if not amount:
                return
            page.render_reserved = 0
            page.reserved -= amount
            self.used -= amount
        self.agent.request_claim()

    def retain_masks(self, page, *names):
        # Only the drained page owner may discard masks; in-flight stages read
        # this same dictionary. The initial three-mask allowance shrinks to the
        # actual arrays after analysis, then to bubble_mask after inpainting.
        for name in tuple(page.masks):
            if name not in names:
                del page.masks[name]
        amount = sum(mask.nbytes for mask in page.masks.values())
        with self.memory_lock:
            released = page.mask_reserved - amount
            page.mask_reserved = amount
            page.reserved -= released
            self.used -= released
        if released > 0:
            self.agent.request_claim()

    def reserve_render_batch(self, pages):
        reservations = {}
        with self.memory_lock:
            available = max(0, self.limit - self.used)
            # Preserve useful per-page mask reuse before admitting more IPC.
            # A full budget still permits uncached local rendering to progress.
            for page in pages:
                metadata = page.lease['input']
                texts = (page.translations or {}).get('translations', {}).values()
                blocks = sum(isinstance(text, str) and bool(text.strip()) for text in texts)
                needed = self.agent.runtime.render_ipc_bytes(metadata['width'], metadata['height']) if blocks else 0
                ipc = needed if 0 < needed <= available else 0
                available -= ipc
                cache = 0
                if page.analysis.get('bubble_mask'):
                    cache = min(metadata['width'] * metadata['height'] * blocks, available)
                available -= cache
                extra = ipc + cache
                self.used += extra
                page.reserved += extra
                page.render_reserved = extra
                reservations[page] = (ipc, cache)
        return reservations

    def claim_capacity(self):
        pages = list(self.agent.pages.values())
        downloading = [page for page in pages if page.step == 'download' and not page.stopped and not page.terminal]
        # Count accepted pages before they acquire buffers, too. Their known
        # demand must not disappear merely because they await the memory gate.
        with self.memory_lock:
            pending_bytes = sum(self.input_reservation(page) for page in downloading if not page.reserved)
            available = max(0, self.limit - self.used - pending_bytes)
        minimum = MAX_CHECKPOINT_BYTES * 6
        return max(0, min(4, self.agent.local.get('download_workers', 4) - len(downloading), available // minimum))

    def close(self):
        for pool in (self.download, self.compute, self.render, self.control, self.delivery):
            pool.shutdown(wait=True)
        for page in list(self.agent.pages.values()):
            self.release_render_buffers(page)
            self.retain_masks(page)

    def submit(self, page, pool, name, operation):
        page.phase = name

        def run():
            page.check()
            start = time.monotonic()
            page.timings[name + '_queue'] = start - page.ready_at
            with collect() as details:
                try:
                    return operation()
                finally:
                    page.timings.update(details)
                    page.timings[name] = time.monotonic() - start

        page.future = pool.submit(run)
        page.future.add_done_callback(lambda _: self.agent.wake.set())

    def prepare(self, page):
        with measured('analyze_decode'):
            rgb, alpha = self.agent.runtime.decode(page.data, page.metadata)
        page.data = None
        analysis = page.analysis or self.agent.runtime.analyze(rgb, page.metadata['sha256'], masks=page.masks)
        if analysis['input_hash'] != page.metadata['sha256']:
            raise NodeFailure('INPUT_HASH_MISMATCH')
        if page.analysis:
            # Restore and validate each encoded mask once before text work can resume.
            self.agent.runtime.restore_masks(analysis, (page.metadata['width'], page.metadata['height']), page.masks)
        return rgb, alpha, analysis

    def accepted(self, page):
        started = time.monotonic()
        key = page.lease['lease_id']
        saved = self.agent.journal.get('lease:' + key)
        self.agent.journal.put('lease:' + key, {**saved, 'analysis': page.analysis})
        reply = self.agent.retry(page, lambda: self.agent.transport.post(f'/leases/{key}/analysis',
            {'lease_token': page.lease['lease_token'], 'analysis': page.analysis, 'analysis_hash': digest(page.analysis)}))
        page.timings['analysis_submit'] = time.monotonic() - started
        return reply

    def freeze(self, page, result):
        key = page.lease['lease_id']
        # Timings are transport metadata, outside the immutable image identity.
        body = {'lease_token': page.lease['lease_token'], 'result': result['result'],
                'timings': {**page.timings, 'local_total': time.monotonic() - page.received_at}}
        saved = self.agent.journal.get('lease:' + key)
        saved.pop('analysis', None)
        self.agent.journal.freeze('lease:' + key, {**saved, 'completion': body}, result['output_bytes'])
        page.completion = body
        page.rgb = page.cleaned = page.analysis = page.alpha = None
        self.retain_masks(page)
        self.resize_reservation(page, self.delivery_reservation(body))
        page.step = 'deliver'

    def release(self, page):
        self.release_render_buffers(page)
        self.retain_masks(page)
        self.resize_reservation(page, 0)
        page.data = page.rgb = page.cleaned = page.analysis = page.alpha = page.completion = None

    def error(self, page, error):
        if not page.future and not page.analysis_future:
            self.retain_masks(page)
        if page.terminal or page.stopped:
            return
        if isinstance(error, NodeFailure) and error.code == 'LEASE_STOPPED':
            page.stopped = True
            return
        code = error.code if isinstance(error, NodeFailure) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,59}', error.code) else {
            'analyze': 'CLASSIC_ANALYZE_FAILED', 'inpaint': 'CLASSIC_INPAINT_FAILED',
            'render': 'CLASSIC_RENDER_FAILED',
        }.get(page.step, 'CLASSIC_LOCAL_INTERRUPTED')
        report_page_failure(page.lease['lease_id'], page.step, code, error)
        saved = self.agent.journal.get('lease:' + page.lease['lease_id'], {})
        # A definitive payload rejection cannot be repaired by uploading the
        # same frozen bytes again. Preserve ambiguous/network failures, but
        # replace rejected output atomically with a small terminal report.
        if (page.step == 'deliver' and isinstance(error, ControlFailure)
                and error.status in {400, 413, 415, 422}
                and 'result' in (saved.get('completion') or {})):
            page.completion = {'lease_token': page.lease['lease_token'], 'error': {'code': 'RESULT_REJECTED'}}
            self.agent.journal.freeze('lease:' + page.lease['lease_id'], {**saved, 'completion': page.completion}, None)
            self.resize_reservation(page, self.delivery_reservation(page.completion))
            return
        page.completion = saved.get('completion') or {'lease_token': page.lease['lease_token'], 'error': {'code': code}}
        self.agent.journal.put('lease:' + page.lease['lease_id'], {**saved, 'completion': page.completion})
        page.step = 'deliver'

    def advance(self, page):
        if page.analysis_future and page.analysis_future.done():
            future, page.analysis_future = page.analysis_future, None
            try:
                reply = future.result()
                if reply['receipt']:
                    page.terminal = reply['receipt']
                page.analysis_accepted = True
            except Exception as error:
                # Drain compute before discarding its buffers or reporting failure.
                page.pending_error = error
        if page.future and page.future.done():
            future, page.future = page.future, None
            # The renderer has drained and discarded its cache and IPC buffers,
            # even when result() will raise. Keep the page's working buffers.
            self.release_render_buffers(page)
            try:
                value = future.result()
                if page.step == 'download':
                    page.data, page.metadata = value
                    page.step = 'analyze'
                    self.agent.request_claim()
                elif page.step == 'analyze':
                    page.rgb, page.alpha, page.analysis = value
                    self.retain_masks(page, 'mask', 'raw_mask', 'bubble_mask')
                    page.analysis_future = self.control.submit(self.accepted, page)
                    page.analysis_future.add_done_callback(lambda _: self.agent.wake.set())
                    page.step = 'inpaint' if page.analysis['segments'] else 'text'
                elif page.step == 'inpaint':
                    page.cleaned = value
                    self.retain_masks(page, 'bubble_mask')
                    page.step = 'text'
                elif page.step == 'render':
                    self.freeze(page, value)
                elif page.step == 'deliver':
                    page.terminal = value
            except Exception as error:
                page.pending_error = error
            page.ready_at = time.monotonic()
        if not page.future and not page.analysis_future:
            if page.pending_error:
                error, page.pending_error = page.pending_error, None
                self.error(page, error)
            if page.stopped or page.terminal:
                self.retain_masks(page)
        if page.step == 'text' and not page.future and page.analysis_accepted and page.translations and page.cleaned is not None:
            page.timings['text_wait'] = time.monotonic() - page.ready_at
            page.step, page.ready_at = 'render', time.monotonic()
        if not page.future:
            page.phase = page.step

    def tick(self):
        pages = list(self.agent.pages.values())
        for page in pages:
            self.advance(page)
            if page.future or page.analysis_future or page.terminal or page.stopped:
                continue
            if page.step == 'download' and not page.reserved:
                # Working RGB/masks plus encoded result copies; model workspace is separate.
                reserve = self.input_reservation(page)
                if reserve > self.limit:
                    self.error(page, NodeFailure('INPUT_MEMORY_EXCEEDED'))
                    continue
                if not self.resize_reservation(page, reserve, bounded=True):
                    continue
                page.mask_reserved = page.lease['input']['width'] * page.lease['input']['height'] * 3
                self.submit(page, self.download, 'download', lambda p=page: self.agent.input_bytes(p))
            elif page.step == 'deliver':
                self.submit(page, self.delivery, 'deliver', lambda p=page: self.agent.deliver(p, p.completion))
        # Submit only available slots, not an unbounded executor backlog. A page
        # owns its buffers until its future drains; waits retain the same lease
        # and resident-byte reservation. No lock spans either execution pool.
        # Advance prepared pages before admitting more analysis work, so a batch
        # of downloads cannot postpone the first result until all are analyzed.
        for stages, pool, capacity in (({'analyze', 'inpaint'}, self.compute, self.agent.local['local_pages']),
                                       ({'render'}, self.render, self.render_workers)):
            running = sum(bool(p.future and p.step in stages) for p in pages)
            ready = sorted((p for p in pages if not p.future and not p.pending_error
                            and not p.stopped and not p.terminal and p.step in stages),
                           key=lambda p: (p.step == 'analyze', p.ready_at))
            ready = ready[:max(0, capacity - running)]
            reservations = self.reserve_render_batch(ready) if stages == {'render'} else {}
            for page in ready:
                if page.step == 'analyze':
                    operation = lambda p=page: self.prepare(p)
                elif page.step == 'inpaint':
                    operation = lambda p=page: self.agent.runtime.inpaint(p.rgb, p.analysis, masks=p.masks)
                else:
                    ipc, cache_bytes = reservations[page]
                    operation = lambda p=page, budget=cache_bytes, pooled=bool(ipc): self.agent.runtime.render(p.rgb, p.cleaned, p.analysis, p.translations, p.lease['language'], p.alpha,
                        mask_cache_bytes=budget, use_render_pool=pooled, check_cancelled=p.check, masks=p.masks,
                        **({'allow_tiles': True} if p.lease['config'].get('result_format') == 'overlay-tiles-v1' else {}))
                self.submit(page, pool, page.step, operation)
