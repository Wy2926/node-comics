from io import BytesIO
import sys
from pathlib import Path
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    monkeypatch.setenv("STORAGE_PATH", str(tmp_path / "objects"))
    monkeypatch.setenv("RESULT_STORAGE_BACKEND", "local")
    monkeypatch.setenv("R2_ENDPOINT_URL", "")
    monkeypatch.setenv("DEV_AUTH", "true")
    monkeypatch.setenv("DEV_AUTH_SECRET", "isolated-tests-signing-key-never-used-in-production")
    monkeypatch.setenv("OPENAI_API_KEY", "isolated-test-provider-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://provider.example/v1")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-image-2")
    monkeypatch.setenv("PROVIDERS_JSON", "")
    monkeypatch.setenv("CLASSIC_ENABLED", "false")
    monkeypatch.setenv("TEXT_API_KEY", "isolated-test-text-key")
    monkeypatch.setenv("TEXT_BASE_URL", "https://text.example/v1")
    monkeypatch.setenv("CLASSIC_ENGINE_TOKEN", "isolated-engine-token")
    from app.config import settings
    from app.db import engine
    settings.cache_clear()
    if engine.cache_info().currsize:
        engine().dispose()
    engine.cache_clear()
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as test_client:
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
    response = client.post("/v1/images", headers=headers, files={"image": ("sample.png", png, "image/png")})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def create(client, headers, asset_id, key="operation-1", language="zh-Hans"):
    return client.post("/v1/translations/redraw", headers={**headers, "Idempotency-Key": key}, data={"asset_id": asset_id, "target_language": language})


def preview(client, headers, asset_id, language="zh-Hans"):
    response = client.post("/v1/translation-previews", headers=headers, json={"asset_ids": [asset_id], "mode": "redraw", "target_language": language, "regenerate": True})
    assert response.status_code == 201, response.text
    return response.json()


def admit_pending():
    """Exercise the real durable scheduler, without Redis or a paid supplier."""
    from app.scheduler import admit_jobs
    return admit_jobs()


def run_job(job_id):
    from app.workers import process_job
    admit_pending()
    return process_job.run(job_id, admission_token_for(job_id))


def claim_job(job_id):
    from app.workers import claim
    admit_pending()
    return claim(job_id, admission_token_for(job_id))


def admission_token_for(job_id):
    from app.db import session_factory
    from app.queue_models import QueueAdmission
    with session_factory()() as db:
        admission = db.get(QueueAdmission, job_id)
        return admission.token if admission else None


def png_variant(png, index):
    """Distinct valid page bytes for tests that need independent billable jobs."""
    image = Image.open(BytesIO(png)).copy()
    image.putpixel((0, 0), (index % 256, index // 256, 0))
    buffer = BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()
