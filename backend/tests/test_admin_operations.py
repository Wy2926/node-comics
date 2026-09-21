"""Administrator diagnostics use bounded metadata, never private object I/O."""
from datetime import timedelta

import pytest
from sqlalchemy import select

from conftest import login

ROOT = '/v1/admin/operations'
PRIVATE = 'PRIVATE_FIXTURE_MUST_NOT_LEAK'


@pytest.fixture
def operations(client):
    from app.db import session_factory
    from app.models import Asset, Attempt, Job, TextCall, User, now
    from app.plan_models import ControlAdmission, ImageAdmission, ReadingSession, TranslationOperation, TranslationPolicy
    from app.feedback_models import FeedbackAdmission
    from app.results import ResultAccess, TranslationResult
    from app.file_pages import FilePage
    from app.upload_models import UploadIngressLease, UploadReservation
    from app.health_models import ServiceHeartbeat
    from app.billing_models import BillingEvent
    admin = login(client, 'admin')
    reader = login(client, 'reader')
    reused_reader = login(client, 'reused-reader')
    at = now().replace(microsecond=0)
    with session_factory()() as db:
        a = db.scalar(select(User).where(User.subject == 'dev:reader'))
        b = db.scalar(select(User).where(User.subject == 'dev:reused-reader'))

        def asset(owner, name, kind='original', parent=None):
            row = Asset(id=name, owner_id=owner.id, sha256=('a' if kind == 'original' else 'b') * 64,
                storage_backend='r2', storage_key=f'{PRIVATE}/{kind}', kind=kind, parent_id=parent,
                mime='image/png', width=320, height=480, byte_size=500, expires_at=None)
            db.add(row); db.flush(); return row

        source = asset(a, 'source-a')
        output = asset(a, 'output-a', 'classic', source.id)
        shared_source = asset(b, 'source-b')
        shared_output = asset(b, 'output-b', 'classic', shared_source.id)

        def job(name, status, created=None, completed=None):
            row = Job(id=name, owner_id=a.id, input_asset_id=source.id if status == 'succeeded' else None,
                output_asset_id=output.id if status == 'succeeded' else None, source_sha256=source.sha256,
                mode='classic', target_language='en', status=status, phase=status, operation='isolated-diagnostics',
                idempotency_key=name, request_hash='c' * 64, cache_key=name, config={'private': PRIVATE},
                quota_kind='classic_daily', quota_pages=1, settlement='settled',
                created_at=created or at - timedelta(seconds=120), completed_at=completed)
            db.add(row); db.flush(); return row

        done = job('done-job', 'succeeded', completed=at - timedelta(seconds=10))
        waiting = job('waiting-job', 'awaiting_upload')
        expired = job('expired-upload-job', 'failed', completed=at - timedelta(seconds=5))
        job('old-job', 'succeeded', created=at - timedelta(days=95), completed=at - timedelta(days=95) + timedelta(seconds=40))
        job('future-job', 'succeeded', created=at + timedelta(days=1), completed=at + timedelta(days=1, seconds=40))
        db.add(TranslationResult(id=done.id, cache_key=done.cache_key, generated_at=done.completed_at))
        db.flush()
        access = ResultAccess(id='reuse-access', owner_id=b.id, result_id=done.id,
            input_asset_id=shared_source.id, output_asset_id=shared_output.id, version=1, created_at=at - timedelta(seconds=3))
        db.add(access); db.flush()
        db.add_all([
            TranslationOperation(owner_id=a.id, operation_key='reader-submission', request_hash='x' * 64, job_id=done.id,
                descriptor={'source_url': f'https://private.example/page?token={PRIVATE}'}),
            TranslationOperation(owner_id=b.id, operation_key='reuse-submission', request_hash='y' * 64, access_id=access.id),
            FilePage(owner_id=a.id, file_hash='f' * 64, page_index=1, asset_id=source.id),
            ReadingSession(owner_id=a.id, session_id='current-session', sequence=8, window=[{'source': PRIVATE}], expires_at=at + timedelta(minutes=1)),
            ReadingSession(owner_id=a.id, session_id='fenced-session', sequence=4, window=[], fenced=True, expires_at=at + timedelta(minutes=1)),
            ReadingSession(owner_id=b.id, session_id='other-session', sequence=99, window=[], expires_at=at + timedelta(minutes=1)),
            ControlAdmission(owner_id=a.id, scope='plan', tokens=2.5, refilled_at=at,
                leases=[{'id': PRIVATE, 'until': (at + timedelta(seconds=30)).isoformat()}, {'id': PRIVATE, 'until': (at - timedelta(seconds=30)).isoformat()}]),
            TranslationPolicy(owner_id=a.id, revision=7, fingerprint=PRIVATE),
            FeedbackAdmission(owner_id=a.id, request_tokens=4, refilled_at=at, day_started_at=at.replace(hour=0), daily_receipts=3),
            ImageAdmission(owner_id=a.id, job_id=done.id, admitted_at=at - timedelta(seconds=10)),
            ImageAdmission(owner_id=a.id, job_id=waiting.id, admitted_at=at - timedelta(seconds=65)),
            ServiceHeartbeat(role='control-worker', instance_id='good-worker', heartbeat_at=at, last_success_at=at),
            ServiceHeartbeat(role='maintenance', instance_id='stale-maintenance', heartbeat_at=at - timedelta(hours=1), last_success_at=at - timedelta(hours=1)),
            BillingEvent(id='pending-payment', environment='test', provider='creem', event_type='order.paid', resource_id='order-test',
                payload={'private': PRIVATE}, occurred_at=at, status='pending', attempts=2, received_at=at - timedelta(hours=1)),
        ])
        for upload_id, row, status in [('upload-waiting', waiting, 'awaiting_upload'), ('upload-expired', expired, 'expired')]:
            db.add(UploadReservation(id=upload_id, job_id=row.id, owner_id=a.id, mode='classic', expected_sha256='d' * 64,
                expected_size=500, mime='image/png', storage_backend='r2', status=status, expires_at=at + timedelta(seconds=40),
                max_expires_at=at + timedelta(minutes=10), verified_info={'private': PRIVATE}))
        db.flush()
        db.add(UploadIngressLease(upload_id='upload-waiting', owner_id=a.id, expires_at=at + timedelta(seconds=30)))
        attempt = Attempt(job_id=done.id, provider_id='text-a', lease_expires_at=at)
        db.add(attempt); db.flush()
        for index, (provider, model, state, cost, error) in enumerate([
            ('text-a', 'model-a', 'reported', 100, None), ('text-a', 'model-a', 'unknown', 900, 'TEXT_UNKNOWN'),
            ('text-b', 'model-b', 'estimated', 400, None),
        ]):
            db.add(TextCall(job_id=done.id, attempt_id=attempt.id, group_index=0, sequence=index + 1, provider_id=provider,
                model=model, reserved_micros=cost, accounted_micros=cost, cost_state=state, error_code=error,
                started_at=at - timedelta(seconds=30), completed_at=at - timedelta(seconds=20)))
        db.commit()
        yield {'client': client, 'admin': admin, 'reader': reader, 'a': a.id, 'b': b.id, 'at': at}


