"""NCNN native extraction may release the GIL; model ownership must not rely on it."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Lock
import time

import numpy as np
import pytest

from manhua_engine import backend


def fixture_network(monkeypatch, rendezvous=None):
    monkeypatch.setattr(backend.ncnn, 'Mat', lambda array: array)
    network = backend.Network.__new__(backend.Network)
    network.lock, network.lock_metric = Lock(), 'ocr_lock_wait'
    state = {'active': 0, 'peak': 0, 'error': None}

    class Extractor:
        def __enter__(self):
            state['active'] += 1
            state['peak'] = max(state['peak'], state['active'])
            return self

        def __exit__(self, *args):
            state['active'] -= 1
            if hasattr(self, 'output'):
                self.output.fill(-1)  # Invalidate borrowed native storage.

        def input(self, name, value):
            self.value = value
            return 0

        def extract(self, name):
            if rendezvous:
                rendezvous.wait(timeout=3)
            time.sleep(.005)  # Simulate a native call that releases the GIL.
            if state['error']:
                raise RuntimeError('native failure')
            self.output = self.value.copy()
            return 0, self.output

    class Net:
        create_extractor = staticmethod(Extractor)

    network.net = Net()
    return network, state


def test_same_model_is_serial_and_outputs_outlive_extractor(monkeypatch):
    network, state = fixture_network(monkeypatch)
    values = [np.full((3, 2, 4), index, np.float64)[:, :, ::2] for index in range(12)]
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda value: network.run({'in0': value}, ['out0'])[0], values))
    assert state['peak'] == 1 and state['active'] == 0
    for value, result in zip(values, results):
        np.testing.assert_array_equal(result, value)
        assert result.dtype == np.float32 and result.flags.c_contiguous


def test_different_models_are_not_globally_serialized(monkeypatch):
    rendezvous = Barrier(2)
    networks = [fixture_network(monkeypatch, rendezvous)[0] for _ in range(2)]
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda net: net.run({'in0': np.ones((3, 2, 2))}, ['out0']), networks))
    assert len(results) == 2


def test_native_failure_releases_model_lock(monkeypatch):
    network, state = fixture_network(monkeypatch)
    state['error'] = True
    with pytest.raises(RuntimeError, match='native failure'):
        network.run({'in0': np.ones((3, 2, 2))}, ['out0'])
    assert not network.lock.locked() and state['active'] == 0
    state['error'] = None
    assert network.run({'in0': np.ones((3, 2, 2))}, ['out0'])[0].min() == 1
