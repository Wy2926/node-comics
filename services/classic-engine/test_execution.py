"""Ordering and cancellation evidence, independent of GPU speed or model mocks."""
import asyncio
from concurrent.futures.process import BrokenProcessPool
import os
from pathlib import Path
import tempfile
from threading import Event
import time
import unittest

from execution import Admission, Execution, Pipeline
from runtime import DeviceLock


def block_process(entered, release):
    import threading
    Path(entered).touch()
    until = time.monotonic() + 15
    while not Path(release).exists():
        if time.monotonic() > until:
            raise TimeoutError('Test worker release')
        time.sleep(.01)
    return os.getpid(), threading.current_thread() is threading.main_thread()


def crash_process():
    os._exit(17)


class ExecutionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.pipeline = Pipeline()
        self.addCleanup(self.pipeline.close)
        self.lock = DeviceLock('test-device', self.temp.name)
        self.execution = Execution(self.pipeline, self.lock)

    async def test_cpu_work_overlaps_inference_and_event_loop_stays_responsive(self):
        entered, release, inferred = Event(), Event(), Event()
        def cpu():
            entered.set()
            assert release.wait(5)
        task = asyncio.create_task(self.execution.cpu(cpu))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            await asyncio.wait_for(self.execution.device(inferred.set), 2)
            self.assertTrue(inferred.is_set())
        finally:
            release.set()
            await task

    async def test_layout_process_main_thread_overlaps_device_and_cancel_drains(self):
        entered, release = [str(Path(self.temp.name) / name) for name in ('entered', 'release')]
        async def layout():
            async with self.pipeline.admission.enter():
                return await self.pipeline.run(self.pipeline.layout_executor, block_process, entered, release)
        task = asyncio.create_task(layout())
        try:
            async def started():
                while not Path(entered).exists():
                    await asyncio.sleep(.01)
            await asyncio.wait_for(started(), 10)
            await asyncio.wait_for(self.execution.device(lambda: None), 2)
            task.cancel()
            await asyncio.sleep(.02)
            self.assertFalse(task.done())
            self.assertEqual(self.pipeline.admission.active, 1)
        finally:
            Path(release).touch()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(self.pipeline.admission.active, 0)
        pid, main_thread = await self.pipeline.run(self.pipeline.layout_executor, block_process, entered, release)
        self.assertNotEqual(pid, os.getpid())
        self.assertTrue(main_thread)

    async def test_repeated_cancel_keeps_device_locked_until_work_finishes(self):
        entered, release, other = Event(), Event(), Event()
        def model():
            entered.set()
            assert release.wait(5)
            raise ValueError('Late native failure')
        task = asyncio.create_task(self.execution.device(model))
        second = None
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            task.cancel()
            await asyncio.sleep(.02)
            task.cancel()
            second = asyncio.create_task(self.execution.device(other.set))
            await asyncio.sleep(.05)
            self.assertFalse(task.done())
            self.assertFalse(other.is_set())
        finally:
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
            if second:
                await second
        self.assertTrue(other.is_set())

    async def test_worker_failure_synchronizes_before_unlock_and_next_call_succeeds(self):
        synchronized = Event()
        execution = Execution(self.pipeline, self.lock, synchronized.set)
        def fail():
            raise ValueError('Model failed')
        with self.assertRaises(ValueError):
            await execution.device(fail)
        self.assertTrue(synchronized.is_set())
        self.assertEqual(await execution.device(lambda: 42), 42)

    async def test_crashed_layout_worker_fails_page_and_recovers_next_request(self):
        with self.assertRaises(BrokenProcessPool):
            await self.pipeline.layout(crash_process)
        self.assertTrue(self.pipeline.layout_broken)
        self.assertNotEqual(await self.pipeline.layout(os.getpid), os.getpid())
        self.assertFalse(self.pipeline.layout_broken)

    async def test_configuration_waits_for_cpu_and_blocks_new_admissions(self):
        entered, release, updated, later = asyncio.Event(), asyncio.Event(), asyncio.Event(), asyncio.Event()
        gate = Admission(capacity=2)
        async def active():
            async with gate.enter():
                entered.set()
                await release.wait()
        async def configure():
            async with gate.exclusive():
                updated.set()
                await asyncio.sleep(.02)
        async def new_request():
            async with gate.enter():
                self.assertTrue(updated.is_set())
                later.set()
        first = asyncio.create_task(active())
        await entered.wait()
        config = asyncio.create_task(configure())
        await asyncio.sleep(0)
        next_request = asyncio.create_task(new_request())
        await asyncio.sleep(.02)
        self.assertFalse(updated.is_set())
        self.assertFalse(later.is_set())
        release.set()
        await asyncio.gather(first, config, next_request)
        self.assertTrue(later.is_set())

    async def test_admission_bound_and_cancelled_writer_does_not_stall_requests(self):
        gate = Admission(capacity=1)
        async def writer():
            async with gate.exclusive():
                self.fail('Must wait for active page')
        async with gate.enter():
            task = asyncio.create_task(writer())
            await asyncio.sleep(0)
            self.assertEqual(gate.writers, 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        async with gate.enter():
            self.assertEqual(gate.active, 1)
        self.assertEqual(gate.active, 0)
