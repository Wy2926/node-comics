"""Seed four verified Creem offers in the dedicated manual-test database only.

Run with the backend Python environment after ``python -m app.migrate``.
Configuration comes only from the process environment, never a repository .env.
Remote requests are product GETs; this script never creates payments or tokens.
"""
import logging
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
# Repository layout and /app/scripts bind mounts into the backend image.
sys.path[:0] = [str(ROOT / 'backend'), str(ROOT)]

DATABASE_NAME = 'nodecomics_creem_manual_test'
SYSTEM_SUBJECT = 'system:creem-manual-test-catalog'
QUOTES = {
    'MONTH': ('creem-test-lite-month-v1', 'creem-test-lite-v1', 'month', 599),
    'YEAR': ('creem-test-lite-year-v1', 'creem-test-lite-v1', 'year', 5999),
    'PERMANENT': ('creem-test-permanent-price-v1', 'creem-test-permanent-v1', 'once', 599),
    'EXPIRING': ('creem-test-expiring-price-v1', 'creem-test-expiring-v1', 'once', 599),
}


class SeedError(Exception):
    """Only fixed, non-sensitive diagnostic codes may reach the CLI."""


def require_environment(config):
    from sqlalchemy.engine import make_url
    if config.app_env != 'test' or config.dev_auth or not config.creem_enabled or config.creem_environment != 'test':
        raise SeedError('CREEM_TEST_ENVIRONMENT_REQUIRED')
    target = make_url(config.database_url)
    if target.get_backend_name() != 'postgresql' or target.database != DATABASE_NAME:
        raise SeedError('CREEM_TEST_DATABASE_REQUIRED')


def product_ids(environ):
    result = {key: environ.get(f'CREEM_TEST_{key}_PRODUCT_ID', '') for key in QUOTES}
    if any(not re.fullmatch(r'prod_[A-Za-z0-9]{1,250}', value) for value in result.values()):
        raise SeedError('CREEM_TEST_PRODUCT_IDS_REQUIRED')
    if len(set(result.values())) != len(QUOTES):
        raise SeedError('CREEM_TEST_PRODUCT_IDS_MUST_DIFFER')
    return result


def require_database(connection):
    from sqlalchemy import text
    # The live database name also catches connection-string query overrides.
    if connection.dialect.name != 'postgresql' or connection.scalar(text('SELECT current_database()')) != DATABASE_NAME:
        raise SeedError('CREEM_TEST_DATABASE_REQUIRED')
    from app.runtime import check_schema
    from app.db import check_payment_environment
    check_schema(connection)
    check_payment_environment(connection)


def seed_catalog(db, ids):
    from sqlalchemy import select
    from app import billing_catalog as catalog, creem_client as creem
    from app.billing_models import BillingPrice, BillingPriceBinding, BillingSettings
    from app.models import User

    # Verify every remote item before even creating the local audit actor.
    for key, (_, _, interval, amount) in QUOTES.items():
        remote = creem.call('GET', '/products/' + ids[key])
        if not isinstance(remote, dict) or remote.get('object') != 'product' or type(remote.get('price')) is not int:
            raise SeedError('CREEM_TEST_PRODUCT_INVALID')
        creem.approved_product(remote, ids[key], SimpleNamespace(unit_amount=amount, currency='usd', interval=interval), 0)

    catalog.lock_catalog(db)
    if db.get(BillingSettings, 1) is None:
        raise SeedError('CREEM_TEST_MIGRATION_REQUIRED')
    actor = db.scalar(select(User).where(User.subject == SYSTEM_SUBJECT))
    if actor is None:
        # No issuer separator and no admin role: this record is only an audit identity.
        actor = User(subject=SYSTEM_SUBJECT, name='Creem manual-test catalog seed', role='user')
        db.add(actor)
        db.flush()
    elif actor.kind != 'registered' or actor.role != 'user':
        raise SeedError('CREEM_TEST_AUDIT_ACTOR_CONFLICT')

    benefits = dict(monthly_classic_pages=None, hourly_image_limit=1200, trial_days=0, trial_classic_pages=0)
    for product in (
        dict(id='lite', revision_id='creem-test-lite-v1', name='Lite'),
        dict(id='creem-test-permanent', revision_id='creem-test-permanent-v1', name='100 页额度包（不过期）',
             service_plan_id='lite', quota_pages=100, quota_validity_days=None),
        dict(id='creem-test-expiring', revision_id='creem-test-expiring-v1', name='50 页额度包（30 天）',
             service_plan_id='lite', quota_pages=50, quota_validity_days=30),
    ):
        catalog.create_product(catalog.ProductRequest(**{**benefits, **product,
            "monthly_classic_pages": 0 if product.get("quota_pages") else None}), db=db, actor=actor)

    for key, (price_id, revision_id, interval, amount) in QUOTES.items():
        binding_id = 'creem-test-' + key.lower() + '-binding-v1'
        catalog.create_price(catalog.PriceRequest(id=price_id, plan_revision_id=revision_id,
            environment='test', currency='usd', unit_amount=amount, interval=interval), db=db, actor=actor)
        catalog.create_binding(price_id, catalog.BindingRequest(id=binding_id, provider='creem',
            environment='test', product_id=ids[key]), db=db, actor=actor)
        binding, price = db.get(BillingPriceBinding, binding_id), db.get(BillingPrice, price_id)
        if binding.status == 'archived' or price.status == 'archived':
            raise SeedError('CREEM_TEST_ARCHIVED_OFFER_CONFLICT')
        # Real publication checks are retained. An unchanged rerun writes no extra audit rows.
        if binding.status != 'active':
            catalog.publish_binding(binding_id, catalog.PriceState(status='active'), db=db, actor=actor)
        if price.status != 'active':
            catalog.publish_price(price_id, catalog.PriceState(status='active'), db=db, actor=actor)
    if catalog.default_provider(db) != 'creem':
        catalog.set_default_provider(catalog.DefaultProviderRequest(provider='creem'), db=db, actor=actor)
    db.commit()


def main():
    logging.disable(logging.CRITICAL)
    try:
        from app.config import Settings, settings
        Settings.model_config['env_file'] = None
        settings.cache_clear()
        require_environment(settings())
        ids = product_ids(os.environ)
        from sqlalchemy.orm import Session
        from app.db import engine
        with engine().begin() as connection:
            require_database(connection)
            # Existing catalog handlers commit; savepoints keep the whole seed atomic.
            with Session(bind=connection, expire_on_commit=False, join_transaction_mode='create_savepoint') as db:
                seed_catalog(db, ids)
    except Exception as error:
        code = error.args[0] if isinstance(error, SeedError) else 'CREEM_TEST_SEED_FAILED'
        print(code, file=sys.stderr)
        return 1
    print('Creem test catalog ready: four verified offers; no payments or tokens created.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
