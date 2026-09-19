"""Provisioning, credential isolation and version fencing: no supplier calls."""
import pytest
from conftest import login
from app.db import session_factory
from app.node_config import NodeConfig
from app.queue_models import ComputeNode


def provision(client, resource='machine:cuda:0'):
    admin = login(client, 'admin')
    reply = client.post('/v1/admin/compute-nodes', headers=admin,
                        json={'name': 'CUDA node', 'resource_id': resource})
    assert reply.status_code == 201, reply.text
    data = reply.json()
    auth = {'Authorization': 'Bearer ' + data['token'], 'X-Node-Id': data['node_id']}
    return data, auth, admin


def register(client, auth, resource='machine:cuda:0', **extra):
    return client.post('/internal/compute/v2/nodes/register', headers=auth, json={
        'protocol_version': 2, 'engine_version': 'test-v2', 'ready': True,
        'supported_languages': ['en'], 'device': 'cuda:0', 'resource_id': resource, **extra})


def test_unique_credentials_never_leak_and_cannot_impersonate(client):
    first, auth, admin = provision(client)
    second, second_auth, _ = provision(client, 'machine2:cuda:0')
    assert first['node_id'] != second['node_id'] and first['token'] != second['token']
    with session_factory()() as db:
        assert db.get(ComputeNode, first['node_id']).credential_hash != first['token']
    for url in ['/v1/admin/compute-nodes', '/v1/admin/monitor/nodes',
                f"/v1/admin/compute-nodes/{first['node_id']}/config"]:
        reply = client.get(url, headers=admin)
        assert first['token'] not in reply.text and 'credential_hash' not in reply.text
    assert register(client, {**auth, 'X-Node-Id': second['node_id']}).status_code == 401
    assert register(client, {'Authorization': auth['Authorization']}).status_code == 401
    assert register(client, second_auth).status_code == 409
    assert client.post('/v1/admin/compute-nodes', headers=login(client),
                       json={'name': 'not admin', 'resource_id': 'new:gpu'}).status_code == 403


def test_server_owns_capacity_enablement_and_versions(client):
    node, auth, admin = provision(client)
    assert register(client, auth).status_code == 200
    path = f"/v1/admin/compute-nodes/{node['node_id']}/config"
    config = NodeConfig(execution_slots=3).model_dump(exclude_none=True)
    update = {'name': 'new name', 'enabled': False, 'expected_version': 1, 'config': config}
    reply = client.put(path, headers=admin, json=update)
    assert reply.status_code == 200 and reply.json()['version'] == 2
    assert client.put(path, headers=admin, json=update).status_code == 409
    assert register(client, auth).status_code == 200
    current = client.get(path, headers=admin).json()
    assert current['name'] == 'new name' and not current['enabled']
    assert current['config']['execution_slots'] == 3 and current['applied_version'] == 2
    response = client.post(f"/internal/compute/v2/nodes/{node['node_id']}/claim", headers=auth,
                           json={'request_id': 'disabled', 'count': 1, 'config_version': 2})
    assert response.status_code == 200 and response.json()['leases'] == []
    # The former registration contract is explicitly rejected, never interpreted.
    assert client.post('/internal/compute/v2/nodes/register', headers=auth, json={
        'id': node['node_id'], 'name': 'rogue', 'capacity': 32,
        'capabilities': ['analyze'], 'engine_version': 'test-v1', 'device': 'cuda:0',
        'resource_id': 'machine:cuda:0'}).status_code == 422


def test_unready_node_and_key_rotation_fence_new_admission(client):
    node, auth, admin = provision(client)
    assert register(client, auth).status_code == 200
    assert register(client, auth, ready=False).status_code == 200
    path = f"/v1/admin/compute-nodes/{node['node_id']}/config"
    current = client.get(path, headers=admin).json()
    assert not current['runtime']['ready']
    rotated = client.post(f"/v1/admin/compute-nodes/{node['node_id']}/rotate-credential", headers=admin)
    assert rotated.status_code == 200
    assert register(client, auth).status_code == 401
    auth['Authorization'] = 'Bearer ' + rotated.json()['token']
    assert register(client, auth).status_code == 200


@pytest.mark.parametrize('config', [
    {'execution_slots': 0}, {'execution_slots': True}, {'execution_slots': 33},
    {'engine': {'languages': ['unknown']}}, {'engine': {'torch_threads': 0}},
    {'engine': {'provider_token': 'forbidden'}}, {'heartbeat_seconds': 100}, {'schema_version': 2}])
def test_bad_configuration_rejected_before_provisioning(client, config):
    response = client.post('/v1/admin/compute-nodes', headers=login(client, 'admin'),
        json={'name': 'invalid', 'resource_id': 'invalid:gpu', 'config': config})
    assert response.status_code == 422


def test_declared_languages_are_intersected_with_allowed_targets(client):
    node, auth, admin = provision(client)
    config = NodeConfig(allowed_languages=['ja']).model_dump(exclude_none=True)
    client.put(f"/v1/admin/compute-nodes/{node['node_id']}/config", headers=admin,
               json={'name': 'test', 'enabled': True, 'expected_version': 1, 'config': config}).raise_for_status()
    assert register(client, auth, supported_languages=['ja', 'en']).status_code == 200
    with session_factory()() as db:
        assert db.get(ComputeNode, node['node_id']).supported_languages == ['ja']
