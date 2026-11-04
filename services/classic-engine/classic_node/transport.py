"""Credentialed, origin-pinned control and binary transfers to the same center."""
import hashlib
import json
import re
import ssl
from time import monotonic
import httpx
from .protocol import ControlFailure, MAX_RESULT_BYTES, NodeFailure

PREFIX = '/internal/compute/v3'
INPUT_READ_SECONDS = 5
INPUT_PROGRESS_SECONDS = 10
INPUT_MIN_BYTES_PER_SECOND = 1024


def control_client(config, *, headers=None, transport=None, timeout=30):
    """Shared TLS/proxy policy; preflight uses this without node credentials."""
    verify = ssl.create_default_context(cafile=config['control_ca']) if config.get('control_ca') else True
    return httpx.Client(base_url=config['control_url'], trust_env=True, proxy=config.get('proxy_url'),
        follow_redirects=False, timeout=timeout, verify=verify, transport=transport, headers=headers)


class Transport:
    def __init__(self, config, *, control_transport=None):
        self.node_id = config['node_id']
        self.control = control_client(config, transport=control_transport,
            headers={'Authorization': 'Bearer ' + config['node_token'], 'X-Node-Id': self.node_id})

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

    def document_post(self, path, body):
        try:
            return self.reply(self.control.post('/internal/documents/compute/v2' + path, json=body))
        except httpx.HTTPError as error:
            raise self.network_error(error) from None

    @staticmethod
    def lease_path(lease_id, operation):
        if not isinstance(lease_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', lease_id):
            raise NodeFailure('INPUT_INVALID')
        return f'{PREFIX}/leases/{lease_id}/{operation}'

    def download(self, lease_id, token, metadata, check=lambda: None, *, partial=None):
        path = self.lease_path(lease_id, 'input')
        # A relative exact route prevents a compromised descriptor forwarding credentials.
        if metadata.get('path') != path:
            raise NodeFailure('INPUT_INVALID')
        limit = metadata['byte_size']
        if type(limit) is not int or limit <= 0:
            raise NodeFailure('INPUT_INVALID')
        data = bytearray() if partial is None else partial
        offset = len(data)
        if offset > limit:
            raise NodeFailure('INPUT_INVALID')
        check()
        # A separate timeout object leaves heartbeat, long-poll and upload policy intact.
        timeout = httpx.Timeout(self.control.timeout)
        timeout.read = min(timeout.read, INPUT_READ_SECONDS) if timeout.read is not None else INPUT_READ_SECONDS
        headers = {'Accept-Encoding': 'identity', 'X-Lease-Token': token}
        if offset:
            headers.update({'Range': f'bytes={offset}-', 'If-Range': f'"{metadata["sha256"]}"'})
        try:
            if offset == limit:
                # All declared bytes may have arrived before the connection reported failure.
                return self.verified_input(data, metadata)
            with self.control.stream('GET', path, headers=headers, timeout=timeout) as response:
                if response.status_code >= 300:
                    # Read only bounded error bytes so lease expiry still fences local work.
                    raw = bytearray()
                    started = monotonic()
                    for chunk in response.iter_bytes():
                        check()
                        raw.extend(chunk[:8192 - len(raw)])
                        if len(raw) == 8192 or monotonic() - started >= INPUT_READ_SECONDS:
                            break
                    self.checked(httpx.Response(response.status_code, content=bytes(raw)))
                if response.headers.get('content-encoding', 'identity').lower() != 'identity':
                    raise NodeFailure('INPUT_INVALID')
                if response.status_code == 206:
                    if not offset or response.headers.get('content-range') != f'bytes {offset}-{limit - 1}/{limit}':
                        raise NodeFailure('INPUT_INVALID')
                elif response.status_code == 200:
                    offset = 0  # Range ignored or If-Range changed: replace, never append.
                else:
                    raise ControlFailure('CONTROL_INVALID_RESPONSE')
                length = response.headers.get('content-length')
                if length is not None and length != str(limit - offset):
                    raise NodeFailure('INPUT_INVALID')
                if offset == 0:
                    data.clear()
                progress_at, progress_size = monotonic(), len(data)
                # Check cancellation and progress for each network fragment,
                # without waiting to fill an application-sized read buffer.
                for chunk in response.iter_bytes():
                    check()
                    if len(data) + len(chunk) > limit:
                        raise NodeFailure('INPUT_INVALID')
                    data.extend(chunk)
                    current = monotonic()
                    elapsed = current - progress_at
                    if elapsed >= INPUT_PROGRESS_SECONDS:
                        if len(data) < limit and len(data) - progress_size < elapsed * INPUT_MIN_BYTES_PER_SECOND:
                            raise ControlFailure('INPUT_DOWNLOAD_SLOW')
                        progress_at, progress_size = current, len(data)
        except httpx.HTTPError as error:
            raise self.network_error(error) from None
        if len(data) != limit:
            raise ControlFailure('INPUT_DOWNLOAD_INCOMPLETE')
        return self.verified_input(data, metadata)

    @staticmethod
    def verified_input(data, metadata):
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
        elif (result.get('representation') not in {'overlay-v1', 'overlay-tiles-v1'} or not isinstance(data, bytes) or not info
                or not 0 < len(data) <= MAX_RESULT_BYTES or len(data) != info['byte_size']
                or hashlib.sha256(data).hexdigest() != info['sha256'] or info['mime'] not in {'image/webp', 'application/vnd.nodelane.overlay-tiles'}):
            raise NodeFailure('INPUT_INVALID')
        files = {'metadata': (None, json.dumps(body, allow_nan=False), 'application/json')}
        if data is not None:
            files['output'] = ('overlay.webp' if info['mime'] == 'image/webp' else 'overlay.tiles', data, info['mime'])
        try:
            check()
            response = self.control.put(path, files=files)
            # A stable terminal receipt is valid even if the local timer expires in transit.
            return self.reply(response)
        except httpx.HTTPError as error:
            raise self.network_error(error) from None
