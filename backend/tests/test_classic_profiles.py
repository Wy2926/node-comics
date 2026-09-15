"""An AMD execution profile must never reuse a result from another runtime."""
from app.classic_config import snapshot
from app.config import settings
from app.providers import digest


def test_directml_changes_cache_identity_without_downgrading_models(client, monkeypatch):
    monkeypatch.setenv('CLASSIC_ENABLED', 'true')
    monkeypatch.setenv('CLASSIC_ENGINE_PROFILE', 'mit')
    settings.cache_clear()
    cpu = snapshot()
    monkeypatch.setenv('CLASSIC_ENGINE_PROFILE', 'mit-directml')
    settings.cache_clear()
    amd = snapshot()
    assert digest(cpu) != digest(amd)
    assert amd['engine']['version'] == 'mit-95227a2-classic-v4-dml-v1'
    assert {k: v for k, v in cpu['engine'].items() if k != 'version'} == {
        k: v for k, v in amd['engine'].items() if k != 'version'}
    assert amd['text'] == cpu['text']
    settings.cache_clear()