@pytest.mark.parametrize('path', ['/health', '/users/unknown', '/uploads', '/receipts', '/assets', '/file-pages', '/results', '/accesses', '/statistics'])
def test_diagnostics_are_admin_only(client, path):
    assert client.get(ROOT + path).status_code == 401
    assert client.get(ROOT + path, headers=login(client, 'reader')).status_code == 403


def test_metadata_views_never_touch_objects_or_expose_private_payloads(operations, monkeypatch):
    from app.storage import LocalStore, S3Store
    def forbidden(*args, **kwargs):
        raise AssertionError('diagnostic metadata must not access objects')
    for cls in (LocalStore, S3Store):
        for name in ('read', 'put', 'exists', 'download_url', 'delete'):
            if hasattr(cls, name):
                monkeypatch.setattr(cls, name, forbidden)
    case = operations
    for path in ['/health', f'/users/{case["a"]}', '/uploads', '/receipts', '/assets', '/file-pages', '/results', '/accesses', '/statistics']:
        result = case['client'].get(ROOT + path, headers=case['admin'])
        assert result.status_code == 200, result.text
        assert PRIVATE not in result.text
        assert not any(f'"{field}"' in result.text for field in ['storage_key', 'verified_info', 'descriptor', 'fingerprint', 'window', 'payload'])


