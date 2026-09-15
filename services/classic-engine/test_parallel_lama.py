"""Bounded crop submission, original-only inputs and failure draining."""
import unittest
from unittest.mock import patch
from concurrent.futures.process import BrokenProcessPool
import numpy as np
from parallel_lama import ParallelLama


class Executor:
    def __init__(self, fail=False):
        self.active = self.peak = self.calls = 0
        self.fail = fail

    def submit(self, function, image, mask, size):
        self.active += 1
        self.calls += 1
        number = self.calls
        self.peak = max(self.peak, self.active)
        owner = self
        class Future:
            def result(self):
                owner.active -= 1
                if owner.fail and number == 1:
                    if owner.fail == 'broken':
                        raise BrokenProcessPool('isolated worker exit')
                    raise ValueError('isolated crop failure')
                # Every crop must read the original, not a prior crop's output.
                assert np.all(image == 128)
                output = image.copy()
                output[mask > 0] = 99
                return output, {'pid': 1}
        return Future()


class ParallelCropTests(unittest.TestCase):
    def make(self, fail=False):
        pool = ParallelLama.__new__(ParallelLama)
        pool.workers, pool.executor, pool.records = 2, Executor(fail), {}
        pool.threads, pool.broken = 4, False
        image = np.full((800, 800, 3), 128, np.uint8)
        mask = np.zeros((800, 800), np.uint8)
        for x in (30, 330, 630):
            for y in (30, 330):
                mask[y:y+30, x:x+30] = 255
        return pool, image, mask

    def test_two_outstanding_crops_and_exact_output_ownership(self):
        pool, image, mask = self.make()
        output = pool.inpaint(image, mask, max_size=256, padding=16, merge_gap=0)
        expected = image.copy(); expected[mask > 0] = 99
        np.testing.assert_array_equal(output, expected)
        self.assertEqual((pool.executor.peak, pool.executor.active, pool.executor.calls), (2, 0, 6))

    def test_failed_crop_drains_other_worker_before_leaving_stage(self):
        pool, image, mask = self.make(True)
        with self.assertRaisesRegex(ValueError, 'isolated crop failure'):
            pool.inpaint(image, mask, max_size=256, padding=16, merge_gap=0)
        self.assertEqual((pool.executor.active, pool.executor.calls), (0, 2))

    def test_worker_exit_fails_current_stage_then_recreates_pool_on_next_admission(self):
        pool, image, mask = self.make('broken')
        with self.assertRaises(BrokenProcessPool):
            pool.inpaint(image, mask, max_size=256, padding=16, merge_gap=0)
        self.assertTrue(pool.broken)
        self.assertEqual(pool.executor.active, 0)
        def recreated(self, workers, threads):
            self.workers, self.threads, self.broken = workers, threads, False
            self.executor, self.records = Executor(), {}
        with patch.object(pool, 'close') as close, patch.object(ParallelLama, '__init__', recreated), patch.object(pool, 'warm') as warm:
            output = pool.inpaint(image, mask, max_size=256, padding=16, merge_gap=0)
        close.assert_called_once(); warm.assert_called_once()
        self.assertTrue(np.all(output[mask > 0] == 99))
