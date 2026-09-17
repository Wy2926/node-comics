"""Small Billing API client; credentials and upstream bodies never enter errors."""
import hashlib
import hmac
import re
import time
from urllib.parse import urlencode
import httpx
from .config import settings


class PaddleError(Exception):
    def __init__(self, code='PADDLE_UNAVAILABLE', uncertain=False):
        super().__init__(code)
        self.code, self.uncertain = code, uncertain


def _request(method, path, body=None):
    cfg = settings()
    if not cfg.paddle_enabled:
        raise PaddleError('BILLING_DISABLED')
    base = 'https://sandbox-api.paddle.com' if cfg.paddle_environment == 'sandbox' else 'https://api.paddle.com'
    if not path.startswith('/') or path.startswith('//'):
        raise PaddleError('PADDLE_INVALID_PATH')
    try:
        with httpx.Client(timeout=15, follow_redirects=False) as client:
            response = client.request(method, base + path, json=body,
                headers={'Authorization': 'Bearer ' + cfg.paddle_api_key.get_secret_value(),
                         'Paddle-Version': '1', 'User-Agent': 'NodeComics/0.3'})
    except httpx.HTTPError:
        raise PaddleError(uncertain=method != 'GET') from None
    if not response.is_success:
        try:
            code = response.json()['error']['code']
        except (ValueError, KeyError, TypeError):
            code = 'upstream_error'
        code = code if isinstance(code, str) and re.fullmatch(r'[a-z_]{1,60}', code) else 'upstream_error'
        raise PaddleError('PADDLE_' + code.upper(), uncertain=method != 'GET' and response.status_code >= 500)
    try:
        value = response.json()
        if not isinstance(value, dict) or not isinstance(value.get('data'), (dict, list)):
            raise ValueError()
        return value
    except ValueError:
        raise PaddleError(uncertain=method != 'GET') from None


def request(method, path, body=None):
    data = _request(method, path, body)['data']
    if not isinstance(data, dict):
        raise PaddleError(uncertain=method != 'GET')
    return data


def transaction_pages(**filters):
    """Keep filters across cursor pages; never follow an upstream URL with credentials."""
    params = {'per_page': 30, 'order_by': 'id[ASC]', **filters}
    while True:
        value = _request('GET', '/transactions?' + urlencode(params))
        rows = value['data']
        meta = value.get('meta')
        pagination = meta.get('pagination') if isinstance(meta, dict) else None
        more = pagination.get('has_more') if isinstance(pagination, dict) else None
        if not isinstance(rows, list) or not isinstance(more, bool):
            raise PaddleError('PADDLE_INVALID_PAGINATION')
        if more:
            cursor = rows[-1].get('id') if rows and isinstance(rows[-1], dict) else None
            previous = params.get('after')
            if (not isinstance(cursor, str) or not re.fullmatch(r'txn_[a-z0-9]{26}', cursor)
                    or (previous and cursor <= previous)):
                raise PaddleError('PADDLE_INVALID_PAGINATION')
            params['after'] = cursor
        yield rows
        if not more:
            return


def valid_signature(body, header, secret, at=None):
    if not secret or len(header) > 4096:
        return False
    fields = {}
    for part in header.split(';'):
        key, separator, value = part.strip().partition('=')
        if separator:
            fields.setdefault(key, []).append(value)
    stamps = fields.get('ts', [])
    if len(stamps) != 1 or not re.fullmatch(r'[0-9]{1,12}', stamps[0]):
        return False
    if abs((time.time() if at is None else at) - int(stamps[0])) > 300:
        return False
    expected = hmac.new(secret.encode(), stamps[0].encode() + b':' + body, hashlib.sha256).hexdigest()
    return any(re.fullmatch(r'[a-f0-9]{64}', digest) and hmac.compare_digest(expected, digest)
               for digest in fields.get('h1', []))
