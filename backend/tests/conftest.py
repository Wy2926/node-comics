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


def submit_asset(client, headers, asset_id, key="operation-1", language="zh-Hans", mode="redraw", **fields):
    from app.db import session_factory
    from app.models import Asset
    with session_factory()() as db:
        asset = db.get(Asset, asset_id)
        item = {"client_item_id": "page-1", "asset_id": asset.id, "image_sha256": asset.sha256,
                "byte_size": asset.byte_size, "content_type": asset.mime, "name": "sample.png"}
    action = fields.pop("action", "regenerate" if fields.pop("regenerate", False) else "ensure")
    source_job_id = fields.pop("source_job_id", fields.pop("rerun_job_id", None))
    plan_item = {"page_key": "page-1", "operation_key": key, "role": "current", "mode": mode,
                 "target_language": language, "max_quota_pages": 1, "image": item, "action": action, **fields}
    if source_job_id is not None:
        plan_item["source_job_id"] = source_job_id
    return client.post("/v1/translation-plans", headers=headers,
                       json={"trigger": "manual", "items": [plan_item]})


def create(client, headers, asset_id, key="operation-1", language="zh-Hans"):
    """Extract the first job for worker fixtures, retaining the real HTTP status.

    Admission contract tests use submit_asset directly and inspect dispositions.
    This helper does not manufacture legacy status codes or accepted receipts.
    """
    import httpx
    response = submit_asset(client, headers, asset_id, key, language)
    data = response.json()
    if data.get("items"):
        item = data["items"][0]
        data = item.get("job") or {"error": item}
    return httpx.Response(response.status_code, json=data)


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
