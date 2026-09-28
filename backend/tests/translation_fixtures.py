"""Explicit DB text suppliers for isolated tests; never use environment credentials."""


def configure_text_provider(db, provider_id=None, **config):
    """Create a supplier or save a new revision, under the real scheduler lock."""
    from app.scheduler import lock_scheduler
    from app.translation_models import TranslationProvider, TranslationProviderRevision
    from app.translation_providers import ProviderWrite, write_provider

    lock_scheduler(db)
    provider = db.get(TranslationProvider, provider_id) if provider_id else None
    if provider_id:
        assert provider is not None, 'The isolated text supplier must already exist'
    previous = db.get(TranslationProviderRevision, provider.revision_id) if provider else None
    body = ProviderWrite(
        name=provider.name if provider else 'Isolated test text provider',
        channel='openai', enabled=provider.enabled if provider else True,
        text_weight=provider.text_weight if provider else 1,
        title_weight=provider.title_weight if provider else 1,
        requests_per_minute=config.pop('requests_per_minute', provider.requests_per_minute if provider else 60),
        config={**(previous.config if previous else {
            'model': 'test-model', 'base_url': 'https://text.example/v1'}), **config},
        api_key=None if previous else 'isolated-test-text-key',
    )
    provider = write_provider(db, body, provider)
    db.commit()
    return provider
