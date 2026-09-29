import importlib.util
import json
from pathlib import Path
import sqlite3
from unittest.mock import patch
from types import SimpleNamespace
import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "database_backup.py"
spec = importlib.util.spec_from_file_location("database_backup", SCRIPT)
backup_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup_tool)


def test_sqlite_online_backup_restores_snapshot_and_refuses_overwrite(tmp_path):
    source = tmp_path / "source.db"
    with sqlite3.connect(source) as database:
        database.executescript("CREATE TABLE documents(id INTEGER PRIMARY KEY, title TEXT NOT NULL); INSERT INTO documents VALUES (1, 'synthetic comic');")
    destination = tmp_path / "backup"
    manifest = backup_tool.backup(destination, sqlite_source=source)
    assert manifest["objects_included"] is False
    with sqlite3.connect(source) as database:
        database.execute("DELETE FROM documents")
    target = tmp_path / "restore-drill.db"
    result = backup_tool.restore(destination, sqlite_target=target, reference_output=tmp_path / "objects.json")
    assert result["status"] == "verified" and result["table_rows"]["documents"] == 1
    with sqlite3.connect(target) as database:
        assert database.execute("SELECT title FROM documents").fetchone() == ("synthetic comic",)
    with pytest.raises(FileExistsError):
        backup_tool.restore(destination, sqlite_target=target)
    with pytest.raises(backup_tool.BackupError, match="Isolated SQLite"):
        backup_tool.restore(destination, sqlite_target=source)


def test_modified_backup_is_rejected_before_creating_restore_target(tmp_path):
    source = tmp_path / "source.db"
    with sqlite3.connect(source) as database:
        database.execute("CREATE TABLE example(id INTEGER)")
    destination = tmp_path / "backup"
    backup_tool.backup(destination, sqlite_source=source)
    with (destination / "database.sqlite3").open("ab") as output:
        output.write(b"corrupted")
    target = tmp_path / "restore-corrupt.db"
    with pytest.raises(backup_tool.BackupError, match="checksum"):
        backup_tool.restore(destination, sqlite_target=target)
    assert not target.exists()


def test_backup_exports_private_task_files_separately(client, png, tmp_path):
    from conftest import login, upload
    from app.config import settings
    upload(client, login(client, "alice"), png)
    upload(client, login(client, "bob"), png)
    source = settings().database_url.removeprefix("sqlite:///")
    destination = tmp_path / "backup"
    backup_tool.backup(destination, sqlite_source=source)
    inventory = tmp_path / "references.json"
    result = backup_tool.restore(destination, sqlite_target=tmp_path / "restore-application.db", reference_output=inventory)
    assert result["table_rows"]["assets"] == 2
    objects = json.loads(inventory.read_text())["objects"]
    assert len(objects) == 2 and all(item["kind"] == "temporary-input" and not item["required"] for item in objects)
    assert objects[0]["key"] != objects[1]["key"]
    assert result["objects_verified"] is False


def test_inventory_excludes_purged_originals_and_uses_reservation_paths():
    with sqlite3.connect(':memory:') as database:
        database.executescript('''
            CREATE TABLE assets (storage_key TEXT, sha256 TEXT, mime TEXT, kind TEXT, deleted_at TEXT, purged_at TEXT);
            CREATE TABLE upload_reservations (id TEXT, expected_sha256 TEXT, mime TEXT, verified_info TEXT, completed_at TEXT);
        ''')
        database.execute('INSERT INTO assets VALUES (?, ?, ?, ?, NULL, ?)',
            ('inputs/finished/source', 'a' * 64, 'image/png', 'original', '2026-09-29'))
        database.execute('INSERT INTO assets VALUES (?, ?, ?, ?, NULL, NULL)',
            ('results/aa/artifact', 'b' * 64, 'image/webp', 'classic'))
        database.execute('INSERT INTO upload_reservations VALUES (?, ?, ?, ?, NULL)',
            ('reservation-id', 'c' * 64, 'image/png', json.dumps({'sha256': 'c' * 64})))
        database.execute('INSERT INTO upload_reservations VALUES (?, ?, ?, ?, NULL)',
            ('no-bytes', 'd' * 64, 'image/png', 'null'))
        inventory = backup_tool.object_references(database.execute, {'assets', 'upload_reservations'})
    assert {row['key'] for row in inventory} == {'results/aa/artifact', 'inputs/reservation-id/source'}
    assert [row['key'] for row in inventory if row['required']] == ['results/aa/artifact']


def test_postgres_restore_refuses_product_database_before_connecting(tmp_path, monkeypatch):
    destination = tmp_path / "backup"
    destination.mkdir()
    snapshot = destination / "database.dump"
    snapshot.write_bytes(b"synthetic custom dump")
    (destination / "manifest.json").write_text(json.dumps({"version": 1, "format": "postgresql-custom",
        "file": snapshot.name, "size": snapshot.stat().st_size, "sha256": backup_tool.checksum(snapshot)}))
    monkeypatch.setenv("RESTORE_UNIT_TEST_URL", "postgresql://test:synthetic-password@127.0.0.1/nodecomics_production")
    with patch("psycopg.connect") as connect:
        with pytest.raises(backup_tool.BackupError, match="Isolated PostgreSQL"):
            backup_tool.restore(destination, database_env="RESTORE_UNIT_TEST_URL")
        connect.assert_not_called()


@pytest.mark.parametrize("wrong_port", [True, False])
def test_container_target_mismatch_is_rejected_before_database_creation(tmp_path, monkeypatch, wrong_port):
    destination = tmp_path / "backup"
    destination.mkdir()
    snapshot = destination / "database.dump"
    snapshot.write_bytes(b"synthetic custom dump")
    (destination / "manifest.json").write_text(json.dumps({"version": 1, "format": "postgresql-custom",
        "file": snapshot.name, "size": snapshot.stat().st_size, "sha256": backup_tool.checksum(snapshot)}))
    monkeypatch.setenv("RESTORE_UNIT_TEST_URL", "postgresql://test:synthetic-password@127.0.0.1:15432/nodecomics_restore_unit")
    inspected = SimpleNamespace(returncode=0, stdout=json.dumps({"5432/tcp": [
        {"HostIp": "127.0.0.1", "HostPort": "25432" if wrong_port else "15432"}]}).encode())
    with patch.object(backup_tool.subprocess, "run", return_value=inspected), patch("psycopg.connect") as connect, \
            patch.object(backup_tool, "_run_pg_command") as run:
        connect.return_value.__enter__.return_value.execute.return_value.fetchone.return_value = ("host-server:started",)
        run.side_effect = lambda *args, **kwargs: kwargs["output"].write(b"other-server:started\n")
        with pytest.raises(backup_tool.BackupError, match="does not match"):
            backup_tool.restore(destination, database_env="RESTORE_UNIT_TEST_URL", pg_container="isolated-test-postgres")
        if wrong_port:
            connect.assert_not_called()
            run.assert_not_called()
        else:
            assert connect.call_count == 1
            execute = connect.return_value.__enter__.return_value.execute
            assert execute.call_count == 1 and "pg_control_system" in execute.call_args.args[0]
            assert run.call_args.args[0] == "psql"
