"""Isolated Paddle sandbox delivery probe; never grants production entitlements.

Uses the backend Python environment. Stores only verified event metadata, not
customer details, raw payloads, signatures, or credentials. See the billing doc.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import hmac
import json
from pathlib import Path
import re
import sqlite3
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

MAX_BODY = 1024 * 1024
SIGNATURE_TOLERANCE = 300


def read_config(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip().strip('"').strip("'")
    if result.get("PADDLE_ENVIRONMENT") != "sandbox":
        raise ValueError("This delivery probe only supports sandbox configuration")
    return result


def valid_signature(body: bytes, header: str, secret: str, now: float) -> bool:
    if not secret or len(header) > 4096:
        return False
    fields: dict[str, list[str]] = {}
    for piece in header.split(";"):
        key, sep, value = piece.strip().partition("=")
        if sep:
            fields.setdefault(key, []).append(value)
    timestamps = fields.get("ts", [])
    if len(timestamps) != 1 or not re.fullmatch(r"[0-9]{1,12}", timestamps[0]):
        return False
    timestamp = timestamps[0]
    if abs(now - int(timestamp)) > SIGNATURE_TOLERANCE:
        return False
    digest = hmac.new(secret.encode(), timestamp.encode() + b":" + body, hashlib.sha256).hexdigest()
    return any(re.fullmatch(r"[0-9a-f]{64}", candidate)
               and hmac.compare_digest(digest, candidate) for candidate in fields.get("h1", []))


def create_app(config_path: Path, database_path: Path) -> FastAPI:
    read_config(config_path)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(database_path)) as db, db:
        db.execute("""CREATE TABLE IF NOT EXISTS receipts (
            event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL,
            resource_id TEXT, occurred_at TEXT NOT NULL,
            first_received REAL NOT NULL, last_received REAL NOT NULL,
            deliveries INTEGER NOT NULL DEFAULT 1
        )""")
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "paddle-sandbox-delivery-probe", "grants_entitlements": False}

    @app.post("/webhooks/paddle")
    async def receive(request: Request):
        try:
            secret = read_config(config_path).get("PADDLE_WEBHOOK_SECRET", "")
        except (OSError, ValueError):
            secret = ""
        if not secret:
            return JSONResponse({"error": "sandbox_webhook_not_configured"}, status_code=503)
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_BODY:
                return JSONResponse({"error": "payload_too_large"}, status_code=413)
            body.extend(chunk)
        if not valid_signature(bytes(body), request.headers.get("Paddle-Signature", ""), secret, time.time()):
            return JSONResponse({"error": "invalid_signature"}, status_code=401)
        try:
            event = json.loads(body)
            event_id, event_type, occurred_at = event["event_id"], event["event_type"], event["occurred_at"]
            resource_id = event["data"].get("id")
            # Paddle's simulator uses ntfsimevt_ IDs in the event envelope.
            if (not isinstance(event_id, str) or not re.fullmatch(r"(?:evt|ntfsimevt)_[a-z0-9]{26}", event_id)
                    or not isinstance(event_type, str) or not re.fullmatch(r"[a-z_]+\.[a-z_]+", event_type)
                    or not isinstance(occurred_at, str) or len(occurred_at) > 64
                    or (resource_id is not None and
                        (not isinstance(resource_id, str) or not re.fullmatch(r"[a-z]+_[a-z0-9]{26}", resource_id)))):
                raise ValueError("Invalid event envelope")
        except (ValueError, TypeError, KeyError, AttributeError, UnicodeDecodeError):
            return JSONResponse({"error": "invalid_event"}, status_code=400)
        received = time.time()
        with closing(sqlite3.connect(database_path, timeout=10)) as db, db:
            inserted = db.execute("""INSERT INTO receipts
                (event_id, event_type, resource_id, occurred_at, first_received, last_received)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING""",
                (event_id, event_type, resource_id, occurred_at, received, received)).rowcount
            if not inserted:
                db.execute("UPDATE receipts SET deliveries=deliveries+1, last_received=? WHERE event_id=?",
                           (received, event_id))
        return {"received": True, "duplicate": not bool(inserted),
                "simulation": event_id.startswith("ntfsimevt_"), "grants_entitlements": False}

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(".env.paddle.sandbox"))
    parser.add_argument("--database", type=Path, default=Path("artifacts/paddle/webhook-receipts.sqlite"))
    parser.add_argument("--port", type=int, default=18764)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(create_app(args.env_file.resolve(), args.database.resolve()), host="127.0.0.1",
                port=args.port, access_log=False, log_level="warning")
