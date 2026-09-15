"""Pull one image stage when this device is idle; never access a task database.

Only the control endpoint receives the service token. Requests, image bytes,
signed addresses, OCR and exception strings are intentionally never logged.
"""
import base64
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import logging
import os
import signal
import threading
import time
from urllib.parse import urljoin, urlsplit

import httpx

STAGES = ('analyze', 'inpaint', 'render')
INPUT_LIMIT = 24 * 1024 * 1024
JSON_LIMIT = 96 * 1024 * 1024
CHECKPOINT_LIMIT = 4 * 1024 * 1024
log = logging.getLogger('compute-agent')


class StageError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def bounded(response, limit):
    response.raise_for_status()
    declared = response.headers.get('content-length', '')
    if declared.isdigit() and int(declared) > limit:
        raise StageError('CLASSIC_RESPONSE_TOO_LARGE')
    result = bytearray()
    for chunk in response.iter_bytes(64 * 1024):
        if len(result) + len(chunk) > limit:
            raise StageError('CLASSIC_RESPONSE_TOO_LARGE')
        result.extend(chunk)
    return bytes(result)


def origin(value):
    parsed = urlsplit(value)
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80)


@dataclass(frozen=True)
class Config:
    control_url: str
    token: str
    node_id: str
    engine_url: str
    engine_token: str
    name: str = 'image device'
    poll_seconds: float = 1.0
    heartbeat_seconds: float = 10.0
    request_seconds: float = 30.0
    engine_seconds: float = 900.0
    allow_http: bool = False

    def __post_init__(self):
        parsed = urlsplit(self.control_url)
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Invalid CONTROL_URL')
        if parsed.scheme != 'https' and not (self.allow_http and parsed.scheme == 'http'):
            raise ValueError('CONTROL_URL must use HTTPS; local tests explicitly enable CONTROL_ALLOW_HTTP')
        if not self.node_id or len(self.node_id) > 80 or not self.token or not self.engine_token:
            raise ValueError('NODE_ID, CLUSTER_NODE_TOKEN and ENGINE_TOKEN are required')
        if min(self.poll_seconds, self.heartbeat_seconds, self.request_seconds, self.engine_seconds) <= 0:
            raise ValueError('Timeouts must be positive')

    @classmethod
    def environment(cls):
        return cls(control_url=os.environ['CONTROL_URL'].rstrip('/'), token=os.environ['CLUSTER_NODE_TOKEN'],
                   node_id=os.environ['NODE_ID'], name=os.environ.get('NODE_NAME', 'image device'),
                   engine_url=os.environ.get('ENGINE_URL', 'http://classic-engine:8000').rstrip('/'),
                   engine_token=os.environ['ENGINE_TOKEN'],
                   poll_seconds=float(os.environ.get('NODE_POLL_SECONDS', '1')),
                   heartbeat_seconds=float(os.environ.get('NODE_HEARTBEAT_SECONDS', '10')),
                   request_seconds=float(os.environ.get('NODE_REQUEST_SECONDS', '30')),
                   engine_seconds=float(os.environ.get('NODE_STAGE_SECONDS', '900')),
                   allow_http=os.environ.get('CONTROL_ALLOW_HTTP', 'false').lower() == 'true')


