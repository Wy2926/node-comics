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
    monkeypatch.setenv("DEV_AUTH", "true")
    monkeypatch.setenv("DEV_AUTH_SECRET", "isolated-tests-signing-key-never-used-in-production")
    monkeypatch.setenv("OPENAI_API_KEY", "isolated-test-provider-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://provider.example/v1")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-image-2")
    monkeypatch.setenv("PROVIDERS_JSON", "")
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


def upload(client, headers, png):
    response = client.post("/v1/images", headers=headers, files={"image": ("sample.png", png, "image/png")})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def create(client, headers, asset_id, key="operation-1", language="zh-Hans"):
    return client.post("/v1/translations/redraw", headers={**headers, "Idempotency-Key": key}, data={"asset_id": asset_id, "target_language": language})


def quote(client, headers, asset_id, language="zh-Hans"):
    response = client.post("/v1/quotes", headers=headers, json={"asset_ids": [asset_id], "mode": "redraw", "target_language": language})
    assert response.status_code == 201, response.text
    return response.json()
