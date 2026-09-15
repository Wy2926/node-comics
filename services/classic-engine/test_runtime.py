import asyncio
import multiprocessing
import tempfile
import time
import unittest
from unittest.mock import patch

from runtime import DeviceLock, ImageCache, cache_key


def acquire_in_process(directory, entered):
    async def run():
        async with DeviceLock('gpu-0', directory).hold():
            entered.set()
    asyncio.run(run())


class CacheTests(unittest.TestCase):
    def test_lru_eviction_and_oversized_rejection(self):
        cache = ImageCache(6, 60)
        self.assertTrue(cache.put('a', b'aa'))
        self.assertTrue(cache.put('b', b'bb'))
        self.assertEqual(cache.get('a'), b'aa')
        self.assertTrue(cache.put('c', b'cccc'))
        self.assertIsNone(cache.get('b'))
        self.assertLessEqual(cache.size, 6)
        self.assertFalse(cache.put('d', b'1234567'))
        self.assertEqual(cache.get('a'), b'aa')

    def test_expiry_is_absolute_not_extended_by_reads(self):
        with patch('runtime.time.monotonic', return_value=1):
            cache = ImageCache(6, 10)
            cache.put('a', b'aa')
        with patch('runtime.time.monotonic', return_value=5):
            self.assertEqual(cache.get('a'), b'aa')
        with patch('runtime.time.monotonic', return_value=12):
            self.assertIsNone(cache.get('a'))
            self.assertEqual(cache.size, 0)

    def test_cache_key_binds_scope_input_config_and_checkpoint(self):
        key = cache_key('job', 'hash', {'version': 1}, {'mask': 1})
        for args in [('other', 'hash', {'version': 1}, {'mask': 1}),
                     ('job', 'changed', {'version': 1}, {'mask': 1}),
                     ('job', 'hash', {'version': 2}, {'mask': 1}),
                     ('job', 'hash', {'version': 1}, {'mask': 2})]:
            self.assertNotEqual(key, cache_key(*args))


class LockTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_physical_device_cannot_overlap_across_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            context = multiprocessing.get_context('spawn')
            entered = context.Event()
            process = context.Process(target=acquire_in_process, args=(directory, entered))
            async with DeviceLock('gpu-0', directory).hold():
                process.start()
                await asyncio.sleep(0.3)
                self.assertFalse(entered.is_set())
            deadline = time.monotonic() + 5
            while not entered.is_set() and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            self.assertTrue(entered.is_set())
            process.join(timeout=5)
            self.assertEqual(process.exitcode, 0)


if __name__ == '__main__':
    unittest.main()
