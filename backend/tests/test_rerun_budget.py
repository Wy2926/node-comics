"""Regeneration uses explicit per-submission budgets and bound source identity."""
from datetime import timedelta
import hashlib
import pytest
from sqlalchemy import func, select
from conftest import create, login_plus as login, upload, submit_asset, quota_usage, png_variant


def rerun(client, auth, job_id, asset_id, key="rerun-confirmed", **fields):
    return submit_asset(client, auth, asset_id, key=key, regenerate=True, rerun_job_id=job_id, **fields)


def test_rerun_requires_and_honors_explicit_maximum_budget(client, png):
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    body = {"mode": "redraw", "target_language": "zh-Hans", "regenerate": True, "rerun_job_id": job_id,
            "items": [{"client_item_id": "page", "asset_id": asset, "image_sha256": hashlib.sha256(png).hexdigest(),
                       "byte_size": len(png), "content_type": "image/png"}]}
    missing = client.post("/v1/translation-submissions", headers={**auth, "Idempotency-Key": "missing-budget"}, json=body)
    assert missing.status_code == 422
    response = rerun(client, auth, job_id, asset, max_quota_pages=0)
    assert response.status_code == 409 and response.json()["error"]["code"] == "QUOTA_BOUND_EXCEEDED"
    assert quota_usage(client, auth)["reserved"] == 1


def test_rerun_checks_current_entitlement_kind_before_reserving(client, png):
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    response = rerun(client, auth, job_id, asset, expected_kind="redraw_grant")
    assert response.status_code == 409 and response.json()["error"]["code"] == "ENTITLEMENT_CHANGED"
    assert quota_usage(client, auth)["reserved"] == 1


def test_confirmed_rerun_replay_survives_later_membership_and_provider_change(client, png):
    from app.db import session_factory
    from app.models import Job, Ledger, Provider, User, now
    auth = login(client)
    asset = upload(client, auth, png)
    original = create(client, auth, asset).json()
    first = rerun(client, auth, original["id"], asset)
    assert first.status_code == 202 and first.json()["quota_pages"] == 1
    revised = first.json()["items"][0]["job"]
    assert revised["id"] != original["id"] and revised["version"] > original["version"]
    with session_factory()() as db:
        db.get(User, db.get(Job, original["id"]).owner_id).plus_expires_at = now() - timedelta(seconds=1)
        db.get(Provider, "default").enabled = False
        db.commit()
    repeated = rerun(client, auth, original["id"], asset)
    assert repeated.status_code == 202 and repeated.json()["id"] == first.json()["id"]
    conflict = rerun(client, auth, original["id"], asset, max_quota_pages=80)
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 2
        assert db.scalar(select(func.count()).select_from(Ledger)) == 2


@pytest.mark.parametrize("scope", ["other_user", "other_image", "other_language", "other_mode"])
def test_rerun_is_bound_to_owner_source_mode_and_language(client, png, scope):
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    fields = {}
    if scope == "other_user":
        auth = login(client, "bob")
        asset = upload(client, auth, png)
    elif scope == "other_image":
        asset = upload(client, auth, png_variant(png, 17))
    elif scope == "other_language":
        fields["language"] = "en"
    else:
        fields["mode"] = "classic"
    response = rerun(client, auth, job_id, asset, **fields)
    assert response.status_code == (404 if scope == "other_user" else 409)


def test_rerun_accepts_reimported_identical_bytes(client, png):
    auth = login(client)
    original = upload(client, auth, png)
    job_id = create(client, auth, original).json()["id"]
    alias = upload(client, auth, png)
    response = rerun(client, auth, job_id, alias)
    assert response.status_code == 202 and response.json()["quota_pages"] == 1


def test_unknown_rerun_requires_explicit_acknowledgement_and_budget(client, png):
    from app.db import session_factory
    from app.models import Job, now
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    with session_factory()() as db:
        job = db.get(Job, job_id)
        job.status, job.unknown_since = "outcome_unknown", now()
        db.commit()
    refused = rerun(client, auth, job_id, asset)
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "UNKNOWN_COST_ACK_REQUIRED"
    accepted = rerun(client, auth, job_id, asset, acknowledge_unknown_cost=True)
    assert accepted.status_code == 202 and accepted.json()["items"][0]["job"]["id"] != job_id
    assert quota_usage(client, auth)["reserved"] == 2
