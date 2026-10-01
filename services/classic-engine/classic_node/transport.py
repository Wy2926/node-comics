"""Credentialed, origin-pinned control and binary transfers to the same center."""
import hashlib
import json
import re
import ssl
import httpx
from .protocol import ControlFailure, MAX_RESULT_BYTES, NodeFailure

PREFIX = '/internal/compute/v3'


class Transport:
    def __init__(self, config, *, control_transport=None):
        self.node_id = config['node_id']
        verify = ssl.create_default_context(cafile=config['control_ca']) if config.get('control_ca') else True
        self.control = httpx.Client(base_url=config['control_url'], trust_env=False, follow_redirects=False,
            timeout=30, verify=verify, transport=control_transport, headers={'Authorization': 'Bearer ' + config['node_token'],
                                                           'X-Node-Id': self.node_id})

    def close(self):
        self.control.close()

    @staticmethod
    def checked(response):
        if response.status_code >= 300:
            code = 'CONTROL_REJECTED'
            try:
                candidate = response.json().get('error', {}).get('code', '')
                if re.fullmatch(r'[A-Z_]{1,80}', candidate):
                    code = candidate
            except (ValueError, AttributeError, TypeError, httpx.ResponseNotRead):
                pass
            raise ControlFailure(code, response.status_code)
        return response

    @staticmethod
    def network_error(error):
        failure = ControlFailure('CONTROL_UNAVAILABLE')
        failure.cause = type(error).__name__
        return failure

    @classmethod
    def reply(cls, response):
        cls.checked(response)
        try:
            return response.json()
        except ValueError:
            raise ControlFailure('CONTROL_INVALID_RESPONSE') from None

    def post(self, path, body):
        try:
            return self.reply(self.control.post(PREFIX + path, json=body))
        except httpx.HTTPError as error:
            raise self.network_error(error) from None

    @staticmethod
    def lease_path(lease_id, operation):
        if not isinstance(lease_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', lease_id):
            raise NodeFailure('INPUT_INVALID')
        return f'{PREFIX}/leases/{lease_id}/{operation}'

    def download(self, lease_id, token, metadata, check=lambda: None):
        path = self.lease_path(lease_id, 'input')
        # A relative exact route prevents a compromised descriptor forwarding credentials.
        if metadata.get('path') != path:
            raise NodeFailure('INPUT_INVALID')
        limit = metadata['byte_size']
        if type(limit) is not int or limit <= 0:
            raise NodeFailure('INPUT_INVALID')
        try:
            check()
            with self.control.stream('GET', path, headers={'Accept-Encoding': 'identity', 'X-Lease-Token': token}) as response:
                if response.status_code >= 300:
                    # Read only bounded error bytes so lease expiry still fences local work.
                    raw = bytearray()
                    for chunk in response.iter_bytes(4096):
                        raw.extend(chunk)
                        if len(raw) > 8192:
                            break
                    self.checked(httpx.Response(response.status_code, content=bytes(raw[:8192])))
                if response.status_code != 200:
                    raise ControlFailure('CONTROL_INVALID_RESPONSE')
                data = bytearray()
                for chunk in response.iter_bytes(64 * 1024):
                    check()
                    data.extend(chunk)
                    if len(data) > limit:
                        raise NodeFailure('INPUT_INVALID')
        except httpx.HTTPError as error:
            raise self.network_error(error) from None
        if len(data) != limit:
            raise NodeFailure('INPUT_INVALID')
        if hashlib.sha256(data).hexdigest() != metadata['sha256']:
            raise NodeFailure('INPUT_HASH_MISMATCH')
        return bytes(data)

    def deliver(self, lease_id, body, data, check=lambda: None):
        path = self.lease_path(lease_id, 'result')
        result = body['result']
        info = result.get('output')
        if result.get('representation') == 'original':
            if data is not None or info is not None or result.get('bbox') is not None:
                raise NodeFailure('INPUT_INVALID')
        elif (result.get('representation') != 'overlay-v1' or not isinstance(data, bytes) or not info
                or not 0 < len(data) <= MAX_RESULT_BYTES or len(data) != info['byte_size']
                or hashlib.sha256(data).hexdigest() != info['sha256'] or info['mime'] != 'image/webp'):
            raise NodeFailure('INPUT_INVALID')
        files = {'metadata': (None, json.dumps(body, allow_nan=False), 'application/json')}
        if data is not None:
            files['output'] = ('overlay.webp', data, 'image/webp')
        try:
            check()
            response = self.control.put(path, files=files)
            # A stable terminal receipt is valid even if the local timer expires in transit.
            return self.reply(response)
        except httpx.HTTPError as error:
            raise self.network_error(error) from None
