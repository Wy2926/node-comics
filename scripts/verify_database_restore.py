"""Exercise PostgreSQL backup/restore using only newly created synthetic databases.

Requires the same explicit TEST_PG_* connection as the concurrency suite, plus
TEST_PG_CONTAINER when PostgreSQL client utilities are supplied by Docker.
"""
import argparse
from datetime import datetime, timezone
from io import BytesIO
import json
import os
from pathlib import Path
import sys
from uuid import uuid4
import psycopg
from psycopg import sql
from PIL import Image
from sqlalchemy.engine import URL
from database_backup import BackupError, backup, restore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get("RUN_POSTGRES_CONCURRENCY") != "1" or os.environ.get("TEST_PG_DATABASE") != "nodecomics_concurrency_test":
        raise RuntimeError("Only the explicitly enabled isolated concurrency PostgreSQL server is supported")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    prefix = "nodecomics_restore_" + uuid4().hex[:12]
    source, target = prefix + "_source", prefix + "_target"
    params = {"host": os.environ["TEST_PG_HOST"], "port": int(os.environ["TEST_PG_PORT"]),
              "user": os.environ["TEST_PG_USER"], "password": os.environ["TEST_PG_PASSWORD"], "connect_timeout": 10}
    container = os.environ.get("TEST_PG_CONTAINER")
    base = URL.create("postgresql+psycopg", username=params["user"], password=params["password"],
                      host=params["host"], port=params["port"])
    created = set()
    try:
        with psycopg.connect(**params, dbname="postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(source)))
            created.add(source)
        os.environ.update(APP_ENV="test", DEV_AUTH="true", RESULT_STORAGE_BACKEND="local", R2_ENDPOINT_URL="",
                          DEV_AUTH_SECRET="isolated-restore-proof-no-production-access",
                          DATABASE_URL=base.set(database=source).render_as_string(hide_password=False),
                          STORAGE_PATH=str(output / "synthetic-objects"))
        os.environ["RESTORE_DRILL_URL"] = base.set(database=target).render_as_string(hide_password=False)
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
        from app.config import settings
        from app.db import engine, initialize, session_factory
        from app.models import User
        from app.assets import create_asset
        settings.cache_clear()
        initialize()
        buffer = BytesIO()
        Image.new("RGB", (64, 96), "white").save(buffer, "PNG")
        with session_factory()() as db:
            users = [User(subject="restore-test:" + name, name=name) for name in ("alice", "bob")]
            db.add_all(users)
            db.flush()
            for user in users:
                create_asset(db, user.id, buffer.getvalue())
            db.commit()
        manifest = backup(output / "backup", database_env="DATABASE_URL", pg_container=container)
        # A later write must not alter the restored snapshot.
        with session_factory()() as db:
            db.add(User(subject="restore-test:after-backup", name="after-backup"))
            db.commit()
        created.add(target)  # Restore may create the database before reporting a failure.
        result = restore(output / "backup", database_env="RESTORE_DRILL_URL", pg_container=container,
                         reference_output=output / "object-references.json")
        assert result["table_rows"]["public.users"] == 2
        assert result["table_rows"]["public.assets"] == 2
        assert result["object_references"] == 1
        with psycopg.connect(**params, dbname=target) as restored:
            assert restored.execute("SELECT version_num FROM alembic_version").fetchone() == ("reading_0001",)
        try:
            restore(output / "backup", database_env="RESTORE_DRILL_URL", pg_container=container)
        except BackupError as error:
            assert "already exists" in str(error)
        else:
            raise AssertionError("Restore replaced an existing database")
        report = {"verified_at": datetime.now(timezone.utc).isoformat(), "database": "PostgreSQL 17 isolated synthetic drill",
                  "snapshot_sha256": manifest["sha256"], "snapshot_bytes": manifest["size"],
                  "restored_users": result["table_rows"]["public.users"], "restored_asset_grants": result["table_rows"]["public.assets"],
                  "schema_revision": "reading_0001",
                  "shared_object_references": result["object_references"], "overwrite_rejected": True,
                  "post_backup_write_excluded": True, "r2_accessed": False, "production_accessed": False}
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
    finally:
        if "app.db" in sys.modules:
            sys.modules["app.db"].engine().dispose()
        with psycopg.connect(**params, dbname="postgres", autocommit=True) as admin:
            for database in created:
                assert database.startswith(prefix + "_") and database in {source, target}
                admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(database)))


if __name__ == "__main__":
    main()
