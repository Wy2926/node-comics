"""Two private LaMa crop workers beneath one physical-device stage lease.

Each worker uses original weights/preprocessing/FourierUnit. Only independent
crop scheduling changes; output ownership follows local_inpainting.plan_regions.
"""
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
import multiprocessing
import os

import numpy as np
from local_inpainting import plan_regions

_model = _runtime = None


def _initialize(threads, ready):
    global _model, _runtime
    import asyncio
    import logging
    import torch
    from manga_translator.utils import ModelWrapper
    from manga_translator.config import InpainterConfig
    from manga_translator.inpainting.inpainting_lama_mpe import LamaLargeInpainter
    from mit_directml import DirectMLRuntime
    logging.disable(logging.CRITICAL)
    torch.set_num_threads(threads)
    ModelWrapper._MODEL_DIR = os.environ['MODEL_DIR']
    os.environ['ENGINE_DIRECTML_OPTIMIZED'] = '0'  # This process loads LaMa only.
    os.environ.pop('ENGINE_PROFILE_DIR', None)
    _model = LamaLargeInpainter()
    _runtime = DirectMLRuntime(os.environ['ENGINE_DEVICE'])

    async def warm():
        await _runtime.load({'inpainter': _model})
        image = np.full((256, 256, 3), 255, np.uint8)
        mask = np.zeros((256, 256), np.uint8); mask[120:128, 120:128] = 255
        await _model.inpaint(image, mask, InpainterConfig(inpainting_precision='fp32'), 256, False)
    asyncio.run(warm())
    ready.put(_evidence())


def _evidence():
    value = _runtime.evidence()
    return {'pid': os.getpid(), 'adapter': value['adapter'], 'fourier_units_on_cpu': value['fourier_units_on_cpu'],
            'executed': value['executed']}


def _ping():
    return os.getpid()


def _predict(image, mask, size, threads, opencv_threads):
    import asyncio
    import torch
    import cv2
    import cv2
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(int(os.environ.get('ENGINE_TORCH_INTEROP_THREADS', '1')))
    cv2.setNumThreads(int(os.environ.get('ENGINE_OPENCV_THREADS', '2')))
    cv2.setNumThreads(opencv_threads)
    from manga_translator.config import InpainterConfig
    output = asyncio.run(_model.inpaint(image, mask, InpainterConfig(inpainting_precision='fp32'), size, False))
    return output, _evidence()


class ParallelLama:
    def __init__(self, workers=2, threads=4):
        if workers != 2:
            raise ValueError('The measured DirectML crop pool uses two workers')
        self.workers = workers
        self.threads, self.broken = threads, False
        self.opencv_threads = int(os.environ.get('ENGINE_OPENCV_THREADS', '2'))
        context = multiprocessing.get_context('spawn')
        self.ready = context.Queue()
        self.executor = ProcessPoolExecutor(max_workers=workers, mp_context=context,
                                            initializer=_initialize, initargs=(threads, self.ready))
        self.records = {}

    def warm(self):
        futures = [self.executor.submit(_ping) for _ in range(self.workers)]
        for _ in range(self.workers):
            record = self.ready.get(timeout=120)
            self.records[record['pid']] = record
        for future in futures:
            future.result()

    def inpaint(self, image, mask, *, max_size, padding, merge_gap):
        if self.broken:
            # The failed stage is retried by the controller, never inside this
            # call. Recreate the private workers on the next admitted stage.
            self.close()
            opencv_threads = self.opencv_threads
            self.__init__(self.workers, self.threads)
            self.opencv_threads = opencv_threads
            try:
                self.warm()
            except Exception:
                self.broken = True
                raise
        if image.ndim != 3 or image.shape[2] != 3 or image.dtype != np.uint8 or image.shape[:2] != mask.shape:
            raise ValueError('Invalid inpainting image')
        output = image.copy()
        plans = iter(plan_regions(mask, max_size, padding, merge_gap))
        pending = deque()

        def submit():
            plan = next(plans, None)
            if plan is None:
                return
            core, crop = plan
            x0, y0, x1, y1 = crop
            future = self.executor.submit(_predict, image[y0:y1, x0:x1].copy(), mask[y0:y1, x0:x1].copy(),
                                          max_size, self.threads, self.opencv_threads)
            pending.append((core, crop, future))

        try:
            for _ in range(self.workers):
                submit()
            while pending:
                core, crop, future = pending.popleft()
                predicted, record = future.result()
                self.records[record['pid']] = record
                x0, y0, x1, y1 = crop
                if predicted.shape != (y1-y0, x1-x0, 3) or predicted.dtype != np.uint8:
                    raise ValueError('Invalid inpainting crop result')
                cx0, cy0, cx1, cy1 = core
                owned = mask[cy0:cy1, cx0:cx1] > 0
                output[cy0:cy1, cx0:cx1][owned] = predicted[cy0-y0:cy1-y0, cx0-x0:cx1-x0][owned]
                submit()
        except BrokenProcessPool:
            self.broken = True
            raise
        finally:
            # Failed/cancelled pages must not leave GPU work executing after the
            # parent releases its physical-device lock or receives a new lease.
            for _, _, future in pending:
                try:
                    future.result()
                except Exception:
                    pass
        return output

    def evidence(self):
        return list(self.records.values())

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)
        self.ready.close()
        self.ready.join_thread()
