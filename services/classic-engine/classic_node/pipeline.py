"""Bounded page state, with computation independent of network and text waits."""
from concurrent.futures import ThreadPoolExecutor
import time

from .protocol import MAX_CHECKPOINT_BYTES, MAX_IMAGE_BYTES, MAX_PIXELS, NodeFailure, digest


class Pipeline:
    def __init__(self, agent):
        self.agent = agent
        cfg = agent.local
        self.compute = ThreadPoolExecutor(cfg['local_pages'], thread_name_prefix='compute')
        self.download = ThreadPoolExecutor(cfg.get('download_workers', 4), thread_name_prefix='download')
        self.control = ThreadPoolExecutor(cfg.get('download_workers', 4), thread_name_prefix='analysis')
        self.delivery = ThreadPoolExecutor(cfg.get('delivery_workers', 4), thread_name_prefix='delivery')
        self.limit = cfg.get('resident_bytes', 1024 * 1024 * 1024)
        self.used = 0
        self.turn = False

    def close(self):
        for pool in (self.download, self.compute, self.control, self.delivery):
            pool.shutdown(wait=True)

    def submit(self, page, pool, name, operation):
        page.phase = name

        def run():
            page.check()
            start = time.monotonic()
            page.timings[name + '_queue'] = start - page.ready_at
            try:
                return operation()
            finally:
                page.timings[name] = time.monotonic() - start

        page.future = pool.submit(run)
        page.future.add_done_callback(lambda _: self.agent.wake.set())

    def prepare(self, page):
        rgb, alpha = self.agent.runtime.decode(page.data, page.metadata)
        page.data = None
        analysis = page.analysis or self.agent.runtime.analyze(rgb, page.metadata['sha256'])
        if analysis['input_hash'] != page.metadata['sha256'] or analysis['version'] != self.agent.runtime.version:
            raise NodeFailure('ENGINE_VERSION_MISMATCH')
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
        body = {'lease_token': page.lease['lease_token'], **result,
                'timings': {**page.timings, 'local_total': time.monotonic() - page.received_at}}
        saved = self.agent.journal.get('lease:' + key)
        saved.pop('analysis', None)
        self.agent.journal.put('lease:' + key, {**saved, 'completion': body})
        page.completion = body
        page.rgb = page.cleaned = page.analysis = page.alpha = None
        page.step = 'deliver'

    def release(self, page):
        self.used -= page.reserved
        page.reserved = 0
        page.data = page.rgb = page.cleaned = page.analysis = page.alpha = page.completion = None

    def error(self, page, error):
        if page.terminal or page.stopped:
            return
        if isinstance(error, NodeFailure) and error.code == 'LEASE_STOPPED':
            page.stopped = True
            return
        code = error.code if isinstance(error, NodeFailure) and error.code in {
            'ENGINE_VERSION_MISMATCH', 'INPUT_INVALID', 'INPUT_HASH_MISMATCH', 'STORAGE_AUTH_FAILED',
            'STORAGE_UNAVAILABLE', 'CLASSIC_ANALYZE_FAILED', 'CLASSIC_INPAINT_FAILED', 'CLASSIC_RENDER_FAILED'
        } else 'CLASSIC_LOCAL_INTERRUPTED'
        saved = self.agent.journal.get('lease:' + page.lease['lease_id'], {})
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
            try:
                value = future.result()
                if page.step == 'download':
                    page.data, page.metadata = value
                    page.step = 'analyze'
                elif page.step == 'analyze':
                    page.rgb, page.alpha, page.analysis = value
                    page.analysis_future = self.control.submit(self.accepted, page)
                    page.analysis_future.add_done_callback(lambda _: self.agent.wake.set())
                    page.step = 'inpaint' if page.analysis['segments'] else 'text'
                elif page.step == 'inpaint':
                    page.cleaned = value
                    page.rgb = None
                    page.step = 'text'
                elif page.step == 'render':
                    self.freeze(page, value)
                elif page.step == 'deliver':
                    page.terminal = value
            except Exception as error:
                page.pending_error = error
            page.ready_at = time.monotonic()
        if not page.future and not page.analysis_future and page.pending_error:
            error, page.pending_error = page.pending_error, None
            self.error(page, error)
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
                metadata = page.lease.get('input') or {}
                pixels = metadata.get('width', 0) * metadata.get('height', 0) or MAX_PIXELS
                # Working RGB/masks plus encoded result copies; model workspace is separate.
                reserve = pixels * 16 + MAX_IMAGE_BYTES * 3 + MAX_CHECKPOINT_BYTES * 6
                if reserve > self.limit:
                    self.error(page, NodeFailure('INPUT_INVALID'))
                    continue
                if self.used + reserve > self.limit:
                    continue
                page.reserved = reserve
                self.used += reserve
                self.submit(page, self.download, 'download', lambda p=page: self.agent.input_bytes(p))
            elif page.step == 'deliver':
                self.submit(page, self.delivery, 'deliver', lambda p=page: self.agent.deliver(p, p.completion))
        running = sum(bool(p.future and p.step in {'analyze', 'inpaint', 'render'}) for p in pages)
        ready = [p for p in pages if not p.future and not p.pending_error and not p.stopped and not p.terminal
                 and p.step in {'analyze', 'inpaint', 'render'}]
        # Alternate completion and preparation, preserving FIFO within each class.
        while ready and running < self.agent.local['local_pages']:
            prefer_render = not self.turn
            page = next((p for p in ready if (p.step == 'render') == prefer_render), ready[0])
            ready.remove(page)
            self.turn = not self.turn
            if page.step == 'analyze':
                operation = lambda p=page: self.prepare(p)
            elif page.step == 'inpaint':
                operation = lambda p=page: self.agent.runtime.inpaint(p.rgb, p.analysis)
            else:
                operation = lambda p=page: self.agent.runtime.render(p.cleaned, p.analysis, p.translations, p.lease['language'], p.alpha)
            self.submit(page, self.compute, page.step, operation)
            running += 1
