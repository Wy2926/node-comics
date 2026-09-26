"""Operator history is atomic, deduplicated and free of supplier secrets."""
from datetime import timedelta

from sqlalchemy import func, select

from conftest import login, login_plus


def identity(client, auth):
    return client.get('/v1/me', headers=auth).json()['user']['id']


def test_audit_is_admin_only_and_filters_paginate(client):
    from app.admin_audit import AdminAudit, record_audit
    from app.db import session_factory
    from app.models import now
    admin, reader = login(client, 'admin'), login(client, 'reader')
    actor_id = identity(client, admin)
    assert client.get('/v1/admin/audit').status_code == 401
    assert client.get('/v1/admin/audit', headers=reader).status_code == 403
    at = now().replace(microsecond=0)
    with session_factory()() as db:
        for index in range(4):
            record_audit(db, actor_id, 'isolated.change', 'test_resource', f'target-{index}', details={'index': index})
        db.flush()
        for row in db.scalars(select(AdminAudit)):
            row.created_at = at
        db.commit()
    first = client.get('/v1/admin/audit?limit=2', headers=admin).json()
    second = client.get('/v1/admin/audit?limit=2&offset=2', headers=admin).json()
    assert first['total'] == 4 and first['next_offset'] == 2 and second['next_offset'] is None
    assert not {row['id'] for row in first['items']} & {row['id'] for row in second['items']}
    filtered = client.get('/v1/admin/audit', headers=admin, params={'actor_id': actor_id, 'action': 'isolated.change',
        'target_type': 'test_resource', 'target_id': 'target-1', 'created_from': (at - timedelta(seconds=1)).isoformat() + 'Z',
        'created_to': (at + timedelta(seconds=1)).isoformat() + 'Z'}).json()
    assert filtered['total'] == 1 and filtered['items'][0]['actor_name'] == 'admin'
    assert 'operation_key' not in filtered['items'][0]
    assert client.get('/v1/admin/audit', headers=admin, params={'created_from': '2026-01-02T00:00:00Z', 'created_to': '2026-01-01T00:00:00Z'}).status_code == 422


def test_record_audit_shares_transaction_and_deduplicates_operation(client):
    from app.admin_audit import AdminAudit, record_audit
    from app.db import session_factory
    from app.models import User
    admin = login(client, 'admin')
    actor_id = identity(client, admin)
    with session_factory()() as db:
        user = db.get(User, actor_id)
        user.name = 'rolled-back-name'
        record_audit(db, actor_id, 'isolated.change', 'user', actor_id, after={'name': user.name}, operation_key='same-operation')
        db.flush()
        assert db.scalar(select(func.count()).select_from(AdminAudit)) == 1
        db.rollback()
    with session_factory()() as db:
        assert db.get(User, actor_id).name == 'admin'
        assert db.scalar(select(func.count()).select_from(AdminAudit)) == 0
        record_audit(db, actor_id, 'isolated.change', 'user', actor_id, after={'version': 1}, operation_key='same-operation')
        record_audit(db, actor_id, 'isolated.change', 'user', actor_id, after={'version': 2}, operation_key='same-operation')
        record_audit(db, actor_id, 'isolated.other_action', 'user', actor_id, operation_key='same-operation')
        db.commit()
    with session_factory()() as db:
        rows = db.scalars(select(AdminAudit).where(AdminAudit.action == 'isolated.change')).all()
        assert len(rows) == 1 and rows[0].after == {'version': 1}
        assert len(rows[0].operation_key) == 64 and 'same-operation' not in rows[0].operation_key
        assert db.scalar(select(func.count()).select_from(AdminAudit)) == 2


def test_audit_redacts_nested_secrets_and_signed_url_query(client):
    from app.admin_audit import record_audit
    from app.db import session_factory
    admin = login(client, 'admin')
    actor_id = identity(client, admin)
    marker = 'PRIVATE_AUDIT_FIXTURE'
    with session_factory()() as db:
        record_audit(db, actor_id, 'isolated.redact', 'test_resource', 'one', after={
            'api_key': marker, 'nested': [{'authorization': marker, 'password': marker}],
            'result_url': f'https://user:{marker}@objects.example/public/path?signature={marker}#private',
            'analysis': {'text': marker}, 'image_bytes': marker, 'safe': 'retained',
        })
        db.commit()
    response = client.get('/v1/admin/audit?action=isolated.redact', headers=admin)
    assert marker not in response.text
    data = response.json()['items'][0]['after']
    assert data['safe'] == 'retained' and data['result_url'] == 'https://objects.example/public/path'
    assert data['api_key'] == '[redacted]' and data['nested'][0]['authorization'] == '[redacted]'


