"""CPU-only regression for the patched NCNN wheel; no model downloads or GPU."""
from concurrent.futures import ThreadPoolExecutor
from importlib.metadata import version
import sys
import threading
import time
import unittest

import ncnn
import numpy as np


def network():
    net = ncnn.Net()
    net.opt.use_vulkan_compute = False
    net.opt.num_threads = 1
    # Substantial native work lets a Python heartbeat run inside extract(), not
    # merely between calls. No learned weights or Python layer callbacks.
    assert net.load_param_mem('7767517\n2 2\nInput input 0 1 in0\n'
                              'Pooling pool 1 1 in0 out0 0=0 1=31 2=1 3=15\n') == 0
    return net


class GilTests(unittest.TestCase):
    def test_local_version_is_part_of_engine_dependency_identity(self):
        self.assertEqual(version('ncnn'), '1.0.20260526+nodegil1')

    def test_all_extract_overloads_release_gil_and_preserve_pixels(self):
        net = network()
        data = np.full((3, 384, 384), .25, np.float32)
        stop = threading.Event()
        ticks = []

        def pulse():
            while not stop.wait(.001):
                ticks.append(time.perf_counter())

        thread = threading.Thread(target=pulse)
        thread.start()
        interval = sys.getswitchinterval()
        try:
            # Prevent adjacent bytecode switches from looking like a GIL release
            # inside the native call. The pulse always yields after each tick.
            sys.setswitchinterval(1.)
            for name, output_arg in [('out0', False), (1, False), ('out0', True), (1, True)]:
                with self.subTest(name=name, output_arg=output_arg), net.create_extractor() as ex:
                    self.assertEqual(ex.input('in0', ncnn.Mat(data)), 0)
                    output = ncnn.Mat()
                    before = time.perf_counter()
                    if output_arg:
                        code = ex.extract(name, output)
                    else:
                        code, output = ex.extract(name)
                    after = time.perf_counter()
                    self.assertEqual(code, 0)
                    np.testing.assert_array_equal(np.asarray(output), data)
                    inside = [tick for tick in ticks if before + .002 < tick < after - .002]
                    self.assertGreaterEqual(len(inside), 3, f'Python blocked during {after-before:.4f}s extract')
        finally:
            sys.setswitchinterval(interval)
            stop.set()
            thread.join()

    def test_shared_model_serialization_and_result_lifetime(self):
        net, lock = network(), threading.Lock()

        def infer(value):
            data = np.full((3, 32, 32), value, np.float32)
            with lock, net.create_extractor() as ex:
                self.assertEqual(ex.input('in0', ncnn.Mat(data)), 0)
                code, output = ex.extract('out0')
                self.assertEqual(code, 0)
            data.fill(-1)
            return np.array(output, copy=True)

        with ThreadPoolExecutor(4) as pool:
            results = list(pool.map(infer, [.25, .5, .75, 1.] * 3))
        for result, value in zip(results, [.25, .5, .75, 1.] * 3):
            np.testing.assert_array_equal(result, np.full((3, 32, 32), value, np.float32))


if __name__ == '__main__':
    unittest.main()
