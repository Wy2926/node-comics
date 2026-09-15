from conftest import quota_usage
from datetime import timedelta
import pytest
from conftest import create, login_plus as login, preview, upload


def rerun(client, auth, job_id, confirmed, key="rerun-confirmed", **overrides):
    body = {"preview_id": confirmed["id"], "max_quota_pages": confirmed["quota_pages"], **overrides}
    return client.post(f"/v1/jobs/{job_id}/rerun", headers={**auth, "Idempotency-Key": key}, json=body)


@pytest.mark.parametrize("change", ["membership", "provider_profile", "expired"])
def test_rerun_rejects_changed_or_expired_confirmed_quote_without_reserving(client, png, change):
    from app.config import settings
    from app.db import session_factory
    from app.models import Provider, TranslationPreview, now
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    confirmed = preview(client, auth, asset)
    if change == "membership":
        with session_factory()() as db:
            from app.models import Job, User, uid
            db.get(User, db.get(Job, job_id).owner_id).membership_id = uid()
            db.commit()
    else:
        with session_factory()() as db:
            if change == "provider_profile":
                provider = db.get(Provider, "default")
                provider.config = {**provider.config, "parameters": {"quality": "high"}}
            else:
                db.get(TranslationPreview, confirmed["id"]).expires_at = now() - timedelta(seconds=1)
            db.commit()
    response = rerun(client, auth, job_id, confirmed)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == ("PREVIEW_EXPIRED" if change == "expired" else "ENTITLEMENT_CHANGED" if change == "membership" else "PREVIEW_CHANGED")
    assert quota_usage(client, auth)["reserved"] == 1
    assert client.get("/v1/jobs", headers=auth).json()["total"] == 1


def test_rerun_requires_and_honors_explicit_maximum_budget(client, png):
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    confirmed = preview(client, auth, asset)
    missing = client.post(f"/v1/jobs/{job_id}/rerun", headers={**auth, "Idempotency-Key": "no-budget"}, json={})
    assert missing.status_code == 422
    response = rerun(client, auth, job_id, confirmed, max_quota_pages=0)
    assert response.status_code == 409 and response.json()["error"]["code"] == "QUOTA_BOUND_EXCEEDED"
    assert quota_usage(client, auth)["reserved"] == 1


def test_confirmed_rerun_replay_survives_later_membership_change_and_quote_expiration(client, png):
    from app.config import settings
    from app.db import session_factory
    from app.models import TranslationPreview, now
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    confirmed = preview(client, auth, asset)
    first = rerun(client, auth, job_id, confirmed)
    assert first.status_code == 202 and first.json()["quota_pages"] == 1
    assert first.json()["id"] != job_id and not first.json()["cache_hit"]
    with session_factory()() as db:
        from app.models import Job, User
        db.get(User, db.get(Job, job_id).owner_id).plus_expires_at = now()
        db.commit()
    with session_factory()() as db:
        db.get(TranslationPreview, confirmed["id"]).expires_at = now() - timedelta(minutes=1)
        db.commit()
    repeated = rerun(client, auth, job_id, confirmed)
    assert repeated.status_code == 202 and repeated.json()["id"] == first.json()["id"]
    assert len(quota_usage(client, auth, "classic")["items"]) == 2
    assert client.get("/v1/jobs", headers=auth).json()["total"] == 2
    changed_budget = rerun(client, auth, job_id, confirmed, max_quota_pages=80)
    assert changed_budget.status_code == 409 and changed_budget.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"


@pytest.mark.parametrize("scope", ["other_user", "other_asset", "other_language"])
def test_rerun_quote_is_bound_to_owner_source_and_language(client, png, scope):
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    if scope == "other_user":
        other_auth = login(client, "bob")
        confirmed = preview(client, other_auth, upload(client, other_auth, png))
    elif scope == "other_asset":
        confirmed = preview(client, auth, upload(client, auth, png))
    else:
        confirmed = preview(client, auth, asset, language="en")
    response = rerun(client, auth, job_id, confirmed)
    assert response.status_code == (404 if scope == "other_user" else 409)
    assert quota_usage(client, auth)["reserved"] == 1


def test_unknown_rerun_requires_both_quote_and_acknowledgement(client, png):
    from app.db import session_factory
    from app.models import Job, now
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    with session_factory()() as db:
        job = db.get(Job, job_id)
        job.status, job.unknown_since = "outcome_unknown", now()
        db.commit()
    confirmed = preview(client, auth, asset)
    refused = rerun(client, auth, job_id, confirmed)
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "UNKNOWN_COST_ACK_REQUIRED"
    accepted = rerun(client, auth, job_id, confirmed, acknowledge_unknown_cost=True)
    assert accepted.status_code == 202 and accepted.json()["id"] != job_id
    assert quota_usage(client, auth)["reserved"] == 2
