from io import BytesIO
import sys
from pathlib import Path
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def isolated_identity_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("ADMIN_WEB_PATH", "/console-test/")
    monkeypatch.setenv("DEV_AUTH_SECRET", "isolated-tests-signing-key-never-used-in-production")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    monkeypatch.setenv("STORAGE_PATH", str(tmp_path / "objects"))
    monkeypatch.setenv("RESULT_STORAGE_BACKEND", "local")
    monkeypatch.setenv("RETENTION_DAYS", "7")
    monkeypatch.setenv("R2_ENDPOINT_URL", "")
    monkeypatch.setenv("DEV_AUTH", "true")
    monkeypatch.setenv("DEV_AUTH_SECRET", "isolated-tests-signing-key-never-used-in-production")
    monkeypatch.setenv("OPENAI_API_KEY", "isolated-test-provider-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://provider.example/v1")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-image-2")
    monkeypatch.setenv("PROVIDERS_JSON", "")
    monkeypatch.setenv("CLASSIC_ENABLED", "false")
    from app.config import settings
    from app.db import engine
    settings.cache_clear()
    if engine.cache_info().currsize:
        engine().dispose()
    engine.cache_clear()
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db import session_factory
    from translation_fixtures import configure_text_provider
    with TestClient(app) as test_client:
        with session_factory()() as db:
            configure_text_provider(db)
        yield test_client
    engine().dispose()
    engine.cache_clear()
    settings.cache_clear()


@pytest.fixture
def png():
    buffer = BytesIO()
    Image.new("RGB", (320, 480), (235, 229, 248)).save(buffer, "PNG")
    return buffer.getvalue()


def login(client, name="alice"):
    response = client.post("/v1/auth/dev", json={"username": name})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def login_plus(client, name="alice"):
    """Explicit PLUS fixture for supplier/lifecycle tests, without unrelated audit rows."""
    from sqlalchemy import select
    from app.db import session_factory
    from app.entitlements import month_boundary
    from app.models import User, now, uid
    auth = login(client, name)
    with session_factory()() as db:
        user = db.scalar(select(User).where(User.subject == "dev:" + name))
        if not user.membership_id:
            user.membership_id = uid()
            user.plus_started_at = now()
            user.plus_timezone = "Asia/Shanghai"
            user.plus_expires_at = month_boundary(user.plus_started_at, 12, user.plus_timezone)
            user.plus_monthly_pages = 300
            db.commit()
    return auth


def quota_usage(client, auth, mode="redraw"):
    data = client.get("/v1/me/usage", headers=auth).json()
    return {**data["entitlements"]["modes"][mode]["quota"], "items": data["items"]}


def upload(client, headers, png):
    """Prepare an existing private original; upload HTTP is tested by cluster submissions."""
    import jwt
    from sqlalchemy import select
    from app.db import session_factory
    from app.assets import create_asset
    from app.models import User
    subject = jwt.decode(headers["Authorization"].split()[1], options={"verify_signature": False})["sub"]
    with session_factory()() as db:
        user = db.scalar(select(User).where(User.subject == subject))
        asset = create_asset(db, user.id, png)
        db.commit()
        return asset.id


def request_id(key):
    """Stable valid public UUIDs for readable isolated fixture names."""
    from uuid import UUID, NAMESPACE_URL, uuid5
    try:
        return str(UUID(key))
    except ValueError:
        return str(uuid5(NAMESPACE_URL, "node-comics-test:" + key))


def request_record(client, headers, translation_id):
    from app.db import session_factory
    from app.translation_requests import TranslationRequest
    owner = client.get("/v1/me", headers=headers).json()["user"]["id"]
    with session_factory()() as db:
        return db.get(TranslationRequest, (owner, request_id(translation_id)))


