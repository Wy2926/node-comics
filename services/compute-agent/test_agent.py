import hashlib
import json
import threading
import unittest
from unittest.mock import patch

import httpx

from agent import Agent, Config, INPUT_LIMIT, InputCache, StageError


class AgentTests(unittest.TestCase):
    def test_tiny_inputs_have_an_entry_limit(self):
        cache = InputCache(1024, 60, max_entries=2)
        for key in ('a', 'b', 'c'):
            cache.put(key, b'')
        self.assertEqual(len(cache.entries), 2)
        self.assertIsNone(cache.get('a'))
    def test_original_downloaded_once_reauthorized_then_reference_miss_retried_once(self):
        lease = self.lease()
        calls = {'input': 0, 'authorize': 0, 'engine': []}
        missed = False

        def route(request):
            nonlocal missed
            path = request.url.path
            if path.endswith('/authorize'):
                calls['authorize'] += 1
                return httpx.Response(200, json={'sha256': lease['input']['sha256']})
            if path.endswith('/input'):
                calls['input'] += 1
                return httpx.Response(200, content=b'original')
            body = json.loads(request.content)
            calls['engine'].append(body)
            if path.endswith('/render') and not missed:
                missed = True
                return httpx.Response(410, json={'error': 'ENGINE_INPUT_CACHE_MISS'})
            return httpx.Response(200, json={'version': 'v4', 'input_hash': lease['input']['sha256'], 'image_ref': 'f'*64})

        agent = Agent(self.config(), transport=httpx.MockTransport(route))
        for stage in ('analyze', 'inpaint', 'render'):
            agent.execute({**lease, 'stage': stage, 'lease_id': stage, 'lease_token': stage})
        self.assertEqual((calls['input'], calls['authorize']), (1, 2))
        self.assertEqual(['image' in body for body in calls['engine']], [True, False, False, True])

    def test_cache_hit_requires_authorization_before_engine_and_other_job_cannot_reuse(self):
        lease = self.lease()
        calls = []
        def route(request):
            calls.append(request.url.path)
            if request.url.path.endswith('/authorize'):
                return httpx.Response(410, json={'error': 'ASSET_EXPIRED'})
            return httpx.Response(200, content=b'original')
        agent = Agent(self.config(), transport=httpx.MockTransport(route))
        key = (lease['job_id'], lease['input']['sha256'], json.dumps(lease['config']['engine'], sort_keys=True))
        agent.inputs.put(key, b'original')
        with self.assertRaises(httpx.HTTPStatusError):
            agent.execute(lease)
        self.assertEqual(calls, ['/internal/leases/lease-1/input/authorize'])
        self.assertIsNone(agent.inputs.get(('other-job', *key[1:])))

    def test_cache_is_bounded_and_absolute_ttl_does_not_renew_on_read(self):
        cache = InputCache(6, 10)
        with patch('agent.time.monotonic', return_value=1):
            cache.put('a', b'aaa'); cache.put('b', b'bbb')
            cache.get('a'); cache.put('c', b'ccc')
            self.assertIsNone(cache.get('b'))
            self.assertEqual(cache.size, 6)
            self.assertIsNone(cache.put('large', b'1234567'))
        with patch('agent.time.monotonic', return_value=8):
            self.assertIsNotNone(cache.get('a'))
        with patch('agent.time.monotonic', return_value=12):
            self.assertIsNone(cache.get('a'))
            self.assertEqual(cache.size, 0)
    def config(self):
        return Config('https://control.example', 'service-token', 'node-a', 'http://engine:8000', 'engine-token',
                      heartbeat_seconds=0.01, poll_seconds=0.001)

    def lease(self):
        return {'lease_id': 'lease-1', 'lease_token': 'scope-token', 'job_id': 'job-1', 'stage': 'analyze',
                'config': {'engine': {'version': 'v4'}},
                'input': {'url': '/internal/leases/lease-1/input', 'sha256': hashlib.sha256(b'original').hexdigest()}}

    def test_register_only_advertises_warm_engine_and_single_device_slot(self):
        received = []
        def route(request):
            if request.url.path == '/health':
                return httpx.Response(200, json={'ready': True, 'version': 'v4', 'device': 'cpu',
                    'resource_id': 'machine-a:cpu', 'capabilities': ['analyze', 'inpaint', 'render']})
            received.append(json.loads(request.content))
            return httpx.Response(200, json={'node_id': 'node-a'})
        agent = Agent(self.config(), transport=httpx.MockTransport(route))
        agent.register()
        self.assertEqual(received[0]['capacity'], 1)
        self.assertEqual(received[0]['resource_id'], 'machine-a:cpu')

    def test_same_completion_replayed_without_reexecuting_engine(self):
        calls = {'engine': 0, 'complete': []}
        lease = self.lease()
        def route(request):
            path = request.url.path
            if path.endswith('/claim'):
                return httpx.Response(200, json={'lease': lease})
            if path.endswith('/input'):
                self.assertEqual(request.headers['x-lease-token'], 'scope-token')
                return httpx.Response(200, content=b'original')
            if path.startswith('/v1/'):
                calls['engine'] += 1
                self.assertEqual(request.headers['authorization'], 'Bearer engine-token')
                return httpx.Response(200, json={'version': 'v4', 'input_hash': lease['input']['sha256'], 'segments': []})
            if path.endswith('/complete'):
                calls['complete'].append(request.content)
                if len(calls['complete']) == 1:
                    raise httpx.ReadError('uncertain completion')
            return httpx.Response(200, json={})
        agent = Agent(self.config(), transport=httpx.MockTransport(route))
        self.assertTrue(agent.run_once())
        self.assertEqual(calls['engine'], 1)
        self.assertEqual(len(calls['complete']), 2)
        self.assertEqual(*calls['complete'])

    def test_input_host_cannot_receive_control_credentials(self):
        lease = self.lease()
        lease['input']['url'] = 'https://evil.example/object'
        requests = []
        agent = Agent(self.config(), transport=httpx.MockTransport(lambda r: requests.append(r)))
        with self.assertRaisesRegex(StageError, 'CLASSIC_UNSAFE_INPUT_URL'):
            agent.read_input(lease)
        self.assertEqual(requests, [])

    def test_oversized_completion_sends_small_failure_instead_of_retrying_forever(self):
        requests = []
        def route(request):
            body = json.loads(request.content)
            requests.append(body)
            return httpx.Response(413 if 'result' in body else 200, json={'accepted': 'error' in body})
        agent = Agent(self.config(), transport=httpx.MockTransport(route))
        agent.finish(self.lease(), {'result': {'image': 'bounded-but-controller-limit-lower'}}, threading.Event())
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]['error']['code'], 'CLASSIC_RESPONSE_TOO_LARGE')

    def test_input_hash_and_declared_size_verified_before_model_call(self):
        for response, code in [(httpx.Response(200, content=b'changed'), 'CLASSIC_INPUT_CHANGED'),
            (httpx.Response(200, headers={'Content-Length': str(INPUT_LIMIT + 1)}), 'CLASSIC_RESPONSE_TOO_LARGE')]:
            agent = Agent(self.config(), transport=httpx.MockTransport(lambda r: response))
            with self.assertRaisesRegex(StageError, code):
                agent.execute(self.lease())

    def test_stale_lease_discards_late_result(self):
        stale = threading.Event()
        stale.set()
        requests = []
        agent = Agent(self.config(), transport=httpx.MockTransport(lambda r: requests.append(r)))
        agent.finish(self.lease(), {'result': {'image': 'late'}}, stale)
        self.assertEqual(requests, [])

    def test_heartbeat_fences_slow_engine_reply_after_lease_loss(self):
        lease = self.lease()
        heartbeat = threading.Event()
        completions = []
        def route(request):
            path = request.url.path
            if path.endswith('/claim'):
                return httpx.Response(200, json={'lease': lease})
            if path.endswith('/input'):
                return httpx.Response(200, content=b'original')
            if path.endswith('/heartbeat'):
                heartbeat.set()
                return httpx.Response(409, json={'error': 'LEASE_EXPIRED'})
            if path.startswith('/v1/'):
                self.assertTrue(heartbeat.wait(2))
                return httpx.Response(200, json={'version': 'v4', 'input_hash': lease['input']['sha256']})
            if path.endswith('/complete'):
                completions.append(request)
            return httpx.Response(200, json={})
        agent = Agent(self.config(), transport=httpx.MockTransport(route))
        with agent.heartbeat(lease) as stale:
            result = agent.execute(lease)
            self.assertTrue(stale.wait(2))
            agent.finish(lease, {'result': result}, stale)
        self.assertEqual(completions, [])

    def test_http_control_requires_explicit_local_opt_in(self):
        with self.assertRaises(ValueError):
            Config('http://api:8000', 'token', 'node', 'http://engine:8000', 'token')


if __name__ == '__main__':
    unittest.main()
