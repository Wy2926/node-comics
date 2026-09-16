"""An AMD execution profile must never reuse a result from another runtime."""
from app.classic_config import snapshot
from app.config import settings
from app.db import session_factory
from app.providers import digest


def test_directml_changes_cache_identity_without_downgrading_models(client, monkeypatch):
    monkeypatch.setenv('CLASSIC_ENABLED', 'true')
    monkeypatch.setenv('CLASSIC_ENGINE_VERSION', 'mit-95227a2-classic-v5-cluster')
    settings.cache_clear()
    with session_factory()() as db:
        cpu = snapshot(db)
    monkeypatch.setenv('CLASSIC_ENGINE_VERSION', 'mit-95227a2-classic-v4-dml-v4')
    settings.cache_clear()
    with session_factory()() as db:
        amd = snapshot(db)
    assert digest(cpu) != digest(amd)
    assert amd['engine']['version'] == 'mit-95227a2-classic-v4-dml-v4'
    for version in ('mit-95227a2-classic-v4-dml-v1', 'mit-95227a2-classic-v4-dml-v2', 'mit-95227a2-classic-v4-dml-v3'):
        old = {**amd, 'engine': {**amd['engine'], 'version': version}}
        assert digest(old) != digest(amd)
    old_render = {**amd, 'engine': {**amd['engine'], 'render_version': 'masked-png-v1'}}
    assert digest(old_render) != digest(amd)
    assert {k: v for k, v in cpu['engine'].items() if k != 'version'} == {
        k: v for k, v in amd['engine'].items() if k != 'version'}
    assert amd['text'] == cpu['text']
    settings.cache_clear()
