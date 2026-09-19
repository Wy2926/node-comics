"""Regeneration uses per-image budgets and bound source identity."""
from datetime import timedelta
import hashlib
import pytest
from sqlalchemy import func, select
from conftest import create, login_plus as login, upload, submit_asset, quota_usage, png_variant


def rerun(client, auth, job_id, asset_id, key="rerun-confirmed", **fields):
    return submit_asset(client, auth, asset_id, key=key, regenerate=True, rerun_job_id=job_id, **fields)


def test_rerun_honors_per_image_maximum_budget(client, png):
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    # Explicit zero confirmation may never be widened by the server.
    response = rerun(client, auth, job_id, asset, max_quota_pages=0)
    assert response.status_code == 200 and response.json()["items"][0]["code"] == "QUOTA_BOUND_EXCEEDED"
    assert quota_usage(client, auth)["reserved"] == 1


def test_rerun_checks_current_entitlement_kind_before_reserving(client, png):
    auth = login(client)
    asset = upload(client, auth, png)
    job_id = create(client, auth, asset).json()["id"]
    response = rerun(client, auth, job_id, asset, expected_kind="redraw_grant")
    assert response.status_code == 200 and response.json()["items"][0]["code"] == "ENTITLEMENT_CHANGED"
    assert quota_usage(client, auth)["reserved"] == 1


def test_confirmed_rerun_replay_survives_later_membership_and_provider_change(client, png):
    from app.db import session_factory
    from app.models import Job, Ledger, Provider, User, now
    auth = login(client)
    asset = upload(client, auth, png)
    original = create(client, auth, asset).json()
    first = rerun(client, auth, original["id"], asset)
    assert first.status_code == 202 and first.json()["items"][0]["disposition"] == "accepted"
    revised = first.json()["items"][0]["job"]
    assert revised["id"] != original["id"] and revised["version"] > original["version"]
    with session_factory()() as db:
        db.get(User, db.get(Job, original["id"]).owner_id).plus_expires_at = now() - timedelta(seconds=1)
        db.get(Provider, "default").enabled = False
        db.commit()
    repeated = rerun(client, auth, original["id"], asset)
    assert repeated.status_code == 200 and repeated.json()["items"][0]["job"]["id"] == first.json()["items"][0]["job"]["id"]
    conflict = rerun(client, auth, original["id"], asset, max_quota_pages=0)
    assert conflict.status_code == 200 and conflict.json()["items"][0]["code"] == "IDEMPOTENCY_CONFLICT"
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
    assert response.status_code == 200 and response.json()["items"][0]["disposition"] == "blocked"


def test_rerun_accepts_reimported_identical_bytes(client, png):
    auth = login(client)
    original = upload(client, auth, png)
    job_id = create(client, auth, original).json()["id"]
    alias = upload(client, auth, png)
    response = rerun(client, auth, job_id, alias)
    assert response.status_code == 202 and response.json()["items"][0]["disposition"] == "accepted"


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
    assert refused.status_code == 200 and refused.json()["items"][0]["code"] == "UNKNOWN_COST_ACK_REQUIRED"
    accepted = rerun(client, auth, job_id, asset, acknowledge_unknown_cost=True)
    assert accepted.status_code == 202 and accepted.json()["items"][0]["job"]["id"] != job_id
    assert quota_usage(client, auth)["reserved"] == 2