def test_sanitize_preserves_only_known_integer_token_limits_and_counts():
    from app.admin_audit import sanitize
    counts = {'max_output_tokens': 4096, 'input_tokens': 27, 'output_tokens': 0}
    private = {'token': 12345, 'api_token': 12345, 'access_token': 'secret',
        'refresh_token': 'secret', 'custom_token_count': 3, 'max_output_tokens_secret': 4096,
        'secret_input_tokens': 27}
    sanitized = sanitize({'config': counts, 'usage': [counts], 'private': private})
    assert sanitized['config'] == counts and sanitized['usage'] == [counts]
    assert sanitized['private'] == dict.fromkeys(private, '[redacted]')
    for invalid in ('secret', True, None, -1, 1.5, float('inf'), float('nan'), {'token': 'secret'}, ['secret']):
        assert sanitize(dict.fromkeys(counts, invalid)) == dict.fromkeys(counts, '[redacted]')


def test_node_mutations_record_configuration_without_node_credentials(client):
    from app.db import session_factory
    from app.node_admin import token_hash
    from app.queue_models import ComputeNode
    admin = login(client, 'admin')
    created = client.post('/v1/admin/compute-nodes', headers=admin, json={'name': 'Isolated node', 'resource_id': 'isolated-audit-device'})
    assert created.status_code == 201, created.text
    node = created.json()
    update = {'expected_version': node['version'], 'name': 'Changed node', 'enabled': False,
              'config': {**node['config'], 'execution_slots': 3}}
    changed = client.put(f'/v1/admin/compute-nodes/{node["node_id"]}/config', headers=admin, json=update)
    assert changed.status_code == 200
    assert client.put(f'/v1/admin/compute-nodes/{node["node_id"]}/config', headers=admin, json=update).status_code == 409
    rotated = client.post(f'/v1/admin/compute-nodes/{node["node_id"]}/rotate-credential', headers=admin)
    assert rotated.status_code == 200
    timeline = client.get('/v1/admin/audit', headers=admin, params={'target_type': 'compute_node', 'target_id': node['node_id']})
    rows = timeline.json()['items']
    assert len(rows) == 3
    assert {row['action'] for row in rows} == {'node.create', 'node.configure', 'node.rotate_credential'}
    assert node['token'] not in timeline.text and rotated.json()['token'] not in timeline.text
    configured = next(row for row in rows if row['action'] == 'node.configure')
    assert configured['before']['version'] == 1 and configured['after']['version'] == 2
    assert configured['before']['config']['execution_slots'] == 1 and configured['after']['config']['execution_slots'] == 3
    with session_factory()() as db:
        saved = db.get(ComputeNode, node['node_id'])
        assert saved.capacity == 3 and not saved.enabled
        assert saved.credential_hash == token_hash(rotated.json()['token'])
        assert saved.applied_config_version == 0