def test_filters_pagination_and_reuse_relationships(operations):
    case = operations
    def get(path):
        result = case['client'].get(ROOT + path, headers=case['admin'])
        assert result.status_code == 200, result.text
        return result.json()
    first = get('/assets?limit=2')
    second = get('/assets?limit=2&offset=2')
    assert first['total'] == 4 and first['next_offset'] == 2
    assert len(second['items']) == 2 and not ({row['id'] for row in first['items']} & {row['id'] for row in second['items']})
    source = get('/assets?q=source-a')['items'][0]
    assert source['file_page_count'] == 1 and source['result_access_count'] == 0
    assert get('/assets?q=' + 'a' * 64)['total'] == 2
    assert get('/assets?job_id=done-job')['total'] == 2
    assert get(f'/assets?owner_id={case["b"]}')['total'] == 2
    assert get('/uploads?status=expired')['items'][0]['job_id'] == 'expired-upload-job'
    assert get('/uploads?job_id=waiting-job')['items'][0]['ingress_expires_at']
    assert get(f'/uploads?owner_id={case["b"]}')['total'] == 0
    assert get('/receipts?operation_key=reuse-submission')['items'][0]['access_id'] == 'reuse-access'
    assert get('/receipts?job_id=done-job')['total'] == 1
    assert get('/file-pages?asset_id=source-a')['items'][0]['page_index'] == 1
    assert get(f'/results?owner_id={case["b"]}')['items'][0]['access_count'] == 1
    assert get('/results?q=done-job&mode=classic')['total'] == 1
    assert get('/results?mode=redraw')['total'] == 0
    assert get(f'/accesses?result_id=done-job&owner_id={case["b"]}')['total'] == 1
    assert get(f'/accesses?owner_id={case["a"]}')['total'] == 0
    assert case['client'].get(ROOT + '/assets?limit=101', headers=case['admin']).status_code == 422


def test_availability_preserves_pinned_originals_but_never_deleted_access(operations):
    from app.db import session_factory
    from app.models import Asset
    case = operations
    with session_factory()() as db:
        source = db.get(Asset, 'source-b')
        source.expires_at = case['at'] - timedelta(days=1)
        source.active_references = 1
        db.commit()
    asset = case['client'].get(ROOT + '/assets?q=source-b', headers=case['admin']).json()['items'][0]
    access = case['client'].get(ROOT + '/accesses?result_id=done-job', headers=case['admin']).json()['items'][0]
    assert asset['available'] and access['available']
    with session_factory()() as db:
        db.get(Asset, 'source-b').deleted_at = case['at']
        db.commit()
    assert not case['client'].get(ROOT + '/assets?q=source-b', headers=case['admin']).json()['items'][0]['available']
    assert not case['client'].get(ROOT + '/accesses?result_id=done-job', headers=case['admin']).json()['items'][0]['available']


