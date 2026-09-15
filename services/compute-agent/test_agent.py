import hashlib
import json
import threading
import unittest

import httpx

from agent import Agent, Config, INPUT_LIMIT, StageError


class AgentTests(unittest.TestCase):
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
