"""Pull one image stage when this device is idle; never access a task database.

Only the control endpoint receives the node credential. Requests, image bytes,
signed addresses, OCR and exception strings are intentionally never logged.
"""
import base64
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, replace
from functools import wraps
import hashlib
import json
import logging
import os
from pathlib import Path
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
ENGINE_ERRORS = {
    'LANGUAGE_UNSUPPORTED': '此节点不支持目标语言',
    'CLASSIC_RENDER_BOUNDARY': '译文无法在页边内完整排版',
    'CLASSIC_RENDER_BUBBLE_OVERFLOW': '译文无法在气泡边界内完整排版',
    'CLASSIC_RENDER_OVERLAP': '译文排版与受保护文字或其他译文区域重叠',
    'CLASSIC_RENDER_NO_GLYPHS': '嵌字未生成可见字形',
    'CLASSIC_RENDER_FONT_MISSING': '字体缺少译文所需字形',
    'CLASSIC_RENDER_INPUT_INVALID': '嵌字区域或背景检查点无效',
    'CLASSIC_RENDER_LAYOUT_FAILED': '译文无法在可用区域内完整排版',
}


def cache_locked(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self.lock:
            return method(self, *args, **kwargs)
    return wrapped


class StageError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class InputCache:
    """Disposable job-scoped originals and engine references; never persisted."""
    def __init__(self, max_bytes, ttl_seconds, max_entries=512):
        self.max_bytes, self.ttl_seconds = max_bytes, ttl_seconds
        self.max_entries = max(1, int(max_entries))
        self.entries, self.size = OrderedDict(), 0
        self.lock = threading.RLock()

    @cache_locked
    def get(self, key):
        for old, entry in list(self.entries.items()):
            if time.monotonic() - entry['created'] >= self.ttl_seconds:
                self.size -= len(self.entries.pop(old)['raw'])
        entry = self.entries.get(key)
        if entry:
            self.entries.move_to_end(key)
        return entry

    @cache_locked
    def put(self, key, raw):
        self.get(key)
        if len(raw) > self.max_bytes or not self.ttl_seconds:
            return None
        if key in self.entries:
            self.size -= len(self.entries.pop(key)['raw'])
        while self.size + len(raw) > self.max_bytes or len(self.entries) >= self.max_entries:
            self.size -= len(self.entries.popitem(last=False)[1]['raw'])
        entry = {'raw': raw, 'created': time.monotonic(), 'ref': None}
        self.entries[key] = entry
        self.size += len(raw)
        return entry


def bounded(response, limit, *, success=True):
    if success:
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
    poll_seconds: float = 1.0
    heartbeat_seconds: float = 10.0
    request_seconds: float = 30.0
    engine_seconds: float = 900.0
    allow_http: bool = False
    input_cache_bytes: int = 128 * 1024 * 1024
    input_cache_ttl_seconds: float = 900

    def __post_init__(self):
        parsed = urlsplit(self.control_url)
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Invalid CONTROL_URL')
        if parsed.scheme != 'https' and not (self.allow_http and parsed.scheme == 'http'):
            raise ValueError('CONTROL_URL must use HTTPS; local tests explicitly enable CONTROL_ALLOW_HTTP')
        if not self.node_id or len(self.node_id) > 80 or not self.token or not self.engine_token:
            raise ValueError('NODE_ID, NODE_TOKEN and ENGINE_TOKEN are required')
        if min(self.poll_seconds, self.heartbeat_seconds, self.request_seconds, self.engine_seconds) <= 0:
            raise ValueError('Timeouts must be positive')
        if self.input_cache_bytes < 0 or self.input_cache_ttl_seconds < 0:
            raise ValueError('Cache limits must be nonnegative')

    @classmethod
    def environment(cls):
        if os.environ.get('NODE_CONFIG_FILE'):
            document = json.loads(Path(os.environ['NODE_CONFIG_FILE']).read_text(encoding='utf-8'))
            if set(document) != {'schema_version', 'control_url', 'node_id', 'node_token', 'engine_url', 'engine_token', 'allow_http'} or document['schema_version'] != 1:
                raise ValueError('Invalid node configuration file')
            return cls(control_url=document['control_url'].rstrip('/'), token=document['node_token'],
                       node_id=document['node_id'], engine_url=document['engine_url'].rstrip('/'),
                       engine_token=document['engine_token'], allow_http=document['allow_http'])
        return cls(control_url=os.environ['CONTROL_URL'].rstrip('/'), token=os.environ['NODE_TOKEN'],
                   node_id=os.environ['NODE_ID'],
                   engine_url=os.environ['ENGINE_URL'].rstrip('/'),
                   engine_token=os.environ['ENGINE_TOKEN'],
                   allow_http=os.environ.get('CONTROL_ALLOW_HTTP', 'false').lower() == 'true')


class Agent:
    def __init__(self, config, *, transport=None):
        self.config = config
        self.stop = threading.Event()
        self.applied_version = 0
        self.execution_slots = 0
        self.config_poll_seconds = 15
        self.engine_identity = None
        self.effective_engine = None
        self.inputs = InputCache(config.input_cache_bytes, config.input_cache_ttl_seconds)
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

    def engine_health(self):
        with self.engine.stream('GET', self.config.engine_url + '/health', timeout=self.config.request_seconds) as response:
            health = json.loads(bounded(response, 8192))
        if not health.get('ready') or set(health.get('capabilities', [])) != set(STAGES):
            raise StageError('CLASSIC_ENGINE_NOT_READY')
        return health

    def register(self, health=None):
        health = health or self.engine_health()
        self.engine_identity = (health['instance_id'], health['version'], health['resource_id'])
        return self.control('/internal/nodes/register', {
            'capabilities': list(STAGES),
            'engine_version': health['version'], 'device': health['device'],
            'resource_id': health['resource_id'],
        }, limit=8192)

    def apply_config(self, document):
        values = document['config']
        if document['node_id'] != self.config.node_id or values['schema_version'] != 1:
            raise StageError('NODE_CONFIG_INVALID')
        slots = values['execution_slots']
        if type(slots) is not int or not 1 <= slots <= 32:
            raise StageError('NODE_CONFIG_INVALID')
        updated = replace(self.config, poll_seconds=values['poll_seconds'],
            heartbeat_seconds=values['heartbeat_seconds'], request_seconds=values['request_seconds'],
            engine_seconds=values['stage_seconds'], input_cache_bytes=values['input_cache_bytes'],
            input_cache_ttl_seconds=values['input_cache_ttl_seconds'])
        path = '/internal/nodes/' + self.config.node_id + '/config/applied'
        try:
            with self.engine.stream('POST', self.config.engine_url + '/internal/config', json=values['engine'],
                    headers={'Authorization': 'Bearer ' + self.config.engine_token}) as response:
                applied = json.loads(bounded(response, 8192))
            self.control(path, {'version': document['version'], 'engine': applied['runtime'],
                               'supported_languages': applied['supported_languages']}, limit=8192)
        except (httpx.HTTPError, StageError, ValueError, KeyError):
            try:
                self.control(path, {'version': document['version'], 'error': 'ENGINE_CONFIG_FAILED'}, limit=8192)
            except (httpx.HTTPError, StageError, ValueError):
                pass
            raise
        # Only called after every current worker has returned; no running stage
        # observes a half-applied timeout, cache or engine configuration.
        self.config = updated
        self.client.timeout = httpx.Timeout(updated.request_seconds)
        self.engine.timeout = httpx.Timeout(updated.engine_seconds)
        self.inputs = InputCache(updated.input_cache_bytes, updated.input_cache_ttl_seconds)
        self.applied_version = document['version']
        self.execution_slots = slots
        self.config_poll_seconds = values['config_poll_seconds']
        self.effective_engine = applied['runtime']

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
        identity = (lease['job_id'], lease['input']['sha256'], json.dumps(config, sort_keys=True))
        cached = self.inputs.get(identity)
        if cached is not None:
            permission = self.control('/internal/leases/' + lease['lease_id'] + '/input/authorize',
                                      lease_token=lease['lease_token'], limit=8192)
            if permission.get('sha256') != lease['input']['sha256']:
                raise StageError('CLASSIC_INPUT_CHANGED')
            raw = cached['raw']
        else:
            raw = self.read_input(lease)
            cached = self.inputs.put(identity, raw)
        payload = {'config': config, 'scope': lease['job_id'], 'input_hash': lease['input']['sha256']}
        if cached and cached['ref']:
            payload['image_ref'] = cached['ref']
        else:
            payload['image'] = base64.b64encode(raw).decode()
        for field in ('analysis', 'translations', 'language', 'cache_key'):
            if lease.get(field) is not None:
                payload[field] = lease[field]
        if len(json.dumps(payload.get('analysis'), allow_nan=False).encode()) > CHECKPOINT_LIMIT:
            raise StageError('CLASSIC_CHECKPOINT_TOO_LARGE')
        for attempt in range(2):
            with self.engine.stream('POST', self.config.engine_url + '/v1/' + lease['stage'], json=payload,
                                    headers={'Authorization': 'Bearer ' + self.config.engine_token}) as response:
                if response.status_code == 410 and 'image_ref' in payload and attempt == 0:
                    miss = json.loads(bounded(response, 8192, success=False))
                    if miss.get('error') == 'ENGINE_INPUT_CACHE_MISS':
                        # A definite miss occurs before model execution. Never
                        # retry uncertain HTTP failures or inference errors here.
                        payload.pop('image_ref')
                        payload['image'] = base64.b64encode(raw).decode()
                        continue
                if response.status_code == 422:
                    detail = json.loads(bounded(response, 8192, success=False))
                    code = detail.get('error') if isinstance(detail, dict) else None
                    if isinstance(code, str) and code in ENGINE_ERRORS:
                        raise StageError(code)
                    raise StageError('CLASSIC_' + lease['stage'].upper() + '_FAILED')
                if response.status_code == 409:
                    raise StageError('CLASSIC_ENGINE_CHANGED')
                result = json.loads(bounded(response, JSON_LIMIT))
                break
        if result.get('version') != config['version'] or result.get('input_hash') != lease['input']['sha256']:
            raise StageError('CLASSIC_ENGINE_CHANGED')
        if cached is not None:
            cached['ref'] = result.get('image_ref')
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
        if self.stop.is_set():
            return False
        reply = self.control('/internal/nodes/' + self.config.node_id + '/claim',
                             {'stages': list(STAGES), 'config_version': self.applied_version})
        lease = reply.get('lease')
        if not lease:
            return False
        with self.heartbeat(lease) as stale:
            try:
                result = self.execute(lease)
                body = {'result': result}
            except StageError as error:
                body = {'error': {'code': error.code, 'message': ENGINE_ERRORS.get(error.code, '计算阶段失败')}}
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
        document, next_sync = None, 0
        futures = set()
        executor = ThreadPoolExecutor(max_workers=32, thread_name_prefix='image-stage')
        try:
            while not self.stop.is_set():
                try:
                    for future in list(futures):
                        if future.done():
                            futures.remove(future)
                            try:
                                future.result()
                            except (httpx.HTTPError, StageError, ValueError, KeyError):
                                # Re-fetch desired config after stale claims; do
                                # not re-register and fence other running slots.
                                document, next_sync = None, 0
                    if not registered:
                        document = self.register()
                        registered = True
                    if time.monotonic() >= next_sync:
                        document = self.control('/internal/nodes/' + self.config.node_id + '/config', limit=8192)
                        health = self.engine_health()
                        identity = (health['instance_id'], health['version'], health['resource_id'])
                        if identity != self.engine_identity:
                            self.applied_version = 0
                            if futures:
                                document = None
                            else:
                                document = self.register(health)
                        elif self.effective_engine is not None and health['runtime'] != self.effective_engine:
                            self.applied_version = 0
                        next_sync = time.monotonic() + self.config_poll_seconds
                    pending = document and document['version'] != self.applied_version
                    if pending and not futures:
                        self.apply_config(document)
                        next_sync = time.monotonic() + self.config_poll_seconds
                        pending = False
                    if document and document['enabled'] and not pending:
                        for _ in range(self.execution_slots - len(futures)):
                            if self.stop.is_set():
                                break
                            futures.add(executor.submit(self.run_once))
                    self.stop.wait(self.config.poll_seconds)
                except (httpx.HTTPError, StageError, ValueError, KeyError):
                    document, next_sync = None, 0
                    log.warning('control or engine unavailable')
                    self.stop.wait(max(2, self.config.poll_seconds))
        finally:
            executor.shutdown(wait=True)
            self.inputs.entries.clear()
            self.inputs.size = 0
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
