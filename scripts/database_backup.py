"""Explicit database backup and non-destructive isolated restore.

This command never imports application settings or reads an environment file.
PostgreSQL credentials are supplied through a named environment variable and
passed to client utilities through their environment, never command arguments.
Object storage must be backed up independently; a database dump contains keys,
not image bytes. See docs/OPERATIONS.md.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile


class BackupError(Exception):
    pass


def checksum(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def postgres_config(variable):
    from sqlalchemy.engine import make_url
    raw = os.environ.get(variable, "")
    if not raw:
        raise BackupError("The explicitly named database environment variable is empty")
    url = make_url(raw)
    if url.get_backend_name() != "postgresql" or not url.database or not url.username:
        raise BackupError("A PostgreSQL URL with an explicit database and user is required")
    allowed = {"sslmode", "sslrootcert", "sslcert", "sslkey", "connect_timeout"}
    if set(url.query) - allowed:
        raise BackupError("Unsupported PostgreSQL URL options")
    params = {"host": url.host or "127.0.0.1", "port": url.port or 5432,
              "user": url.username, "password": url.password or "", "dbname": url.database,
              "connect_timeout": 10, **dict(url.query)}
    return params


def pg_command(program, params, arguments, *, container=None, output=None, input_file=None):
    if container:
        verify_pg_container(params, container)
    _run_pg_command(program, params, arguments, container=container, output=output, input_file=input_file)


def _run_pg_command(program, params, arguments, *, container=None, output=None, input_file=None):
    names = {"host": "PGHOST", "port": "PGPORT", "user": "PGUSER", "password": "PGPASSWORD",
             "dbname": "PGDATABASE", "sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT",
             "sslcert": "PGSSLCERT", "sslkey": "PGSSLKEY", "connect_timeout": "PGCONNECT_TIMEOUT"}
    environment = {**{key: value for key, value in os.environ.items() if not key.startswith("PG")},
                   **{names[key]: str(value) for key, value in params.items()}}
    command = [program, *arguments]
    if container:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", container):
            raise BackupError("Invalid PostgreSQL client container name")
        command = ["docker", "exec", "-i", *[part for key in params for part in ("--env", names[key])],
                   container, *command]
        # --pg-container selects that PostgreSQL server's own client tools;
        # the host URL still addresses its published port for restore checks.
        environment.update(PGHOST="127.0.0.1", PGPORT="5432")
    result = subprocess.run(command, env=environment, stdin=input_file, stdout=output or subprocess.DEVNULL,
                            stderr=subprocess.PIPE, shell=False)
    if result.returncode:
        # Client stderr can contain host addresses or SQL data. Keep it out of
        # ordinary console logs and surface only the failed utility/status.
        raise BackupError(f"{program} failed with exit status {result.returncode}")


def verify_pg_container(params, container):
    """Fail closed unless host connections and Docker tools use the same server."""
    import psycopg
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", container):
        raise BackupError("Invalid PostgreSQL client container name")
    if params["host"] not in {"127.0.0.1", "localhost", "::1"}:
        raise BackupError("PostgreSQL container mode requires an explicit loopback published port")
    inspected = subprocess.run(["docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", container],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False)
    if inspected.returncode:
        raise BackupError("Cannot verify the PostgreSQL container port binding")
    ports = json.loads(inspected.stdout).get("5432/tcp") or []
    if not any(port["HostPort"] == str(params["port"]) and port["HostIp"] in {"", "0.0.0.0", "::", "127.0.0.1", "::1"} for port in ports):
        raise BackupError("PostgreSQL container published port does not match the explicit database URL")
    identity_query = "SELECT system_identifier::text || ':' || extract(epoch from pg_postmaster_start_time())::text FROM pg_control_system()"
    monitor = {**params, "dbname": "postgres"}
    with psycopg.connect(**monitor) as connection:
        host_identity = connection.execute(identity_query).fetchone()[0]
    with tempfile.TemporaryFile() as output:
        _run_pg_command("psql", monitor, ["--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1",
                        "--command", identity_query], container=container, output=output)
        output.seek(0)
        container_identity = output.read().decode("utf-8").strip()
    if not host_identity or host_identity != container_identity:
        raise BackupError("PostgreSQL container identity does not match the explicit database URL")


def sqlite_check(connection):
    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise BackupError("SQLite integrity check failed")
    if connection.execute("PRAGMA foreign_key_check").fetchone():
        raise BackupError("SQLite foreign key check failed")


def backup(destination, *, sqlite_source=None, database_env=None, pg_container=None):
    destination = Path(destination).resolve()
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    if sqlite_source:
        source = Path(sqlite_source).resolve(strict=True)
        snapshot = destination / "database.sqlite3"
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as incoming:
            with sqlite3.connect(snapshot) as outgoing:
                incoming.backup(outgoing)
                sqlite_check(outgoing)
        database_format = "sqlite"
    else:
        params = postgres_config(database_env)
        snapshot = destination / "database.dump"
        with snapshot.open("xb") as output:
            pg_command("pg_dump", params, ["--format=custom", "--no-owner", "--no-privileges"],
                       container=pg_container, output=output)
        with snapshot.open("rb") as incoming:
            pg_command("pg_restore", params, ["--list"], container=pg_container, input_file=incoming)
        database_format = "postgresql-custom"
    manifest = {"version": 1, "created_at": datetime.now(timezone.utc).isoformat(), "format": database_format,
                "file": snapshot.name, "size": snapshot.stat().st_size, "sha256": checksum(snapshot),
                "objects_included": False}
    manifest_path = destination / "manifest.json"
    with manifest_path.open("x", encoding="utf-8") as output:
        json.dump(manifest, output, indent=2)
        output.write("\n")
    return manifest


def verified_backup(directory):
    directory = Path(directory).resolve(strict=True)
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    names = {"sqlite": "database.sqlite3", "postgresql-custom": "database.dump"}
    expected = names.get(manifest.get("format"))
    if manifest.get("version") != 1 or not expected or manifest.get("file") != expected:
        raise BackupError("Unsupported backup manifest")
    snapshot = directory / expected
    if snapshot.is_symlink() or snapshot.stat().st_size != manifest["size"] or checksum(snapshot) != manifest["sha256"]:
        raise BackupError("Backup checksum or size does not match the manifest")
    return manifest, snapshot


def object_references(execute, tables):
    """Inventory from the restored snapshot, without touching object storage."""
    references = []
    if "assets" in tables:
        for backend, key, sha256, mime in execute("SELECT DISTINCT storage_backend, storage_key, sha256, mime FROM assets WHERE deleted_at IS NULL"):
            references.append({"backend": backend, "key": key, "sha256": sha256, "mime": mime, "kind": "asset"})
    if "execution_leases" in tables and "attempts" in tables and "jobs" in tables:
        for backend, key in execute("SELECT DISTINCT a.output_storage_backend, l.output_key FROM execution_leases l JOIN jobs j ON j.id = l.job_id JOIN attempts a ON a.id = j.attempt_id WHERE l.output_key IS NOT NULL AND l.completed_at IS NULL"):
            references.append({"backend": backend, "key": key, "kind": "pending-output"})
    if "upload_reservations" in tables:
        for backend, sha256, mime in execute("SELECT DISTINCT storage_backend, expected_sha256, mime FROM upload_reservations WHERE completed_at IS NULL AND verified_info IS NOT NULL"):
            key = f"objects/sha256/{sha256[:2]}/{sha256}"
            references.append({"backend": backend, "key": key, "sha256": sha256, "mime": mime, "kind": "pending-upload"})
    return references


def restore(directory, *, sqlite_target=None, database_env=None, pg_container=None, reference_output=None):
    manifest, snapshot = verified_backup(directory)
    if sqlite_target:
        if manifest["format"] != "sqlite":
            raise BackupError("Backup type does not match the restore target")
        target = Path(sqlite_target).resolve()
        if not re.fullmatch(r"restore-[A-Za-z0-9_.-]+\.(?:db|sqlite3)", target.name):
            raise BackupError("Isolated SQLite target must be named restore-*.db or restore-*.sqlite3")
        # Exclusive creation is the authorization boundary; never replace an
        # existing database, even when the operator supplies its path explicitly.
        with target.open("xb"):
            pass
        with sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True) as incoming:
            with sqlite3.connect(target) as outgoing:
                incoming.backup(outgoing)
                sqlite_check(outgoing)
                counts = {name: outgoing.execute('SELECT count(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0]
                          for (name,) in outgoing.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()}
                references = object_references(outgoing.execute, set(counts))
    else:
        import psycopg
        from psycopg import sql
        if manifest["format"] != "postgresql-custom":
            raise BackupError("Backup type does not match the restore target")
        params = postgres_config(database_env)
        database = params["dbname"]
        if not re.fullmatch(r"nodecomics_restore_[a-z0-9_]{1,40}", database):
            raise BackupError("Isolated PostgreSQL target must be named nodecomics_restore_*")
        if pg_container:
            verify_pg_container(params, pg_container)
        with psycopg.connect(**{**params, "dbname": "postgres"}, autocommit=True) as admin:
            if admin.execute("SELECT 1 FROM pg_database WHERE datname = %s", (database,)).fetchone():
                raise BackupError("Restore target already exists; refusing to overwrite it")
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(database)))
        with snapshot.open("rb") as incoming:
            pg_command("pg_restore", params, ["--dbname", database, "--single-transaction", "--exit-on-error",
                       "--no-owner", "--no-privileges"], container=pg_container, input_file=incoming)
        with psycopg.connect(**params) as connection:
            tables = connection.execute("SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')").fetchall()
            counts = {schema + "." + name: connection.execute(sql.SQL("SELECT count(*) FROM {}.{}").format(
                sql.Identifier(schema), sql.Identifier(name))).fetchone()[0] for schema, name in tables}
            if connection.execute("SELECT 1 FROM pg_constraint WHERE NOT convalidated LIMIT 1").fetchone():
                raise BackupError("Restored database contains unvalidated constraints")
            references = object_references(connection.execute, {name for schema, name in tables if schema == "public"})
    if reference_output:
        with Path(reference_output).open("x", encoding="utf-8") as output:
            json.dump({"version": 1, "objects": references}, output, indent=2)
            output.write("\n")
    return {"status": "verified", "table_rows": counts, "object_references": len(references), "objects_verified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for operation in ("backup", "restore"):
        command = commands.add_parser(operation)
        command.add_argument("--directory", type=Path, required=True, help="New backup directory or existing restore input")
        source = command.add_mutually_exclusive_group(required=True)
        source.add_argument("--sqlite", type=Path, help="Explicit SQLite source or NEW isolated restore-*.db target")
        source.add_argument("--database-env", help="Name of environment variable containing an explicit PostgreSQL URL")
        command.add_argument("--pg-container", help="Run PostgreSQL client tools inside this existing container")
        if operation == "restore":
            command.add_argument("--reference-output", type=Path, help="New private JSON inventory of snapshot object references")
    args = parser.parse_args()
    try:
        common = {"database_env": args.database_env, "pg_container": args.pg_container}
        if args.command == "backup":
            result = backup(args.directory, sqlite_source=args.sqlite, **common)
        else:
            result = restore(args.directory, sqlite_target=args.sqlite, reference_output=args.reference_output, **common)
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        message = str(error) if isinstance(error, BackupError) else type(error).__name__
        print("Database operation failed: " + message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
