"""Opt-in monitoring query and migration checks against an isolated PostgreSQL schema."""
import os
import pytest
from test_postgres_concurrency import pg_scope  # noqa: F401

pytestmark = pytest.mark.skipif(os.environ.get("RUN_POSTGRES_CONCURRENCY") != "1", reason="Requires isolated PostgreSQL test database")


def test_postgres_monitor_queries_and_schema(pg_scope):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db import session_factory, engine, Base
    from app.config import settings
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from admin_fixture import seed, DONE_ID
    from conftest import login
    with TestClient(app) as client:
        auth = login(client, settings().dev_admin_username)
        with session_factory()() as db:
            seed(db)
        for path in ("overview", "nodes", "tasks", "users", "users?plan=free", "tasks/"+DONE_ID):
            response = client.get("/v1/admin/monitor/"+path, headers=auth)
            assert response.status_code == 200, response.text
        overview = client.get("/v1/admin/monitor/overview", headers=auth).json()
        assert overview["users"]["plus"] == 1
        assert all(r["avg_elapsed_seconds"] == 120 for r in overview["completed_24h"])
        nodes = client.get("/v1/admin/monitor/nodes", headers=auth).json()["items"]
        assert next(n for n in nodes if n["id"] == "gpu-a")["completed_24h"][0]["avg_seconds"] == 25
        with engine().connect() as connection:
            assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []
