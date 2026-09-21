"""Feedback treatment targets the exact version, and concurrent decisions cannot overwrite."""
from concurrent.futures import ThreadPoolExecutor
import pytest
from sqlalchemy import func, select
from conftest import create, login_plus as login, upload
from test_file_pages import complete


def fixture_feedback(client, png, monkeypatch):
    auth = login(client)
    job = complete(client, auth, upload(client, auth, png), png, monkeypatch)
    response = client.post(f"/v1/jobs/{job['id']}/feedback", headers={**auth, 'Idempotency-Key': 'feedback'},
        json={'issues': ['meaning'], 'comment': 'test version'})
    assert response.status_code == 201, response.text
    return auth, job, response.json()


def test_feedback_filters_link_reused_version_and_do_not_expose_private_keys(client, png, monkeypatch):
    auth, job, feedback = fixture_feedback(client, png, monkeypatch)
    other, admin = login(client, 'other'), login(client, 'admin')
    reused = create(client, other, upload(client, other, png)).json()
    assert reused['id'] != job['id'] and reused['cache_hit']
    assert client.post(f"/v1/jobs/{reused['id']}/feedback", headers={**other, 'Idempotency-Key': 'reuse'},
        json={'issues': ['typesetting']}).status_code == 201
    path = '/v1/admin/feedback'
    assert client.get(path, headers=auth).status_code == 403
    page = client.get(path + f"?job_id={job['id']}&limit=1", headers=admin).json()
    assert page['total'] == 2 and page['next_offset'] == 1
    all_rows = client.get(path + f"?job_id={job['id']}", headers=admin).json()['items']
    assert {row['actual_job_id'] for row in all_rows} == {job['id']}
    assert {row['access_id'] for row in all_rows} == {None, reused['id']}
    assert all(row['result_version'] == 1 and 'request_hash' not in row and 'idempotency_key' not in row for row in all_rows)
    assert client.get(path + '?issue=meaning&status=received', headers=admin).json()['total'] == 1
    assert client.get(path + '?issue=other', headers=admin).json()['total'] == 0
    owner = client.get('/v1/me', headers=other).json()['user']['id']
    assert client.get(path + f'?owner_id={owner}', headers=admin).json()['total'] == 1


def test_review_requires_note_and_fresh_version_and_replays_original_receipt(client, png, monkeypatch):
    from app.admin_audit import AdminAudit
    from app.db import session_factory
    from app.feedback_review_models import FeedbackReview
    auth, job, feedback = fixture_feedback(client, png, monkeypatch)
    admin = login(client, 'admin')
    path = f"/v1/admin/feedback/{feedback['id']}"
    body = {'status': 'reviewing', 'expected_status': feedback['status'], 'expected_updated_at': feedback['updated_at'], 'note': 'check version'}
    headers = {**admin, 'Idempotency-Key': 'review'}
    assert client.patch(path, headers=auth, json=body).status_code == 403
    assert client.patch(path, headers=headers, json={**body, 'note': '  '}).status_code == 422
    first = client.patch(path, headers=headers, json=body)
    assert first.status_code == 200, first.text
    assert first.json()['reviewer_name'] == 'admin' and first.json()['review_note'] == body['note']
    assert client.patch(path, headers=headers, json=body).json() == first.json()
    assert client.patch(path, headers=headers, json={**body, 'note': 'changed'}).status_code == 409
    assert client.patch(path, headers={**admin, 'Idempotency-Key': 'stale'}, json={**body, 'status': 'resolved'}).json()['error']['code'] == 'FEEDBACK_CHANGED'
    latest = first.json()
    resolve = {**body, 'status': 'resolved', 'expected_status': latest['status'], 'expected_updated_at': latest['updated_at'], 'note': 'verified'}
    assert client.patch(path, headers={**admin, 'Idempotency-Key': 'resolve'}, json=resolve).status_code == 200
    assert client.patch(path, headers=headers, json=body).json() == first.json()
    history = client.get(path + '/reviews?limit=1', headers=admin).json()
    assert history['total'] == 2 and history['next_offset'] == 1
    assert history['items'][0]['to_status'] == 'resolved'
    assert client.get(path, headers=admin).json()['status'] == 'resolved'
    assert client.get(path + '/reviews', headers=auth).status_code == 403
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(FeedbackReview)) == 2
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(AdminAudit.action == 'feedback.review')) == 2


@pytest.mark.parametrize('same_key', [False, True])
def test_concurrent_feedback_decisions_allow_one_fresh_write(client, png, monkeypatch, same_key):
    auth, job, feedback = fixture_feedback(client, png, monkeypatch)
    admin = login(client, 'admin')
    path = f"/v1/admin/feedback/{feedback['id']}"
    body = {'status': 'reviewing', 'expected_status': 'received', 'expected_updated_at': feedback['updated_at'], 'note': 'concurrent'}
    def review(key):
        return client.patch(path, headers={**admin, 'Idempotency-Key': key}, json=body).status_code
    with ThreadPoolExecutor(max_workers=2) as executor:
        codes = list(executor.map(review, ['decision-a', 'decision-a' if same_key else 'decision-b']))
    assert sorted(codes) == ([200, 200] if same_key else [200, 409])
    assert client.get(path + '/reviews', headers=admin).json()['total'] == 1
