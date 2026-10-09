"""Live shared capacities, persistence, authorization and lease-safe shrink."""
import pytest
from conftest import login, login_plus, upload, create, png_variant
from app.control_pools import initialize_pools, report_pools
from app.db import session_factory
from app.queue_models import ComputeNode, ExecutionLease
from app.scheduler import claim_stage


@pytest.mark.parametrize('stage,slots', [('text', 17), ('validate_upload', 7)])
def test_capacity_is_editable_and_worker_restart_preserves_it(client, stage, slots):
    path = f'/v1/admin/compute-nodes/control-{stage}/config'
    admin = login(client, 'admin')
    body = {'name': stage, 'enabled': False, 'expected_version': 1, 'config': {'execution_slots': slots}}
    assert client.put(path, headers=login(client), json=body).status_code == 403
    result = client.put(path, headers=admin, json=body)
    assert result.status_code == 200, result.text
    assert client.put(path, headers=admin, json=body).status_code == 409
    with session_factory()() as db:
        initialize_pools(db); report_pools(db)
        node = db.get(ComputeNode, 'control-' + stage)
        assert node.capacity == slots and not node.enabled and node.heartbeat_at
        assert node.applied_config_version == node.config_version == 2
    assert client.get(path, headers=admin).json()['config'] == {'execution_slots': slots}


@pytest.mark.parametrize('stage,config', [('text', {'execution_slots': True}), ('text', {'execution_slots': 101}),
    ('validate_upload', {'execution_slots': 33}), ('text', {'execution_slots': 0}),
    ('text', {'execution_slots': 2, 'engine': {}})])
def test_pool_schema_rejects_invalid_or_image_only_configuration(client, stage, config):
    result = client.put(f'/v1/admin/compute-nodes/control-{stage}/config', headers=login(client,'admin'),
        json={'name': stage, 'enabled': True, 'expected_version': 1, 'config': config})
    assert result.status_code == 422 and result.json()['error']['code'] == 'NODE_CONFIG_INVALID'


def test_shrink_keeps_inflight_lease_and_blocks_new_claims(client, png):
    auth, admin = login_plus(client), login(client,'admin')
    asset = upload(client,auth,png)
    create(client,auth,asset,key='first')
    second = create(client,auth,upload(client,auth,png_variant(png,1)),key='second').json()['id']
    with session_factory()() as db:
        from app.queue_models import JobStage
        from sqlalchemy import select
        for stage in db.scalars(select(JobStage).where(JobStage.name == 'page')):
            stage.name = 'validate_upload'
        db.flush()
        first = claim_stage(db,'control-validate_upload')
        db.commit()
        assert first
        lease_id = first.id
    result = client.put('/v1/admin/compute-nodes/control-validate_upload/config',headers=admin,
        json={'name':'validate_upload','enabled':True,'expected_version':1,'config':{'execution_slots':1}})
    assert result.status_code == 200
    with session_factory()() as db:
        assert db.get(ExecutionLease,lease_id).completed_at is None
        assert claim_stage(db,'control-validate_upload') is None
        db.commit()
    # Growing the same live pool allows the waiting page without a restart.
    assert client.put('/v1/admin/compute-nodes/control-validate_upload/config',headers=admin,
        json={'name':'validate_upload','enabled':True,'expected_version':2,'config':{'execution_slots':2}}).status_code == 200
    with session_factory()() as db:
        next_lease = claim_stage(db,'control-validate_upload')
        assert next_lease and next_lease.job_id == second
        db.commit()


def test_node_schema_has_server_defaults_without_language_whitelist(client):
    result = client.get('/v1/admin/compute-nodes/config-schema',headers=login(client,'admin')).json()
    assert 'languages' not in result
    assert 'allowed_languages' not in result['defaults']
    assert result['pool_limits'] == {'text':100,'validate_upload':32}
