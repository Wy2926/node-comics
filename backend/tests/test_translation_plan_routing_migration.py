"""Existing providers and immutable model versions survive the routing upgrade."""
from sqlalchemy import MetaData, Table, select
from sqlalchemy.orm import Session

from app.models import now
from app.translation_models import TranslationProvider, TranslationProviderRevision
from test_job_results_migration import migrate
from test_request_limits_migration import isolated_migration_database  # noqa: F401


def test_existing_providers_remain_unrestricted(isolated_migration_database):
    engine = isolated_migration_database
    migrate(engine, 'asset_mime_0012')
    with engine.begin() as connection:
        legacy = Table('translation_providers', MetaData(), autoload_with=connection)
        connection.execute(legacy.insert(), {'id': 'supplier', 'name': 'Existing', 'channel': 'openai',
            'enabled': True, 'text_weight': 3, 'title_weight': 1, 'requests_per_minute': 60,
            'revision_id': 'revision', 'created_at': now(), 'updated_at': now()})
        connection.execute(TranslationProviderRevision.__table__.insert(), {'id': 'revision',
            'provider_id': 'supplier', 'channel': 'openai', 'config': {'model': 'original'},
            'api_key': 'isolated-key', 'created_at': now()})
    migrate(engine, 'head')
    with Session(engine) as db:
        provider = db.get(TranslationProvider, 'supplier')
        assert provider.text_plan_ids is None and provider.text_weight == 3 and provider.title_weight == 1
        assert provider.revision_id == 'revision'
        revision = db.get(TranslationProviderRevision, provider.revision_id)
        assert revision.config == {'model': 'original'} and revision.api_key == 'isolated-key'
        provider.text_plan_ids = ['free', 'plus']
        db.commit()
        assert db.scalar(select(TranslationProvider.text_plan_ids)) == ['free', 'plus']
