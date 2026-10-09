"""Manual-test catalog bootstrap: mocked provider reads, no real service calls."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'seed_creem_test_catalog.py'
spec = importlib.util.spec_from_file_location('seed_creem_test_catalog', SCRIPT)
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


def config(**changes):
    return SimpleNamespace(**dict(app_env='test', dev_auth=False, creem_enabled=True, creem_environment='test',
        database_url='postgresql+psycopg://user:private@postgres/' + seed.DATABASE_NAME) | changes)


@pytest.mark.parametrize('changes', [
    {'app_env': 'production'}, {'app_env': 'development'}, {'dev_auth': True},
    {'creem_enabled': False}, {'creem_environment': 'live'},
    {'database_url': 'sqlite:///' + seed.DATABASE_NAME},
    {'database_url': 'postgresql+psycopg://user:private@postgres/nodecomics'},
    {'database_url': 'postgresql+psycopg://user:private@postgres/' + seed.DATABASE_NAME + '_copy'},
])
def test_environment_guard_rejects_other_targets(changes):
    with pytest.raises(seed.SeedError):
        seed.require_environment(config(**changes))


def test_environment_guard_accepts_only_named_test_database():
    seed.require_environment(config())


def test_live_database_name_guard_rejects_query_override():
    connection = SimpleNamespace(dialect=SimpleNamespace(name='postgresql'), scalar=lambda query: 'nodecomics_production')
    with pytest.raises(seed.SeedError, match='CREEM_TEST_DATABASE_REQUIRED'):
        seed.require_database(connection)


def environment_ids():
    return {f'CREEM_TEST_{key}_PRODUCT_ID': 'prod_' + key.lower() for key in seed.QUOTES}


@pytest.mark.parametrize('change', ['missing', 'duplicate', 'path'])
def test_product_ids_are_complete_distinct_and_not_paths(change):
    values = environment_ids()
    if change == 'missing':
        values.pop('CREEM_TEST_YEAR_PRODUCT_ID')
    else:
        values['CREEM_TEST_YEAR_PRODUCT_ID'] = values['CREEM_TEST_MONTH_PRODUCT_ID'] if change == 'duplicate' else 'prod_/secret'
    with pytest.raises(seed.SeedError):
        seed.product_ids(values)


@pytest.fixture
def catalog_fixture(request, monkeypatch):
    for key, value in {'CREEM_ENABLED': 'true', 'CREEM_ENVIRONMENT': 'test', 'CREEM_API_KEY': 'creem_test_fixture',
            'CREEM_WEBHOOK_SECRET': 'isolated-webhook', 'CREEM_RETURN_URL': 'https://test.example/account/',
            'STRIPE_ENABLED': 'false'}.items():
        monkeypatch.setenv(key, value)
    request.getfixturevalue('client')
    from app import creem_client
    ids = seed.product_ids(environment_ids())
    products = {ids[key]: {'id': ids[key], 'object': 'product', 'mode': 'test', 'status': 'active',
        'price': amount, 'currency': 'USD', 'billing_type': 'onetime' if interval == 'once' else 'recurring',
        'billing_period': {'month': 'every-month', 'year': 'every-year', 'once': 'once'}[interval]}
        for key, (_, _, interval, amount) in seed.QUOTES.items()}
    calls = []

    def read_product(method, path, **kwargs):
        assert method == 'GET' and not kwargs
        calls.append((method, path))
        return dict(products[path.removeprefix('/products/')])

    monkeypatch.setattr(creem_client, 'call', read_product)
    return ids, products, calls


@pytest.mark.parametrize('mutation', [
    {'object': 'checkout'}, {'mode': 'prod'}, {'status': 'archived'}, {'price': 599.0}, {'price': 598},
    {'currency': 'EUR'}, {'billing_type': 'recurring'}, {'billing_period': 'every-month'}, {'trial_period_days': 7},
])
def test_all_remote_products_are_verified_before_local_writes(catalog_fixture, mutation):
    from app.billing_models import BillingPlan
    from app.billing_providers import BillingError
    from app.db import session_factory
    from app.models import User
    ids, products, calls = catalog_fixture
    products[ids['EXPIRING']].update(mutation)
    with session_factory()() as db:
        with pytest.raises((seed.SeedError, BillingError)):
            seed.seed_catalog(db, ids)
        assert db.get(BillingPlan, 'lite') is None
        assert db.scalar(select(User).where(User.subject == seed.SYSTEM_SUBJECT)) is None
    assert len(calls) == 4


def test_seed_is_idempotent_and_keeps_order_history(catalog_fixture):
    from app.admin_audit import AdminAudit
    from app.billing_catalog import offers
    from app.billing_models import BillingOrder, BillingPlanRevision, BillingPrice, BillingPriceBinding
    from app.db import session_factory
    from app.models import User
    ids, products, calls = catalog_fixture
    with session_factory()() as db:
        seed.seed_catalog(db, ids)
        actor = db.scalar(select(User).where(User.subject == seed.SYSTEM_SUBJECT))
        assert actor.role == 'user' and '|' not in actor.subject
        subscriptions, packs = offers(db), offers(db, interval='once')
        assert {(item['interval'], item['unit_amount']) for item in subscriptions} == {('month', 599), ('year', 5999)}
        assert {(item['quota_pages'], item['quota_validity_days']) for item in packs} == {(100, None), (50, 30)}
        assert all(item['service_plan_id'] == 'lite' and item['unit_amount'] == 599 for item in packs)
        assert all(item['hourly_image_limit'] == 1200 and not item['trial_days'] and not item['monthly_redraw_pages']
            for item in subscriptions + packs)
        order = BillingOrder(id='existing-order', owner_id=actor.id, provider='creem', environment='test',
            kind='initial', status='paid', price_id=seed.QUOTES['PERMANENT'][0],
            binding_id='creem-test-permanent-binding-v1', currency='usd', total=599, subtotal=599,
            refunded_total=0, external_id='ord_original')
        db.add(order)
        db.commit()
        models = (User, AdminAudit, BillingPlanRevision, BillingPrice, BillingPriceBinding, BillingOrder)
        counts = [db.scalar(select(func.count()).select_from(model)) for model in models]
        original_order = {column.name: getattr(order, column.name) for column in BillingOrder.__table__.columns}
        assert len(calls) == 12
        seed.seed_catalog(db, ids)
        db.refresh(order)
        assert [db.scalar(select(func.count()).select_from(model)) for model in models] == counts
        assert {column.name: getattr(order, column.name) for column in BillingOrder.__table__.columns} == original_order
    assert len(calls) == 16


def test_outer_transaction_rolls_back_handler_commits(catalog_fixture, monkeypatch):
    from app import billing_catalog
    from app.billing_models import BillingPlan
    from app.db import engine, session_factory
    from app.models import User
    from sqlalchemy.orm import Session
    ids, _, _ = catalog_fixture
    publish = billing_catalog.publish_price

    def fail_after_first_offer(price_id, *args, **kwargs):
        if price_id == seed.QUOTES['YEAR'][0]:
            raise seed.SeedError('SIMULATED_PUBLICATION_FAILURE')
        return publish(price_id, *args, **kwargs)

    monkeypatch.setattr(billing_catalog, 'publish_price', fail_after_first_offer)
    with engine().connect() as connection:
        # Python's SQLite legacy mode otherwise defers BEGIN until after SAVEPOINT.
        connection.exec_driver_sql('BEGIN')
        with Session(bind=connection, expire_on_commit=False, join_transaction_mode='create_savepoint') as db:
            with pytest.raises(seed.SeedError, match='SIMULATED_PUBLICATION_FAILURE'):
                seed.seed_catalog(db, ids)
        connection.rollback()
    with session_factory()() as db:
        assert db.get(BillingPlan, 'lite') is None
        assert db.scalar(select(User).where(User.subject == seed.SYSTEM_SUBJECT)) is None


def test_cli_failure_does_not_print_exception_or_secrets(monkeypatch, capsys):
    secret = 'private-database-url-and-api-key'

    def fail(_config):
        raise RuntimeError(secret)

    monkeypatch.setattr(seed, 'require_environment', fail)
    monkeypatch.setattr(seed.logging, 'disable', lambda level: None)
    from app.config import Settings, settings
    monkeypatch.setattr(Settings, 'model_config', {**Settings.model_config, 'env_file': None})
    settings.cache_clear()
    assert seed.main() == 1
    output = capsys.readouterr()
    assert output.err.strip() == 'CREEM_TEST_SEED_FAILED' and not output.out
    assert secret not in output.err
