"""Bounded CPU/device overlap. Worker cancellation always drains before unlock."""
import asyncio
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from contextlib import asynccontextmanager
import functools
import inspect
import multiprocessing
import sys
import threading
import time


async def drain(future):
    """Do not abandon native work when the HTTP task is cancelled (even twice)."""
    future = asyncio.ensure_future(future)
    cancelled = False
    while not future.done():
        try:
            await asyncio.shield(future)
        except asyncio.CancelledError:
            cancelled = True
        except BaseException:
            break
    if cancelled:
        if not future.cancelled():
            future.exception()  # Consume a worker failure before propagating cancellation.
        raise asyncio.CancelledError
    return future.result()


class Admission:
    """Bound decoded images/queued worker jobs; configuration has writer priority."""
    def __init__(self, capacity=3):
        self.capacity, self.active, self.writers = capacity, 0, 0
        self.condition = asyncio.Condition()
        self.updating = False

    @asynccontextmanager
    async def enter(self):
        async with self.condition:
            await self.condition.wait_for(lambda: not self.writers and not self.updating
                                          and self.active < self.capacity)
            self.active += 1
        try:
            yield
        finally:
            async with self.condition:
                self.active -= 1
                self.condition.notify_all()

    @asynccontextmanager
    async def exclusive(self):
        async with self.condition:
            self.writers += 1
            try:
                await self.condition.wait_for(lambda: not self.active and not self.updating)
                self.updating = True
            finally:
                self.writers -= 1
                self.condition.notify_all()
        try:
            yield
        finally:
            async with self.condition:
                self.updating = False
                self.condition.notify_all()


_quiet = threading.local()


class WorkerOutput:
    """Suppress upstream page text only on our workers, without redirect races."""
    def __init__(self, original):
        self.original = original

    def write(self, value):
        return len(value) if getattr(_quiet, 'active', False) else self.original.write(value)

    def flush(self):
        if not getattr(_quiet, 'active', False):
            self.original.flush()

    def __getattr__(self, key):
        return getattr(self.original, key)


def invoke(function, args, kwargs):
    _quiet.active = True
    try:
        value = function(*args, **kwargs)
        return asyncio.run(value) if inspect.isawaitable(value) else value
    finally:
        _quiet.active = False


class Pipeline:
    def __init__(self, device_initializer=None):
        self.admission = Admission()
        self.cpu_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='image-cpu')
        self.device_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='image-device',
                                                  initializer=device_initializer)
        # Qt is created and used on the child process's main thread, never a pool thread.
        self.layout_executor = ProcessPoolExecutor(max_workers=1,
            mp_context=multiprocessing.get_context('spawn'))
        self.layout_gate = asyncio.Lock()
        self.layout_broken = False
        self.layout_configuration = None
        self.stdout, self.stderr = WorkerOutput(sys.stdout), WorkerOutput(sys.stderr)
        sys.stdout, sys.stderr = self.stdout, self.stderr

    async def run(self, executor, function, *args, **kwargs):
        future = asyncio.get_running_loop().run_in_executor(executor,
            functools.partial(invoke, function, args, kwargs))
        if executor is self.layout_executor:
            def completed(value):
                # Cancellation may take precedence over a concurrent process
                # crash in drain(); still recover on the very next page.
                if not value.cancelled() and isinstance(value.exception(), BrokenProcessPool):
                    self.layout_broken = True
            future.add_done_callback(completed)
        return await drain(future)

    async def cpu(self, function, *args, **kwargs):
        return await self.run(self.cpu_executor, function, *args, **kwargs)

    async def configure_layout(self, directory, languages, threads):
        from render_stage import configure
        values = (str(directory), list(languages), threads)
        result = await self.layout(configure, *values)
        self.layout_configuration = values
        return result

    async def layout(self, function, *args, **kwargs):
        async with self.layout_gate:
            try:
                if self.layout_broken:
                    # Fail the crashed page; recreate only for the next request.
                    await self.cpu(self.layout_executor.shutdown, wait=True, cancel_futures=True)
                    self.layout_executor = ProcessPoolExecutor(max_workers=1,
                        mp_context=multiprocessing.get_context('spawn'))
                    if self.layout_configuration:
                        from render_stage import configure
                        await self.run(self.layout_executor, configure, *self.layout_configuration)
                    self.layout_broken = False
                return await self.run(self.layout_executor, function, *args, **kwargs)
            except BrokenProcessPool:
                self.layout_broken = True
                raise

    def close(self):
        for executor in (self.device_executor, self.cpu_executor, self.layout_executor):
            executor.shutdown(wait=True, cancel_futures=True)
        if sys.stdout is self.stdout:
            sys.stdout = self.stdout.original
        if sys.stderr is self.stderr:
            sys.stderr = self.stderr.original


class Execution:
    def __init__(self, pipeline, lock, synchronize=None):
        self.pipeline, self.lock, self.synchronize = pipeline, lock, synchronize
        self.timings = {}

    def add(self, label, seconds):
        self.timings[label] = self.timings.get(label, 0) + seconds

    async def cpu(self, function, *args, **kwargs):
        start = time.monotonic()
        try:
            return await self.pipeline.cpu(function, *args, **kwargs)
        finally:
            self.add('cpu_wall', time.monotonic() - start)

    async def device(self, function, *args, **kwargs):
        waiting = time.monotonic()
        async with self.lock.hold():
            self.add('device_wait', time.monotonic() - waiting)
            start = time.monotonic()
            try:
                return await self.pipeline.run(self.pipeline.device_executor, function, *args, **kwargs)
            finally:
                # Flush pending CUDA work even after inference errors/cancellation.
                try:
                    if self.synchronize:
                        await self.pipeline.run(self.pipeline.device_executor, self.synchronize)
                finally:
                    self.add('device_hold', time.monotonic() - start)

    async def render(self, *args, **kwargs):
        from render_stage import render_in_worker
        from lettering import LetteringError
        start = time.monotonic()
        try:
            result, error = await self.pipeline.layout(render_in_worker, *args, **kwargs)
            if error:
                raise LetteringError(error.removeprefix('CLASSIC_RENDER_'))
            return result
        finally:
            self.add('layout_wall', time.monotonic() - start)
