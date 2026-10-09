"""Upgrade existing catalogs on both SQLite and PostgreSQL without stale CHECKs."""
from sqlalchemy import inspect, text
from test_job_results_migration import migrate
from test_request_limits_migration import isolated_migration_database  # noqa: F401


def test_classic_upgrade_replaces_reflected_interval_and_mode_checks(isolated_migration_database):
    engine = isolated_migration_database
    migrate(engine, 'text_plan_routing_0013')
    with engine.begin() as db:
        db.execute(text("INSERT INTO billing_plans (id,name,created_at) "
                        "VALUES ('legacy','Legacy',CURRENT_TIMESTAMP)"))
        db.execute(text("INSERT INTO billing_plan_revisions "
                        "(id,plan_id,version,name,monthly_redraw_pages,trial_days,trial_redraw_pages,created_at) "
                        "VALUES ('legacy-v1','legacy',1,'Legacy',300,0,0,CURRENT_TIMESTAMP)"))
    migrate(engine, 'head')
    with engine.begin() as db:
        assert db.scalar(text('SELECT version_num FROM alembic_version')) == 'subscription_customer_0016'
        assert tuple(db.execute(text("SELECT monthly_classic_pages,trial_classic_pages "
                                     "FROM billing_plan_revisions WHERE id='legacy-v1'")).one()) == (None, 0)
        db.execute(text("INSERT INTO billing_prices "
                        "(id,plan_id,plan_revision_id,environment,currency,unit_amount,interval,status,created_at) "
                        "VALUES ('quarter','legacy','legacy-v1','test','usd',666,'quarter','draft',CURRENT_TIMESTAMP)"))
    constraints = inspect(engine)
    for table, name in [('billing_prices', 'ck_billing_price_interval'),
                        ('quota_periods', 'ck_quota_periods_classic'),
                        ('quota_campaigns', 'ck_quota_campaigns_classic')]:
        checks = constraints.get_check_constraints(table)
        assert sum(check['name'] == name for check in checks) == 1
        if table != 'billing_prices':
            assert not any("'redraw'" in check['sqltext'] for check in checks)
    migrate(engine, 'head')
    with engine.connect() as db:
        assert db.scalar(text("SELECT count(*) FROM billing_prices WHERE id='quarter'")) == 1
