"""Extended targets must survive capabilities, node reports and stage routing."""
import pytest
from fastapi import HTTPException
from app.config import settings
from app.db import session_factory
from app.languages import LANGUAGES, REDRAW_LANGUAGES
from app.models import Job
from app.providers import configuration, digest
from app.queue_models import ComputeNode
from test_node_management import provision, register
from test_cluster_scheduler import scheduler_case, add_job, claim
from test_classic import text_database
from conftest import login


def test_unknown_language_has_specific_code_before_admission(client):
    auth = login(client)
    from test_cluster_submissions import plan_item,manifest
    item=plan_item(manifest(1)[0],'unknown-language',target_language='xx')
    response=client.post('/v1/translation-plans',headers=auth,json={'trigger':'manual','items':[item]})
    assert response.status_code==422
    item.update(mode='redraw',target_language='pl',operation_key='mode-language')
    response=client.post('/v1/translation-plans',headers=auth,json={'trigger':'manual','items':[item]})
    assert response.status_code==200 and response.json()['items'][0]['code']=='LANGUAGE_UNSUPPORTED'
    response = client.post('/v1/admin/compute-nodes', headers=login(client,'admin'),
        json={'name':'invalid language','resource_id':'invalid:language','config':{'allowed_languages':['xx']}})
    assert response.status_code == 422 and response.json()['error']['code'] == 'LANGUAGE_UNSUPPORTED'


def test_capabilities_and_config_accept_every_classic_target(client, monkeypatch):
    monkeypatch.setenv('CLASSIC_ENABLED', 'true')
    settings.cache_clear()
    reply = client.get('/v1/capabilities').json()
    assert len(reply['languages']) == 16
    assert set(reply['modes'][0]['languages']) == set(LANGUAGES)
    assert reply['modes'][1]['languages'] == REDRAW_LANGUAGES
    with session_factory()() as db:
        for language in LANGUAGES:
            config = configuration(db, 'classic', language)
            assert config['engine'] == {'version': settings().classic_engine_version, 'protocol_version': 2}
        with pytest.raises(HTTPException):
            configuration(db, 'classic', 'xx')
        with pytest.raises(HTTPException):
            configuration(db, 'redraw', 'pl')
        old = {**config, 'engine': {'version': 'different-engine-version'}}
        assert digest(old) != digest(config)


def test_node_can_report_all_sixteen_languages(client):
    node, auth, admin = provision(client)
    from app.node_config import NodeConfig
    client.put(f"/v1/admin/compute-nodes/{node['node_id']}/config", headers=admin, json={'name': 'all', 'enabled': True, 'expected_version': 1, 'config': NodeConfig(allowed_languages=list(LANGUAGES)).model_dump()}).raise_for_status()
    result = register(client, auth, supported_languages=list(LANGUAGES))
    assert result.status_code == 200, result.text
    with session_factory()() as db:
        assert set(db.get(ComputeNode, node['node_id']).supported_languages) == set(LANGUAGES)


def test_extended_job_waits_for_matching_node_then_is_claimable(scheduler_case):
    job_id = add_job(scheduler_case, stage='page')
    with session_factory()() as db:
        db.get(Job, job_id).target_language = 'uk'
        db.commit()
    assert claim() is None
    with session_factory()() as db:
        db.get(ComputeNode, 'node-0').supported_languages = ['uk']
        db.commit()
    assert claim().job_id == job_id
