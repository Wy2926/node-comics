"""Separate credentialed control and credential-free, origin-pinned R2 clients."""
import hashlib
import re
import ssl
import httpx
from .config import origin
from .protocol import ControlFailure, MAX_IMAGE_BYTES, NodeFailure

PREFIX = '/internal/compute/v2'


class Transport:
    def __init__(self, config, *, control_transport=None, storage_transport=None):
        self.node_id = config['node_id']
        self.r2_origin = origin(config['r2_origin'])
        verify = ssl.create_default_context(cafile=config['control_ca']) if config.get('control_ca') else True
        self.control = httpx.Client(base_url=config['control_url'], trust_env=False, follow_redirects=False,
            timeout=30, verify=verify, transport=control_transport, headers={'Authorization': 'Bearer ' + config['node_token'],
                                                           'X-Node-Id': self.node_id})
        self.storage = httpx.Client(trust_env=False, follow_redirects=False, timeout=30, transport=storage_transport)

    def close(self):
        self.control.close()
        self.storage.close()

    def post(self, path, body):
        try:
            response = self.control.post(PREFIX + path, json=body)
        except httpx.HTTPError:
            raise ControlFailure('CONTROL_UNAVAILABLE') from None
        if response.status_code >= 300:
            code = 'CONTROL_REJECTED'
            try:
                candidate = response.json().get('error', {}).get('code', '')
                if re.fullmatch(r'[A-Z_]{1,80}', candidate):
                    code = candidate
            except (ValueError, AttributeError, TypeError):
                pass
            raise ControlFailure(code, response.status_code)
        try:
            return response.json()
        except ValueError:
            raise ControlFailure('CONTROL_INVALID_RESPONSE') from None

    def download(self, metadata, check=lambda: None):
        url = httpx.URL(metadata['url'])
        expected = httpx.URL(self.r2_origin)
        if (url.scheme != 'https' or url.host != expected.host or url.port != expected.port
                or url.username or url.password or url.fragment):
            raise NodeFailure('STORAGE_AUTH_FAILED')
        limit = metadata['byte_size']
        if not isinstance(limit, int) or not 0 < limit <= MAX_IMAGE_BYTES:
            raise NodeFailure('INPUT_INVALID')
        try:
            check()
            with self.storage.stream('GET', url, headers={'Accept-Encoding': 'identity'}) as response:
                if response.status_code in (401, 403):
                    raise NodeFailure('STORAGE_AUTH_FAILED')
                if response.status_code == 404 or 300 <= response.status_code < 500:
                    raise NodeFailure('INPUT_INVALID')
                if response.status_code != 200:
                    raise NodeFailure('STORAGE_UNAVAILABLE')
                data = bytearray()
                for chunk in response.iter_bytes(64 * 1024):
                    check()
                    data.extend(chunk)
                    if len(data) > limit:
                        raise NodeFailure('INPUT_INVALID')
        except httpx.HTTPError:
            raise NodeFailure('STORAGE_UNAVAILABLE') from None
        if len(data) != limit:
            raise NodeFailure('INPUT_INVALID')
        if hashlib.sha256(data).hexdigest() != metadata['sha256']:
            raise NodeFailure('INPUT_HASH_MISMATCH')
        return bytes(data)