def test_text_provider_audit_and_revision_history_preserve_old_configuration(client):
    from app.config import settings
    from app.db import session_factory
    from app.providers import configuration
    admin = login(client, 'admin')
    settings().classic_enabled = True
    path = '/v1/admin/translation-providers'
    body = {'name': 'Audit text provider', 'channel': 'openai', 'enabled': True,
        'config': {'base_url': 'https://isolated.example/v1', 'model': 'model-one', 'max_output_tokens': 4096},
        'api_key': 'PRIVATE_TEST_TEXT_KEY'}
    first = client.post(path, headers=admin, json=body)
    assert first.status_code == 201, first.text
    provider = first.json()
    changed_body = {**body, 'api_key': 'PRIVATE_ROTATED_TEXT_KEY',
        'config': {**body['config'], 'model': 'model-two', 'max_output_tokens': 2048}}
    changed = client.put(f'{path}/{provider["id"]}', headers=admin, json=changed_body)
    assert changed.status_code == 200
    assert client.post(f'{path}/{provider["id"]}/default', headers=admin).status_code == 200
    assert client.post(f'{path}/{provider["id"]}/title-default', headers=admin).status_code == 200
    with session_factory()() as db:
        assert configuration(db, 'classic', 'en')['text']['model'] == 'model-two'
    assert client.patch(f'{path}/{provider["id"]}', headers=admin, json={'enabled': False}).status_code == 200
    rows = client.get(f'{path}/{provider["id"]}/revisions?limit=1', headers=admin)
    assert rows.status_code == 200 and rows.json()['total'] == 2 and rows.json()['next_offset'] == 1
    assert rows.json()['items'][0]['current'] and rows.json()['items'][0]['config']['model'] == 'model-two'
    assert rows.json()['items'][0]['config']['max_output_tokens'] == 2048
    older = client.get(f'{path}/{provider["id"]}/revisions?offset=1&limit=1', headers=admin)
    assert older.json()['items'][0]['config']['model'] == 'model-one' and not older.json()['items'][0]['current']
    assert older.json()['items'][0]['config']['max_output_tokens'] == 4096
    assert client.get(f'{path}/{provider["id"]}/revisions', headers=login(client, 'reader')).status_code == 403
    audit = client.get('/v1/admin/audit', headers=admin, params={'target_type': 'translation_provider', 'target_id': provider['id']})
    assert {row['action'] for row in audit.json()['items']} == {'text_provider.create', 'text_provider.update', 'text_provider.default', 'text_provider.title_default', 'text_provider.toggle'}
    for response in (rows, older, audit):
        assert 'PRIVATE_TEST_TEXT_KEY' not in response.text and 'PRIVATE_ROTATED_TEXT_KEY' not in response.text
    update = next(row for row in audit.json()['items'] if row['action'] == 'text_provider.update')
    assert update['before']['revision_id'] == provider['revision_id']
    assert update['after']['revision_id'] == changed.json()['revision_id']
    assert update['before']['config']['max_output_tokens'] == 4096
    assert update['after']['config']['max_output_tokens'] == 2048


def test_versioned_rules_affect_new_periods_and_memberships_without_rewriting_existing_grants(client):
    from app.db import session_factory
    from app.entitlements import DAILY, allowance_json, entitlements_json, period_spec
    from app.entitlement_models import QuotaPeriod
    from app.models import User, now
    admin = login(client, 'admin')
    existing = login(client, 'existing-free')
    fresh = login(client, 'fresh-free')
    old_plus = login_plus(client, 'existing-plus')
    existing_id, fresh_id, plus_id = [identity(client, auth) for auth in (existing, fresh, old_plus)]
    with session_factory()() as db:
        spec = period_spec(db.get(User, existing_id), DAILY, db=db)
        previous_pages = spec['granted']
        db.add(QuotaPeriod(**spec, used=2, reserved=0))
        db.commit()
    old = client.get('/v1/admin/system-settings', headers=admin).json()
    values = {**old['values'], 'free_daily_pages': 17, 'plus_monthly_redraw_pages': 77,
              'free_scheduler_weight': 1.5, 'plus_scheduler_weight': 3.5}
    changed = client.put('/v1/admin/system-settings', headers=admin, json={'expected_version': old['version'], 'values': values})
    assert changed.status_code == 200, changed.text
    with session_factory()() as db:
        user = db.get(User, existing_id)
        assert allowance_json(db, user, DAILY)['granted'] == previous_pages
        assert allowance_json(db, db.get(User, fresh_id), DAILY)['granted'] == 17
        assert period_spec(user, DAILY, now() + timedelta(days=1), db=db)['granted'] == 17
        assert entitlements_json(db, user)['scheduler_weight'] == 1.5
        assert entitlements_json(db, db.get(User, plus_id))['scheduler_weight'] == 3.5
        assert db.get(User, plus_id).plus_monthly_pages == 300
    membership = client.post(f'/v1/admin/users/{fresh_id}/membership', headers={**admin, 'Idempotency-Key': 'new-default-membership'},
        json={'action': 'extend', 'days': 30, 'note': 'isolated new default'})
    assert membership.status_code == 200, membership.text
    with session_factory()() as db:
        assert db.get(User, fresh_id).plus_monthly_pages == 77
    audit = client.get('/v1/admin/audit?action=system_settings.update', headers=admin).json()
    assert audit['total'] == 1
    assert audit['items'][0]['before']['values']['free_daily_pages'] == old['values']['free_daily_pages']
    assert audit['items'][0]['after']['values']['free_daily_pages'] == 17
