"""Creem REST v1. No retries for POSTs with unknown outcome."""
from datetime import datetime, timezone
import re
from urllib.parse import urlsplit
import httpx
from .config import settings
from .billing_providers import BillingError, require


def call(method, path, *, params=None, body=None):
    cfg = settings()
    require(cfg.creem_enabled, 'BILLING_DISABLED')
    base = 'https://test-api.creem.io/v1' if cfg.creem_environment == 'test' else 'https://api.creem.io/v1'
    try:
        response = httpx.request(method, base + path, params=params, json=body,
            headers={'x-api-key': cfg.creem_api_key.get_secret_value()}, timeout=20, follow_redirects=False)
        if not response.is_success:
            raise BillingError('CREEM_UNAVAILABLE', uncertain=response.status_code >= 500 or response.status_code in (408, 409, 429))
        value = response.json()
        require(isinstance(value, dict), 'CREEM_INVALID_RESPONSE')
        return value
    except (httpx.HTTPError, ValueError):
        raise BillingError('CREEM_UNAVAILABLE', uncertain=True) from None


def environment(value):
    require(isinstance(value, dict), 'CREEM_INVALID_RESPONSE')
    require(value.get('mode') == ('test' if settings().creem_environment == 'test' else 'prod'), 'CREEM_ENVIRONMENT_MISMATCH')


def object_id(value):
    return value.get('id') if isinstance(value, dict) else value


def timestamp(value):
    if value is None:
        return None
    try:
        if type(value) in (int, float):
            require(value > 0, 'CREEM_INVALID_TIMESTAMP')
            return datetime.fromtimestamp(value / 1000, timezone.utc).replace(tzinfo=None)
        require(isinstance(value, str), 'CREEM_INVALID_TIMESTAMP')
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(result.tzinfo is not None, 'CREEM_INVALID_TIMESTAMP')
        return result.astimezone(timezone.utc).replace(tzinfo=None)
    except (ValueError, OverflowError, OSError):
        raise BillingError('CREEM_INVALID_TIMESTAMP') from None


def approved_product(value, product_id, price, trial_days, *, active=True):
    environment(value)
    require(value.get('id') == product_id and value.get('price') == price.unit_amount
        and str(value.get('currency', '')).lower() == price.currency
        and value.get('billing_type') == 'recurring'
        and value.get('billing_period') == {'month': 'every-month', 'year': 'every-year'}[price.interval]
        and (value.get('trial_period_days') or 0) == trial_days and not value.get('trial_price')
        and (not active or value.get('status') == 'active'), 'CREEM_PLAN_MISMATCH')


def intent_id(value):
    metadata = value.get('metadata') or {}
    return metadata.get('checkout_intent_id') if metadata.get('app') == 'node_comics' else None


def hosted_url(value, portal=False):
    try:
        url = urlsplit(value or '')
        paths = ('/my-orders/login/', '/test/my-orders/login/') if portal else ('/checkout/', '/test/checkout/')
        require(url.scheme == 'https' and url.hostname in ('creem.io', 'www.creem.io')
            and url.path.startswith(paths) and not url.username and not url.password and url.port in (None, 443), 'CREEM_INVALID_URL')
    except ValueError:
        raise BillingError('CREEM_INVALID_URL') from None
    return value


def checkout_url(product_id, checkout_id):
    """Canonical hosted route, only for an independently verified checkout pair."""
    require(isinstance(product_id, str) and re.fullmatch(r'prod_[A-Za-z0-9]{1,250}', product_id)
        and isinstance(checkout_id, str) and re.fullmatch(r'ch_[A-Za-z0-9]{1,252}', checkout_id), 'CREEM_INVALID_URL')
    prefix = '/test/checkout/' if settings().creem_environment == 'test' else '/checkout/'
    return 'https://creem.io' + prefix + product_id + '/' + checkout_id
