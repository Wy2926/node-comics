"""Read-only access to the self-hosted Logto Management API. Credentials stay server-side."""
from datetime import datetime, timezone
from functools import lru_cache
import json
from threading import Lock
import time
from urllib.parse import quote

import httpx

from .config import settings


class ProfileError(Exception):
    pass


def enabled():
    return bool(settings().logto_management_client_id)


def _read(client, method, url, **kwargs):
    try:
        with client.stream(method, url, **kwargs) as response:
            if response.status_code != 200:
                raise ProfileError({401: 'credentials', 403: 'permissions', 404: 'not_found',
                                    429: 'rate_limited'}.get(response.status_code, 'unavailable'))
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > 256 * 1024:
                    raise ProfileError('invalid_response')
            value = json.loads(body)
            if not isinstance(value, dict):
                raise ProfileError('invalid_response')
            return value
    except (httpx.HTTPError, ValueError):
        raise ProfileError('unavailable') from None


def timestamp(value):
    if value is None:
        return None
    if type(value) not in {int, float} or value < 0:
        raise ProfileError('invalid_response')
    try:
        return datetime.fromtimestamp(value / 1000, timezone.utc).replace(tzinfo=None)
    except (ValueError, OverflowError, OSError):
        raise ProfileError('invalid_response') from None


class LogtoProfiles:
    def __init__(self):
        self.lock = Lock()
        self.access_token = ''
        self.expires_at = 0

    def token(self, client):
        with self.lock:
            if self.access_token and time.monotonic() < self.expires_at:
                return self.access_token
            cfg = settings()
            try:
                result = _read(client, 'POST', cfg.oidc_token_endpoint,
                    auth=(cfg.logto_management_client_id, cfg.logto_management_client_secret.get_secret_value()),
                    data={'grant_type': 'client_credentials', 'resource': 'https://default.logto.app/api', 'scope': 'all'})
            except ProfileError as error:
                raise ProfileError('credentials' if str(error) == 'not_found' else str(error)) from None
            token, ttl = result.get('access_token'), result.get('expires_in')
            if (not isinstance(token, str) or not token or len(token) > 16384 or '\n' in token or '\r' in token
                    or str(result.get('token_type')).lower() != 'bearer'
                    or type(ttl) not in {int, float} or not 0 < ttl <= 86400):
                raise ProfileError('invalid_response')
            self.access_token, self.expires_at = token, time.monotonic() + max(0, ttl - 30)
            return token

    def fetch(self, user_id):
        # This project uses self-hosted Logto: /oidc issuer and /api share the same base.
        base = settings().oidc_issuer.removesuffix('/oidc').rstrip('/')
        with httpx.Client(timeout=5, follow_redirects=False) as client:
            for attempt in range(2):
                token = self.token(client)
                try:
                    data = _read(client, 'GET', f'{base}/api/users/{quote(user_id, safe="")}',
                                 headers={'Authorization': f'Bearer {token}'})
                    break
                except ProfileError as error:
                    if str(error) != 'credentials' or attempt:
                        raise
                    with self.lock:
                        if self.access_token == token:
                            self.access_token, self.expires_at = '', 0
        if data.get('id') != user_id or type(data.get('isSuspended')) is not bool:
            raise ProfileError('invalid_response')
        result = {'suspended': data['isSuspended'], 'auth_created_at': timestamp(data.get('createdAt')),
                  'last_sign_in_at': timestamp(data.get('lastSignInAt'))}
        for key, remote, limit in [('email', 'primaryEmail', 320), ('username', 'username', 128),
                                   ('name', 'name', 256), ('phone', 'primaryPhone', 64)]:
            value = data.get(remote)
            if value is not None and (not isinstance(value, str) or len(value) > limit):
                raise ProfileError('invalid_response')
            result[key] = value or None
        return result


@lru_cache(maxsize=1)
def client():
    return LogtoProfiles()