def test_user_admissions_and_service_health_explain_current_state(operations):
    case = operations
    data = case['client'].get(ROOT + f'/users/{case["a"]}', headers=case['admin']).json()
    assert data['image_budget']['remaining'] == data['image_budget']['limit'] - 1
    assert data['upload_active'] == 1 and data['policy_revision'] == 7
    assert {row['session_id']: row['active'] for row in data['sessions']} == {'current-session': True, 'fenced-session': False}
    assert data['controls'][0]['active_leases'] == 1 and data['feedback']['daily_receipts'] == 3
    assert case['client'].get(ROOT + '/users/missing', headers=case['admin']).status_code == 404
    health = case['client'].get(ROOT + '/health', headers=case['admin']).json()
    assert {row['instance_id']: row['status'] for row in health['items']} == {'good-worker': 'healthy', 'stale-maintenance': 'unhealthy'}
    assert health['billing_backlog'][0]['count'] == 1 and health['billing_backlog'][0]['max_attempts'] == 2


def test_statistics_separate_execution_from_grants_and_keep_unknown_cost(operations):
    case = operations
    data = case['client'].get(ROOT + '/statistics?days=7', headers=case['admin']).json()
    assert data['timezone'] == 'UTC'
    assert sum(row['count'] for row in data['jobs']) == 2  # done + failed; no old/future/running/reuse jobs
    assert sum(row['access_grants'] for row in data['reuse']) == 1
    assert sum(row['accounted_micros'] for row in data['text_calls']) == 1400
    text = next(row for row in data['text_calls'] if row['provider_id'] == 'text-a')
    assert text['calls'] == 2 and text['unknown_calls'] == 1 and text['failed_calls'] == 1 and text['accounted_micros'] == 1000
    filtered = case['client'].get(ROOT + '/statistics?provider_id=text-b&model=model-b', headers=case['admin']).json()
    assert len(filtered['text_calls']) == 1 and filtered['text_calls'][0]['estimated_calls'] == 1
    assert case['client'].get(ROOT + '/statistics?days=91', headers=case['admin']).status_code == 422


def test_payment_statistics_do_not_merge_test_and_live_orders(operations):
    from app.db import session_factory
    from app.billing_models import BillingOrder, BillingPlan, BillingPlanRevision, BillingPrice, BillingPriceBinding
    case = operations
    with session_factory()() as db:
        db.add(BillingPlan(id='stats-plan', name='Isolated statistics'))
        db.flush()
        revision = BillingPlanRevision(plan_id='stats-plan', version=1, name='v1', monthly_redraw_pages=300, trial_days=0, trial_redraw_pages=0)
        db.add(revision); db.flush()
        for environment, amount in [('test', 999), ('live', 1999)]:
            price = BillingPrice(plan_id='stats-plan', plan_revision_id=revision.id, environment=environment, currency='usd', unit_amount=amount, interval='month')
            db.add(price); db.flush()
            binding = BillingPriceBinding(price_id=price.id, provider='creem', environment=environment, product_id=f'stats-{environment}')
            db.add(binding); db.flush()
            db.add(BillingOrder(owner_id=case['a'], price_id=price.id, binding_id=binding.id, provider='creem', environment=environment,
                external_id=f'isolated-order-{environment}', kind='initial', status='paid', currency='usd', total=amount, created_at=case['at']))
        db.commit()
    rows = case['client'].get(ROOT + '/statistics', headers=case['admin']).json()['payments']
    assert len(rows) == 2
    assert {row['environment']: row['order_amount'] for row in rows} == {'test': 999, 'live': 1999}


def test_payment_health_keeps_environment_backlogs_separate(operations):
    from app.db import session_factory
    from app.billing_models import BillingEvent
    case = operations
    with session_factory()() as db:
        db.add(BillingEvent(id='live-payment-backlog', environment='live', provider='creem',
            event_type='refund.created', resource_id='ref_live_backlog', occurred_at=case['at'],
            status='pending', attempts=8, received_at=case['at'] - timedelta(minutes=5)))
        db.commit()
    response = case['client'].get(ROOT + '/health', headers=case['admin'])
    assert response.status_code == 200
    rows = response.json()['billing_backlog']
    assert len(rows) == 2
    assert {row['environment']: (row['count'], row['max_attempts']) for row in rows} == {
        'test': (1, 2), 'live': (1, 8)}
