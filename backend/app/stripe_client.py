"""Official Stripe SDK; only hosted Checkout and Customer Portal URLs leave here."""
from urllib.parse import urlsplit
import stripe
from .config import settings
from .billing_providers import BillingError, require

stripe.enable_telemetry = False


def client():
    cfg = settings()
    require(cfg.stripe_enabled, 'BILLING_DISABLED')
    return stripe.StripeClient(cfg.stripe_secret_key.get_secret_value(),
        http_client=stripe.RequestsClient(timeout=20), max_network_retries=1)


def call(resource, action, *args, **kwargs):
    api = client().v1
    for part in resource.split('.'):
        api = getattr(api, part)
    try:
        return getattr(api, action)(*args, **kwargs).to_dict()
    except stripe.StripeError as exc:
        uncertain = isinstance(exc, (stripe.APIConnectionError, stripe.APIError, stripe.IdempotencyError))
        raise BillingError(uncertain=uncertain) from None


def pages(resource, *args, **params):
    cursor = None
    while True:
        result = call(resource, 'list', *args, params={**params, 'limit': 100,
            **({'starting_after': cursor} if cursor else {})})
        rows = result.get('data')
        require(isinstance(rows, list) and isinstance(result.get('has_more'), bool), 'STRIPE_INVALID_PAGINATION')
        yield rows
        if not result['has_more']:
            return
        require(rows and rows[-1].get('id') and rows[-1]['id'] != cursor, 'STRIPE_INVALID_PAGINATION')
        cursor = rows[-1]['id']


def hosted_url(value, portal=False):
    url = urlsplit(value or '')
    require(url.scheme == 'https' and url.hostname == ('billing.stripe.com' if portal else 'checkout.stripe.com')
        and not url.username and not url.password and url.port in (None, 443), 'STRIPE_INVALID_URL')
    return value


def environment(resource):
    require(resource.get('livemode') is (settings().stripe_environment == 'live'), 'STRIPE_ENVIRONMENT_MISMATCH')


def approved_price(price, expected):
    environment(price)
    recurring = price.get('recurring') or {}
    require(expected.environment == settings().stripe_environment and price.get('id') == expected.stripe_price_id
        and price.get('product') == expected.stripe_product_id and price.get('currency') == expected.currency
        and price.get('unit_amount') == expected.unit_amount and recurring.get('interval') == expected.interval
        and recurring.get('interval_count') == 1 and recurring.get('usage_type') == 'licensed', 'STRIPE_PLAN_MISMATCH')


def intent_id(resource):
    metadata = resource.get('metadata') or {}
    return metadata.get('checkout_intent_id') if metadata.get('app') == 'node_comics' else None