def request_for_job(client, headers, job_id):
    from sqlalchemy import select
    from app.db import session_factory
    from app.translation_requests import TranslationRequest
    owner = client.get("/v1/me", headers=headers).json()["user"]["id"]
    with session_factory()() as db:
        return db.scalar(select(TranslationRequest.id).where(
            TranslationRequest.owner_id == owner,
            (TranslationRequest.job_id == job_id) | (TranslationRequest.access_id == job_id)))


def submit_asset(client, headers, asset_id, key="operation-1", language="zh-Hans", mode="redraw", **fields):
    from app.db import session_factory
    from app.models import Asset
    with session_factory()() as db:
        asset = db.get(Asset, asset_id)
        body = {"image": {"sha256": asset.sha256, "byte_size": asset.byte_size, "content_type": asset.mime},
                "mode": mode, "target_language": language}
    action = fields.pop("action", "regenerate" if fields.pop("regenerate", False) else "ensure")
    source = fields.pop("source_job_id", fields.pop("rerun_job_id", None))
    if action != "ensure":
        assert source is not None, "Explicit retry/regeneration fixture requires its source"
        body = {action + "_of": request_for_job(client, headers, source)}
    body.update(fields)
    return client.put("/v1/translations/" + request_id(key), headers=headers, json=body)


def internal_job_response(client, headers, response):
    """Resolve worker fixture jobs from a real translation response, preserving HTTP status.

    Public contract tests inspect the original response. Worker/settlement tests use
    the actual persisted job, never a synthetic public cache-as-job response.
    """
    import httpx
    from app.db import session_factory
    from app.jobs import job_json
    from app.models import Job
    data = response.json()
    if response.status_code < 300 and "id" in data:
        record = request_record(client, headers, data["id"])
        with session_factory()() as db:
            job = db.get(Job, record.job_id) if record.job_id else None
            if job is not None:
                data = job_json(db, job)
    return httpx.Response(response.status_code, json=data)


def create(client, headers, asset_id, key="operation-1", language="zh-Hans", mode="redraw", **fields):
    return internal_job_response(client, headers,
        submit_asset(client, headers, asset_id, key, language, mode, **fields))


def inspect_job(job_id):
    """Read a real persisted worker state; this does not emulate a removed HTTP API."""
    from app.db import session_factory
    from app.jobs import job_json
    from app.models import Job
    with session_factory()() as db:
        return job_json(db, db.get(Job, job_id))


def control_node(db, stage="redraw"):
    from app.queue_models import ComputeNode
    node_id = "test-control-" + stage
    if not db.get(ComputeNode, node_id):
        db.add(ComputeNode(applied_config_version=1, supported_languages=['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko'], id=node_id, name=node_id, resource_id=node_id, capabilities=[stage], capacity=1,
                           engine_version="control", device="network"))
        db.flush()
    return node_id


def claim_job(job_id):
    from app.db import session_factory
    from app.models import Job
    from app.scheduler import claim_stage
    with session_factory()() as db:
        job = db.get(Job, job_id)
        node_id = control_node(db, "redraw" if job.mode == "redraw" else "text")
        lease = claim_stage(db, node_id)
        db.commit()
        return lease.id if lease else None


def run_job(job_id):
    from app.workers import run_control_stage
    lease_id = claim_job(job_id)
    if lease_id:
        run_control_stage(lease_id)


def png_variant(png, index):
    """Distinct valid page bytes for tests that need independent billable jobs."""
    image = Image.open(BytesIO(png)).copy()
    image.putpixel((0, 0), (index % 256, index // 256, 0))
    buffer = BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def configure_system_limits(**values):
    """Update isolated database settings, never process-local runtime fallbacks."""
    from app.db import session_factory
    from app.models import now
    from app.system_settings import RequestLimits, initialize_system_settings
    with session_factory()() as db:
        row = initialize_system_settings(db)
        row.values = RequestLimits.model_validate({**row.values, **values}).model_dump()
        row.version += 1
        row.updated_at = now()
        db.commit()
