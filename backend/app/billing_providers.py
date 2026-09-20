"""Payment channel boundaries; catalog values are independent of provider IDs."""
from types import SimpleNamespace
from .config import settings


class BillingError(Exception):
    def __init__(self, code='BILLING_UNAVAILABLE', uncertain=False):
        self.code, self.uncertain = code, uncertain
        super().__init__(code)


def require(condition, code='BILLING_BINDING_MISMATCH'):
    if not condition:
        raise BillingError(code)


def provider_enabled(provider):
    return provider in ('stripe', 'creem') and getattr(settings(), provider + '_enabled')


def provider_environment(provider):
    require(provider in ('stripe', 'creem'), 'BILLING_PROVIDER_INVALID')
    return getattr(settings(), provider + '_environment')


def provider_config_json(provider):
    cfg = settings()
    return {'id': provider, 'provider': provider, 'label': {'stripe': 'Stripe', 'creem': 'Creem'}[provider],
        'enabled': provider_enabled(provider), 'environment': provider_environment(provider),
        'credential_configured': bool(getattr(cfg, 'stripe_secret_key' if provider == 'stripe' else 'creem_api_key').get_secret_value()),
        'webhook_configured': bool(getattr(cfg, provider + '_webhook_secret').get_secret_value()),
        'checkout_enabled': provider_enabled(provider)}


def resource_key(provider, value):
    require(isinstance(value, str) and 0 < len(value) <= 255 and ':' not in value)
    return f'{provider}:{provider_environment(provider)}:{value}'


def remote_id(value):
    return value.split(':', 2)[-1]


def stripe_quote(binding, price):
    return SimpleNamespace(environment=binding.environment, stripe_product_id=binding.product_id,
        stripe_price_id=binding.provider_price_id, currency=price.currency,
        unit_amount=price.unit_amount, interval=price.interval)


def approved_binding(binding, price, revision):
    require(provider_enabled(binding.provider), 'BILLING_DISABLED')
    require(binding.environment == provider_environment(binding.provider) == price.environment, 'BILLING_ENVIRONMENT_MISMATCH')
    if binding.provider == 'stripe':
        from . import stripe_client as stripe
        require(binding.provider_price_id and not binding.trial_product_id, 'STRIPE_PRICE_UNBOUND')
        value = stripe.call('prices', 'retrieve', binding.provider_price_id)
        stripe.approved_price(value, stripe_quote(binding, price))
        require(value.get('active'), 'BILLING_PLAN_UNAVAILABLE')
    else:
        from . import creem_client as creem
        require(not binding.provider_price_id, 'CREEM_PRICE_BINDING_INVALID')
        creem.approved_product(creem.call('GET', '/products/' + binding.product_id), binding.product_id, price, 0)
        if revision.trial_days:
            require(binding.trial_product_id, 'CREEM_TRIAL_PRODUCT_REQUIRED')
            creem.approved_product(creem.call('GET', '/products/' + binding.trial_product_id),
                binding.trial_product_id, price, revision.trial_days)
        else:
            require(not binding.trial_product_id, 'CREEM_TRIAL_PRODUCT_INVALID')