class Agent:
    def __init__(self, config, *, transport=None):
        self.config = config
        self.stop = threading.Event()
        self.client = httpx.Client(timeout=config.request_seconds, trust_env=False,
                                   follow_redirects=False, transport=transport)
        self.engine = httpx.Client(timeout=config.engine_seconds, trust_env=False,
                                   follow_redirects=False, transport=transport)

    def control(self, path, body=None, *, lease_token=None, limit=JSON_LIMIT):
        url = urljoin(self.config.control_url + '/', path.lstrip('/'))
        if origin(url) != origin(self.config.control_url):
            raise StageError('CLASSIC_UNSAFE_INPUT_URL')
        headers = {'Authorization': 'Bearer ' + self.config.token, 'X-Node-Id': self.config.node_id}
        if lease_token:
            headers['X-Lease-Token'] = lease_token
        with self.client.stream('GET' if body is None else 'POST', url, json=body, headers=headers) as response:
            raw = bounded(response, limit)
        return json.loads(raw)

    def register(self):
        with self.engine.stream('GET', self.config.engine_url + '/health') as response:
            health = json.loads(bounded(response, 8192))
        if not health.get('ready') or set(health.get('capabilities', [])) != set(STAGES):
            raise StageError('CLASSIC_ENGINE_NOT_READY')
        self.control('/internal/nodes/register', {
            'id': self.config.node_id, 'name': self.config.name, 'capabilities': list(STAGES),
            'capacity': 1, 'engine_version': health['version'], 'device': health['device'],
            'resource_id': health['resource_id'],
        }, limit=8192)

    def read_input(self, lease):
        supplied = lease['input']['url']
        url = urljoin(self.config.control_url + '/', supplied.lstrip('/'))
        if origin(url) != origin(self.config.control_url):
            raise StageError('CLASSIC_UNSAFE_INPUT_URL')
        headers = {'Authorization': 'Bearer ' + self.config.token, 'X-Node-Id': self.config.node_id,
                   'X-Lease-Token': lease['lease_token']}
        with self.client.stream('GET', url, headers=headers) as response:
            raw = bounded(response, INPUT_LIMIT)
        if hashlib.sha256(raw).hexdigest() != lease['input']['sha256']:
            raise StageError('CLASSIC_INPUT_CHANGED')
        return raw

    @contextmanager
    def heartbeat(self, lease):
        done, stale = threading.Event(), threading.Event()

        def beat():
            while not done.wait(self.config.heartbeat_seconds):
                try:
                    self.control('/internal/leases/' + lease['lease_id'] + '/heartbeat',
                                 {'lease_token': lease['lease_token']}, limit=8192)
                except httpx.HTTPStatusError as error:
                    if error.response.status_code in (401, 403, 404, 409, 410):
                        stale.set()
                        return
                except (httpx.HTTPError, StageError, ValueError):
                    # The controller owns expiry. An uncertain heartbeat never
                    # permits a second stage to be claimed on this device.
                    pass

        thread = threading.Thread(target=beat, name='lease-heartbeat', daemon=True)
        thread.start()
        try:
            yield stale
        finally:
            done.set()
            thread.join(timeout=self.config.request_seconds + 1)

    def execute(self, lease):
        if lease['stage'] not in STAGES:
            raise StageError('CLASSIC_STAGE_UNSUPPORTED')
        config = lease['config']['engine']
        raw = self.read_input(lease)
        payload = {'image': base64.b64encode(raw).decode(), 'config': config, 'scope': lease['job_id']}
        for field in ('analysis', 'translations', 'language', 'cache_key'):
            if lease.get(field) is not None:
                payload[field] = lease[field]
        if len(json.dumps(payload.get('analysis'), allow_nan=False).encode()) > CHECKPOINT_LIMIT:
            raise StageError('CLASSIC_CHECKPOINT_TOO_LARGE')
        with self.engine.stream('POST', self.config.engine_url + '/v1/' + lease['stage'], json=payload,
                                headers={'Authorization': 'Bearer ' + self.config.engine_token}) as response:
            if response.status_code == 422:
                raise StageError('CLASSIC_' + lease['stage'].upper() + '_FAILED')
            if response.status_code == 409:
                raise StageError('CLASSIC_ENGINE_CHANGED')
            result = json.loads(bounded(response, JSON_LIMIT))
        if result.get('version') != config['version'] or result.get('input_hash') != lease['input']['sha256']:
            raise StageError('CLASSIC_ENGINE_CHANGED')
        return result

    def finish(self, lease, body, stale):
        # Repeat the same completion payload after an uncertain network response;
        # never repeat computation or fetch another lease while retaining output.
        path = '/internal/leases/' + lease['lease_id'] + '/complete'
        while not stale.is_set():
            try:
                self.control(path, {'lease_token': lease['lease_token'], **body}, limit=8192)
                return
            except httpx.HTTPStatusError as error:
                if error.response.status_code == 413 and 'result' in body:
                    body = {'error': {'code': 'CLASSIC_RESPONSE_TOO_LARGE', 'message': '阶段结果超过控制服务接收上限'}}
                    continue
                if error.response.status_code in (401, 403, 404, 409, 410, 422):
                    return
            except (httpx.HTTPError, StageError, ValueError):
                pass
            # Keep the heartbeat active during completion recovery. On graceful
            # shutdown allow an operator restart after the controller lease TTL.
            if self.stop.wait(self.config.poll_seconds):
                return

    def run_once(self):
        reply = self.control('/internal/nodes/' + self.config.node_id + '/claim', {'stages': list(STAGES)})
        lease = reply.get('lease')
        if not lease:
            return False
        with self.heartbeat(lease) as stale:
            try:
                result = self.execute(lease)
                body = {'result': result}
            except StageError as error:
                body = {'error': {'code': error.code, 'message': '计算阶段失败'}}
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                body = {'error': {'code': 'CLASSIC_ENGINE_UNAVAILABLE', 'message': '计算节点阶段调用失败'}}
            if stale.is_set():
                # Computation has now returned, so a cancelled current lease can
                # release its device slot without waiting for the expiry sweep.
                # No image/checkpoint from this fenced execution is submitted.
                try:
                    self.control('/internal/leases/' + lease['lease_id'] + '/complete',
                        {'lease_token': lease['lease_token'], 'error': {'code': 'CLASSIC_LEASE_STOPPED', 'message': '计算已结束，执行授权已停止'}},
                        limit=8192)
                except (httpx.HTTPError, StageError, ValueError):
                    pass
            else:
                self.finish(lease, body, stale)
        return True

    def run(self):
        registered = False
        try:
            while not self.stop.is_set():
                try:
                    if not registered:
                        self.register()
                        registered = True
                        log.info('node ready')
                    if not self.run_once():
                        self.stop.wait(self.config.poll_seconds)
                except (httpx.HTTPError, StageError, ValueError, KeyError):
                    registered = False
                    log.warning('control or engine unavailable')
                    self.stop.wait(max(2, self.config.poll_seconds))
        finally:
            self.engine.close()
            self.client.close()


def main():
    logging.basicConfig(level=logging.WARNING, format='%(levelname)s %(message)s')
    logging.getLogger('httpx').disabled = True
    logging.getLogger('httpcore').disabled = True
    agent = Agent(Config.environment())
    for name in ('SIGINT', 'SIGTERM'):
        signal.signal(getattr(signal, name), lambda *_: agent.stop.set())
    agent.run()


if __name__ == '__main__':
    main()
