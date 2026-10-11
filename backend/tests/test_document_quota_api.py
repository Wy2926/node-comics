"""No R2/provider traffic: real API, persistent admission, ownership and races."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app.db import session_factory
from app.documents.models import Document, DocumentPage, DocumentQuotaAllocation
from app.documents.quota import reserve_document, settle_document
from app.entitlement_models import QuotaPeriod
from app.models import Job, Ledger, User, now, uid
from app.queue_models import JobStage
from conftest import configure_system_limits, login, login_plus
from test_quota_purchase_admission import seed_purchase
from test_translation_requests import high_control_budget
from translation_fixtures import configure_text_provider


class MetadataStore:
    def __init__(self):
        self.created, self.aborted, self.completed, self.signed = [], [], [], []

    def create_multipart(self, key, mime):
        self.created.append((key, mime))
        return 'isolated-upload-' + uid()

    def abort_multipart(self, key, upload_id):
        self.aborted.append((key, upload_id))

    def presign_upload_part(self, key, upload_id, part_number, *, byte_size=None):
        self.signed.append((key, upload_id, part_number, byte_size))
        return {'url': 'https://r2.example/isolated-part', 'headers': {}, 'expires_in': 300}

    def complete_multipart(self, key, upload_id, *, expected_size, expected_sha256=None):
        self.completed.append((key, upload_id))
        return {'key': key, 'byte_size': expected_size, 'sha256': expected_sha256}

    def presign_download(self, key, filename=None):
        return {'url': 'https://r2.example/isolated-result', 'headers': {}, 'expires_in': 300}


@pytest.fixture
def document_case(client, monkeypatch):
    from app.documents import api
    from app.translation_models import TranslationProvider
    auth = login(client)
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    configure_system_limits(free_daily_pages=0)
    high_control_budget()
    with session_factory()() as db:
        provider = db.scalar(select(TranslationProvider))
        configure_text_provider(db, provider.id, document={'enabled': True})
        provider_id = provider.id
    cfg = SimpleNamespace(enabled=True, r2_key_prefix='documents', upload_part_bytes=16 * 1024 * 1024,
                          upload_lifetime_seconds=3600, waiting_retention_hours=24)
    store = MetadataStore()
    monkeypatch.setattr(api, 'get_document_settings', lambda: cfg)
    monkeypatch.setattr(api, 'get_document_store', lambda: store)
    return SimpleNamespace(client=client, auth=auth, owner=owner, provider=provider_id, store=store)


def purchase(case, pages, *, service='plus', ends_at=None):
    with session_factory()() as db:
        row = seed_purchase(db, case.owner, pages=pages, service=service,
                            start=now() - timedelta(days=1), end=ends_at)
        db.commit()
        return row.id


def body(case, **changes):
    return {'filename': 'book.zip', 'source_type': 'zip', 'byte_size': 1234,
            'sha256': 'a' * 64, 'target_language': 'zh-Hans', 'model_id': case.provider, **changes}


def create(case, key=None, **changes):
    key = key or str(uuid4())
    response = case.client.put('/v1/documents/' + key, headers=case.auth, json=body(case, **changes))
    assert response.status_code == 202, response.text
    return key


def prepare(case, key, pages, *, scope=None):
    """Trusted prepare fixture; not a claim that PDF parsing/OCR was executed."""
    with session_factory()() as db:
        job = db.scalar(select(Job).where(Job.owner_id == case.owner, Job.idempotency_key == key))
        document = db.get(Document, job.id)
        document.page_count = pages
        document.upload_completed_at = now()
        job.status, job.phase = 'preflight', 'doc_prepare'
        job.config = {**job.config, 'document': {**job.config['document'], 'service_plans': scope}}
        for number in range(1, pages + 1):
            db.add(DocumentPage(job_id=job.id, page_index=number,
                input_ref={'key': f'documents/work/{job.id}/{number}.png', 'sha256': 'b' * 64,
                           'byte_size': 100, 'mime': 'image/png', 'width': 30, 'height': 40}))
        db.commit()
        return job.id


def reserve(job_id):
    with session_factory()() as db:
        accepted = reserve_document(db, db.get(Job, job_id))
        db.commit()
        return accepted


def paid_term(case, *, unlimited=True, kind='paid', service='plus'):
    from app.billing_models import BillingCheckout, BillingPlan, BillingPlanRevision, BillingPrice, BillingPriceBinding, BillingSubscription, BillingTerm
    with session_factory()() as db:
        if not db.get(BillingPlan, service):
            db.add(BillingPlan(id=service, name=service))
            db.flush()
        version = (db.scalar(select(func.max(BillingPlanRevision.version)).where(BillingPlanRevision.plan_id == service)) or 0) + 1
        revision = BillingPlanRevision(plan_id=service, version=version, name=service,
            service_plan_id=service, monthly_classic_pages=None if unlimited else 0,
            trial_days=7, trial_classic_pages=None)
        db.add(revision)
        db.flush()
        price = BillingPrice(plan_id=service, plan_revision_id=revision.id, environment='test',
            currency='usd', unit_amount=999, interval='month', status='draft')
        db.add(price)
        db.flush()
        binding = BillingPriceBinding(price_id=price.id, provider='stripe', environment='test',
            product_id='prod_' + uid(), provider_price_id='price_' + uid(), status='draft')
        db.add(binding)
        db.flush()
        checkout = BillingCheckout(owner_id=case.owner, environment='test', provider='stripe', price_id=price.id,
            binding_id=binding.id, return_url='https://comics.example/account', trial=False,
            status='completed', expires_at=now() + timedelta(hours=1))
        db.add(checkout)
        db.flush()
        sub = BillingSubscription(id=uid(), owner_id=case.owner, checkout_id=checkout.id,
            environment='test', provider='stripe', customer_id='cus_' + uid(), price_id=price.id,
            binding_id=binding.id, status='active')
        db.add(sub)
        db.flush()
        term = BillingTerm(id=uid(), owner_id=case.owner, subscription_id=sub.id, price_id=price.id,
            kind=kind, starts_at=now() - timedelta(days=1), ends_at=now() + timedelta(days=29))
        db.add(term)
        db.commit()
        return term.id


def test_paid_gate_excludes_free_and_operator_gifts(document_case):
    case = document_case
    for auth in (case.auth, login_plus(case.client, 'operator-gift')):
        result = case.client.put('/v1/documents/' + str(uuid4()), headers=auth, json=body(case))
        assert result.status_code == 403 and result.json()['error']['code'] == 'DOCUMENT_PAID_REQUIRED'
    assert not case.store.created


def test_capabilities_are_authenticated_paid_and_document_model_specific(document_case):
    from app.translation_models import TranslationProvider
    case = document_case
    assert case.client.get('/v1/documents/capabilities').status_code == 401
    result = case.client.get('/v1/documents/capabilities', headers=case.auth)
    assert result.status_code == 200
    assert result.json()['paid_allowed'] is False
    purchase(case, 1)
    caps = case.client.get('/v1/documents/capabilities', headers=case.auth).json()
    assert caps['paid_allowed'] is True
    assert caps['limits']['max_bytes'] == 200_000_000 and caps['limits']['max_pages'] == 200
    assert [item['id'] for item in caps['models']] == [case.provider]
    assert not any(word in str(caps) for word in ('api_key', 'endpoint', 'revision_id'))
    with session_factory()() as db:
        provider = db.get(TranslationProvider, case.provider)
        configure_text_provider(db, provider.id, document={'enabled': False})
    assert case.client.get('/v1/documents/capabilities', headers=case.auth).json()['models'] == []


def test_trial_unlimited_does_not_open_paid_document_feature(document_case):
    case = document_case
    paid_term(case, kind='trial')
    response = case.client.put('/v1/documents/' + str(uuid4()), headers=case.auth, json=body(case))
    assert response.status_code == 403 and response.json()['error']['code'] == 'DOCUMENT_PAID_REQUIRED'


def test_paid_unlimited_tracks_all_200_processing_pages_without_finite_bucket(document_case):
    case = document_case
    term_id = paid_term(case)
    job_id = prepare(case, create(case), 200, scope=['plus'])
    assert reserve(job_id)
    with session_factory()() as db:
        allocation = db.scalar(select(DocumentQuotaAllocation))
        assert (allocation.period_id, allocation.billing_term_id, allocation.pages, allocation.reserved) == (None, term_id, 200, 200)
        assert db.get(Job, job_id).quota_pages == 200
        assert db.scalar(select(func.count()).select_from(QuotaPeriod)) == 0
        for page in db.scalars(select(DocumentPage)):
            page.status, page.billable = 'translated', True
        settle_document(db, db.get(Job, job_id))
        db.commit()
        assert (allocation.reserved, allocation.used, allocation.released) == (0, 200, 0)
        assert db.scalar(select(func.sum(Ledger.amount)).where(Ledger.kind == 'settle')) == 200


def test_unlimited_lower_plan_does_not_pay_higher_plan_model(document_case):
    case = document_case
    paid_term(case, service='plus')
    job_id = prepare(case, create(case), 3, scope=['pro'])
    assert not reserve(job_id)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(DocumentQuotaAllocation)) == 0
        assert db.get(Job, job_id).entitlement['document_quota']['difference'] == 3


def test_upload_request_replay_ownership_and_strict_metadata(document_case):
    case = document_case
    purchase(case, 5)
    key = create(case)
    assert create(case, key) == key and len(case.store.created) == 1
    different = case.client.put('/v1/documents/' + key, headers=case.auth, json=body(case, byte_size=1235))
    assert different.status_code == 409
    other = login(case.client, 'other')
    for suffix in ('', '/download'):
        assert case.client.get('/v1/documents/' + key + suffix, headers=other).status_code == 404
    for suffix in ('/cancel', '/resume', '/complete-upload'):
        assert case.client.post('/v1/documents/' + key + suffix, headers=other).status_code == 404
    invalid = case.client.put('/v1/documents/' + str(uuid4()), headers=case.auth,
                              json=body(case, byte_size=200000001))
    assert invalid.status_code == 422
    parts = case.client.post('/v1/documents/' + key + '/upload-parts', headers=case.auth,
                             json={'part_numbers': [1]})
    assert parts.status_code == 200 and case.store.signed[0][3] == 1234
    assert case.client.post('/v1/documents/' + key + '/upload-parts', headers=case.auth,
                            json={'part_numbers': [2]}).status_code == 422


def test_cancellation_before_reservation_is_durable_and_idempotent(document_case):
    case = document_case
    purchase(case, 5)
    key = create(case)
    for _ in range(2):
        result = case.client.post('/v1/documents/' + key + '/cancel', headers=case.auth)
        assert result.status_code == 200 and result.json()['status'] == 'cancelled'
    assert create(case, key) == key and len(case.store.created) == 1
    assert case.client.post('/v1/documents/' + key + '/complete-upload', headers=case.auth).json()['status'] == 'cancelled'
    assert case.client.post('/v1/documents/' + key + '/resume', headers=case.auth).status_code == 409
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'reserve')) == 0


def test_whole_document_no_partial_reservation_and_explicit_resume(document_case):
    case = document_case
    first = purchase(case, 2)
    key = create(case)
    job_id = prepare(case, key, 3)
    assert not reserve(job_id)
    response = case.client.get('/v1/documents/' + key, headers=case.auth)
    assert {field: response.json()['quota'][field] for field in ('needed', 'available', 'difference')} == {
        'needed': 3, 'available': 2, 'difference': 1}
    with session_factory()() as db:
        assert db.get(QuotaPeriod, first).reserved == 0
        assert db.scalar(select(func.count()).select_from(DocumentQuotaAllocation)) == 0
        assert db.get(Job, job_id).status == 'awaiting_quota'
    purchase(case, 2)
    # Payment alone does not queue or reserve the waiting job.
    assert case.client.get('/v1/documents/' + key, headers=case.auth).json()['status'] == 'awaiting_quota'
    response = case.client.post('/v1/documents/' + key + '/resume', headers=case.auth)
    assert response.status_code == 202 and response.json()['quota']['reserved'] == 3
    assert case.client.post('/v1/documents/' + key + '/resume', headers=case.auth).json()['quota']['reserved'] == 3
    denied = case.client.post('/v1/documents/' + key + '/cancel', headers=case.auth)
    assert denied.status_code == 409 and denied.json()['error']['code'] == 'DOCUMENT_NOT_CANCELLABLE'


def test_model_scope_cannot_borrow_rights_from_another_bucket(document_case):
    case = document_case
    pro = purchase(case, 1, service='pro')
    plus = purchase(case, 10, service='plus')
    job_id = prepare(case, create(case), 3, scope=['pro'])
    assert not reserve(job_id)
    with session_factory()() as db:
        assert db.get(QuotaPeriod, pro).reserved == db.get(QuotaPeriod, plus).reserved == 0
    purchase(case, 2, service='pro')
    assert reserve(job_id)
    with session_factory()() as db:
        allocations = list(db.scalars(select(DocumentQuotaAllocation)))
        assert sum(row.reserved for row in allocations) == 3
        assert all(row.entitlement['service_plan'] == 'pro' for row in allocations)
        assert db.get(QuotaPeriod, plus).reserved == 0


def test_free_model_preserves_free_then_paid_order(document_case):
    case = document_case
    configure_system_limits(free_daily_pages=1)
    purchased = purchase(case, 5)
    job_id = prepare(case, create(case), 3)
    assert reserve(job_id)
    with session_factory()() as db:
        assert db.get(QuotaPeriod, purchased).reserved == 2
        assert db.scalar(select(QuotaPeriod.reserved).where(QuotaPeriod.owner_id == case.owner,
                                                          QuotaPeriod.source == 'daily')) == 1


@pytest.mark.parametrize('success', [True, False])
def test_multi_bucket_settlement_exactly_once_original_buckets_and_no_text(document_case, success):
    case = document_case
    early = purchase(case, 2, ends_at=now() + timedelta(hours=1))
    late = purchase(case, 2)
    key = create(case)
    job_id = prepare(case, key, 3)
    assert reserve(job_id) and reserve(job_id)
    with session_factory()() as db:
        pages = list(db.scalars(select(DocumentPage).order_by(DocumentPage.page_index)))
        for page in pages:
            page.status, page.billable = 'translated', True
        pages[1].status, pages[1].billable = 'no_text', False
        db.get(QuotaPeriod, early).ends_at = now() - timedelta(seconds=1)
        db.get(QuotaPeriod, late).revoked_at = now()
        settle_document(db, db.get(Job, job_id), success=success)
        db.commit()
        settle_document(db, db.get(Job, job_id), success=success)
        db.commit()
        assert db.get(QuotaPeriod, early).reserved == db.get(QuotaPeriod, late).reserved == 0
        assert (db.get(QuotaPeriod, early).used, db.get(QuotaPeriod, late).used) == ((1, 1) if success else (0, 0))
        assert sum(row.amount for row in db.scalars(select(Ledger).where(Ledger.kind == 'reserve'))) == 3
    # Even a released/settled task retains its irreversible admission boundary.
    assert case.client.post('/v1/documents/' + key + '/cancel', headers=case.auth).status_code == 409


def test_parallel_documents_compete_for_total_balance_not_individual_buckets(document_case):
    case = document_case
    period = purchase(case, 3)
    jobs = [prepare(case, create(case), 3) for _ in range(2)]
    barrier = Barrier(2)
    def attempt(job_id):
        barrier.wait(timeout=10)
        return reserve(job_id)
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(attempt, jobs)) == [False, True]
    with session_factory()() as db:
        assert db.get(QuotaPeriod, period).reserved == 3
        assert db.scalar(select(func.count()).select_from(DocumentQuotaAllocation)) == 1


def test_cancel_races_reservation_with_one_serialized_winner(document_case):
    case = document_case
    purchase(case, 3)
    key = create(case)
    job_id = prepare(case, key, 3)
    barrier = Barrier(2)
    def accept():
        from fastapi import HTTPException
        barrier.wait(timeout=10)
        try:
            return reserve(job_id)
        except HTTPException as error:
            assert error.detail['code'] == 'DOCUMENT_NOT_RESUMABLE'
            return False
    def cancel():
        barrier.wait(timeout=10)
        return case.client.post('/v1/documents/' + key + '/cancel', headers=case.auth).status_code
    with ThreadPoolExecutor(2) as pool:
        accepted, cancelled = pool.submit(accept), pool.submit(cancel)
        won, code = accepted.result(), cancelled.result()
    assert (won, code) in ((True, 409), (False, 200))
    with session_factory()() as db:
        document = db.get(Document, job_id)
        assert bool(document.reserved_at) is won
        assert db.scalar(select(func.coalesce(func.sum(QuotaPeriod.reserved), 0))) == (3 if won else 0)


def test_multi_bucket_reservation_rolls_back_as_one_transaction(document_case, monkeypatch):
    from app.documents import quota
    case = document_case
    purchase(case, 2)
    purchase(case, 2)
    job_id = prepare(case, create(case), 3)
    original, calls = quota.reserve_period, []
    def fail_second(*args):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError('isolated second bucket failure')
        return original(*args)
    monkeypatch.setattr(quota, 'reserve_period', fail_second)
    with pytest.raises(RuntimeError, match='second bucket'):
        reserve(job_id)
    with session_factory()() as db:
        assert db.scalar(select(func.sum(QuotaPeriod.reserved))) == 0
        assert db.scalar(select(func.count()).select_from(DocumentQuotaAllocation)) == 0
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'reserve')) == 0
        assert db.get(Document, job_id).reserved_at is None


def test_seal_replay_and_metadata_only_history(document_case):
    case = document_case
    purchase(case, 5)
    key = create(case)
    for _ in range(2):
        result = case.client.post('/v1/documents/' + key + '/complete-upload', headers=case.auth)
        assert result.status_code == 202 and result.json()['status'] == 'preflight'
    assert len(case.store.completed) == 1
    with session_factory()() as db:
        document = db.scalar(select(Document))
        assert document.expires_at > now() + timedelta(hours=23)
        assert db.scalar(select(func.count()).select_from(JobStage).where(JobStage.name == 'doc_prepare')) == 1
    history = case.client.get('/v1/documents', headers=case.auth)
    assert history.status_code == 200 and history.json()['items'][0]['id'] == key
    assert 'https://r2.example' not in history.text and 'source_key' not in history.text


def test_accepted_paid_access_survives_purchase_exhaustion_and_needs_explicit_resume(document_case):
    case = document_case
    period_id = purchase(case, 1)
    key = create(case)
    job_id = prepare(case, key, 2)
    with session_factory()() as db:
        db.get(QuotaPeriod, period_id).used = 1
        db.commit()
    assert case.client.get('/v1/documents/capabilities', headers=case.auth).json()['paid_allowed'] is False
    assert reserve(job_id) is False
    snapshot = case.client.get('/v1/documents/' + key, headers=case.auth).json()
    assert snapshot['status'] == 'awaiting_quota' and snapshot['quota']['available'] == 0
    purchase(case, 2)
    assert case.client.get('/v1/documents/' + key, headers=case.auth).json()['status'] == 'awaiting_quota'
    response = case.client.post('/v1/documents/' + key + '/resume', headers=case.auth)
    assert response.status_code == 202 and response.json()['quota']['reserved'] == 2


def test_history_cursor_and_snapshot_queries_are_bounded_not_per_document(document_case):
    from sqlalchemy import event
    from app.db import engine
    case = document_case
    purchase(case, 1)
    keys = [create(case) for _ in range(22)]
    statements = []
    def observed(_connection, _cursor, statement, _parameters, _context, _executemany):
        if 'document_pages' in statement or 'document_quota_allocations' in statement:
            statements.append(statement)
    event.listen(engine(), 'before_cursor_execute', observed)
    try:
        first = case.client.get('/v1/documents?limit=20', headers=case.auth).json()
    finally:
        event.remove(engine(), 'before_cursor_execute', observed)
    assert len(first['items']) == 20 and len(statements) == 2
    second = case.client.get('/v1/documents?limit=20&before=' + first['next_cursor'], headers=case.auth).json()
    assert len(second['items']) == 2 and second['next_cursor'] is None
    assert {item['id'] for item in first['items'] + second['items']} == set(keys)
    other = login(case.client, 'history-other-owner')
    assert case.client.get('/v1/documents?before=' + first['next_cursor'], headers=other).status_code == 404
    assert case.client.get('/v1/documents?limit=51', headers=case.auth).status_code == 422
