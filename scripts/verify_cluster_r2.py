"""Isolated real-R2 cluster smoke; no paid provider call or product database.

Run from the repository root:
  backend/.venv/Scripts/python.exe scripts/verify_cluster_r2.py --env-file .env

Only R2 settings are read from that file. The script creates synthetic PNGs and
a temporary SQLite database, restricts every S3 operation to a fresh nested
prefix, and removes that prefix's objects before exit. No secrets, image text,
object paths or signed URLs are printed. An absent configuration exits with 2.
"""
from argparse import ArgumentParser
from collections import Counter
from datetime import timedelta
import hashlib
from io import BytesIO
import json
import logging
import os
import re
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def run(env_file):
    from dotenv import dotenv_values
    source = {str(key).upper(): value for key, value in dotenv_values(env_file).items()} if env_file.is_file() else {}
    source.update({key.upper(): value for key, value in os.environ.items()})
    required = ("R2_ENDPOINT_URL", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
    missing = [key for key in required if not source.get(key)]
    if missing:
        return {"status": "not_verified", "reason": "R2_CONFIGURATION_MISSING", "missing_fields": missing,
                "paid_provider_calls": 0, "remote_writes": 0}, 2
    original_prefix = source.get("R2_KEY_PREFIX") or "node-comics/"
    test_prefix = original_prefix.rstrip("/") + "/verification/cluster-" + uuid4().hex + "/"
    assert test_prefix.startswith(original_prefix.rstrip("/") + "/") and test_prefix != original_prefix
    for key in required:
        os.environ[key] = source[key]
    os.environ.update({"R2_KEY_PREFIX": test_prefix, "RESULT_STORAGE_BACKEND": "r2",
        "RETENTION_DAYS": "0",
        "APP_ENV": "test", "DEV_AUTH": "true", "DEV_AUTH_SECRET": uuid4().hex + uuid4().hex,
        "OPENAI_API_KEY": "isolated-smoke-placeholder-no-paid-access", "OPENAI_BASE_URL": "https://provider.invalid/v1",
        "OPENAI_MODEL": "local-smoke-stub", "PROVIDERS_JSON": "", "CLASSIC_ENABLED": "false"})
    logging.getLogger("botocore").setLevel(logging.CRITICAL)
    report = {"status": "failed", "paid_provider_calls": 0, "isolated_prefix_enforced": True}
    counters, store, cleanable = Counter(), None, False
    written_keys = set()
    with TemporaryDirectory(prefix="node-comics-r2-smoke-") as temporary:
        os.environ["DATABASE_URL"] = "sqlite:///" + (Path(temporary) / "smoke.db").as_posix()
        os.environ["STORAGE_PATH"] = str(Path(temporary) / "objects")
        from app.config import settings
        from app.db import engine, session_factory
        settings.cache_clear()
        engine.cache_clear()
        try:
            from app.storage import get_store
            store = get_store("r2")
            underlying = store.client

            class ScopedClient:
                def __getattr__(self, operation):
                    actual = getattr(underlying, operation)
                    def guarded(*args, **kwargs):
                        params = kwargs.get("Params", {}) if operation == "generate_presigned_url" else kwargs
                        assert params.get("Bucket") == source["R2_BUCKET"]
                        if operation == "list_objects_v2":
                            assert params.get("Prefix") == test_prefix
                        else:
                            assert params.get("Key", "").startswith(test_prefix)
                        if operation == "put_object":
                            written_keys.add(params["Key"][len(test_prefix):])
                        counters[operation] += 1
                        try:
                            return actual(*args, **kwargs)
                        except Exception as error:
                            details = getattr(error, "response", {})
                            code = details.get("Error", {}).get("Code", "")
                            if operation == "put_object" and params.get("IfNoneMatch") == "*" and details.get("ResponseMetadata", {}).get("HTTPStatusCode") == 412:
                                report["conditional_write_reused"] = True
                                raise
                            if operation == "head_object" and details.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
                                raise  # Expected cleanup verification, not a storage failure.
                            if re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,63}", code):
                                report["r2_failure_code"] = code
                            report["r2_failure_type"] = type(error).__name__
                            raise
                    return guarded
            store.client = ScopedClient()
            initial = store.client.list_objects_v2(Bucket=source["R2_BUCKET"], Prefix=test_prefix, MaxKeys=1)
            assert not initial.get("Contents"), "Fresh verification prefix must be empty"
            cleanable = True
            from fastapi.testclient import TestClient
            from PIL import Image
            from sqlalchemy import select
            from app.main import app
            from app.models import Asset, Job, Ledger, User, now
            from app.queue_models import ComputeNode
            from app.scheduler import claim_stage
            from app.adapters.images import TranslationOutput
            import app.workers as workers
            import httpx

            def png(color):
                buffer = BytesIO()
                Image.new("RGB", (320, 480), color).save(buffer, "PNG")
                return buffer.getvalue()
            original, translated = png((220, 224, 238)), png((202, 218, 229))
            stub_calls = []
            def stub_redraw(data, *args):
                assert data == original
                stub_calls.append(1)
                return TranslationOutput(translated, request_id="local-smoke-stub", usage={"total_tokens": 0})
            workers.redraw = stub_redraw
            with TestClient(app) as client:
                login = client.post("/v1/auth/dev", json={"username": "isolated-r2-smoke"})
                assert login.status_code == 200
                auth = {"Authorization": "Bearer " + login.json()["access_token"]}
                with session_factory()() as db:
                    user = db.scalar(select(User).where(User.subject == "dev:isolated-r2-smoke"))
                    user.membership_id, user.plus_started_at = str(uuid4()), now()
                    user.plus_expires_at, user.plus_timezone, user.plus_monthly_pages = now() + timedelta(days=30), "Asia/Shanghai", 10
                    for name in ("validate_upload", "redraw"):
                        db.add(ComputeNode(id="smoke-" + name, name="smoke-" + name, capabilities=[name], capacity=1,
                            resource_id="smoke-" + name, engine_version="control", device="network"))
                    db.commit()
                request = {"trigger": "manual", "items": [{"page_key": "synthetic-page",
                    "operation_key": "isolated-r2-plan", "mode": "redraw", "target_language": "zh-Hans",
                    "max_quota_pages": 1, "image": {"client_item_id": "synthetic-page",
                    "image_sha256": hashlib.sha256(original).hexdigest(),
                    "byte_size": len(original), "content_type": "image/png"}}]}
                headers = auth
                report["phase"] = "plan"
                submitted = client.post("/v1/translation-plans", headers=headers, json=request)
                assert submitted.status_code == 202
                item = submitted.json()["items"][0]
                job_id, upload = item["job"]["id"], item["upload"]
                report["phase"] = "original_upload"
                uploaded = client.put(upload["url"], headers={**auth, **upload["headers"]}, content=original)
                assert uploaded.status_code == 200
                report["phase"] = "enqueue_validation"
                accepted = client.post(f"/v1/uploads/{upload['id']}/complete", headers=auth)
                assert accepted.status_code == 200 and accepted.json()["status"] == "validating_upload"
                for name in ("validate_upload", "redraw"):
                    report["phase"] = name
                    with session_factory()() as db:
                        lease = claim_stage(db, "smoke-" + name, [name])
                        assert lease and lease.job_id == job_id
                        db.commit()
                    workers.run_control_stage(lease.id)
                delivered = client.get(f"/v1/jobs/{job_id}", headers=auth)
                assert delivered.status_code == 200 and delivered.json()["status"] == "succeeded"
                output_id = delivered.json()["output_asset_id"]
                report["phase"] = "authorized_download"
                access = client.get(f"/v1/images/{output_id}/access", headers=auth)
                assert access.status_code == 200 and not access.json()["authorization_required"]
                cors_missing = 0
                origins = ("http://127.0.0.1:5174", "http://localhost:5173")
                with httpx.Client(timeout=60, follow_redirects=False) as download:
                    for origin in origins:
                        response = download.get(access.json()["url"], headers={"Origin": origin})
                        assert response.status_code == 200 and response.content == translated
                        with Image.open(BytesIO(response.content)) as image:
                            image.verify()
                        cors_missing += response.headers.get("access-control-allow-origin") not in (origin, "*")
                replay = client.post("/v1/translation-plans", headers=headers, json=request)
                report["phase"] = "replay_and_settlement"
                assert replay.status_code == 200 and replay.json()["items"][0]["job"]["id"] == job_id
                with session_factory()() as db:
                    job = db.get(Job, job_id)
                    assert job.status == "succeeded" and job.settlement == "settled" and not job.input_pinned
                    assets = list(db.scalars(select(Asset)))
                    assert all(asset.storage_backend == "r2" and asset.expires_at is None for asset in assets)
                    assert db.get(Asset, output_id).last_accessed_at is not None
                    charges = list(db.scalars(select(Ledger.kind).where(Ledger.job_id == job_id)))
                    assert sorted(charges) == ["reserve", "settle"]
                assert stub_calls == [1]
                report["phase"] = "cross_account_reuse"
                second_login = client.post("/v1/auth/dev", json={"username": "isolated-shared-reader"})
                assert second_login.status_code == 200
                second_auth = {"Authorization": "Bearer " + second_login.json()["access_token"]}
                io_before = counters.copy()
                shared = client.post("/v1/translation-plans", headers=second_auth,
                    json={**request, "items": [{**request["items"][0], "max_quota_pages": 0}]})
                assert shared.status_code == 200
                shared_item = shared.json()["items"][0]
                assert shared_item["upload"] is None and shared_item["disposition"] == "ready"
                assert shared_item["job"]["status"] == "succeeded" and shared_item["job"]["cache_hit"]
                assert shared_item["job"]["quota_pages"] == 0 and counters == io_before and stub_calls == [1]
                assert client.get(f"/v1/images/{output_id}/access", headers=second_auth).status_code == 404
                with session_factory()() as db:
                    output_asset = db.get(Asset, output_id)
                    store.put(output_asset.storage_key, translated, output_asset.mime, kind="redraw")
                assert report.get("conditional_write_reused") is True
                report.update(shared_reuse_without_upload=True, shared_reuse_without_model=True,
                              shared_quota_pages=0, cross_account_asset_ids_private=True)
                assert not any(path.is_file() for path in settings().storage_path.rglob("*"))
                report.update(status="passed", phase="completed", operation_replay="same_job", source_storage="r2", result_storage="r2",
                    downloaded_result_decoded=True, persistent_local_image_files=0, quota_settlements=1, mocked_provider_calls=1,
                    retention="unlimited", user_access_recorded=True, cors_status="missing" if cors_missing else "configured",
                    cors_origins_configured=len(origins) - cors_missing, cors_origins_missing=cors_missing)
                if cors_missing:
                    report.update(status="failed", failure_type="R2CorsMissing", translation_chain="passed")
        except Exception as error:
            report.update(status="failed", failure_type=type(error).__name__)
        finally:
            if store is not None and cleanable:
                try:
                    # Delete only keys observed in this exact run, including
                    # uncertain PUTs. Application orphan enumeration is removed.
                    for key in written_keys:
                        store.delete(key)
                    assert all(not store.exists(key) for key in written_keys)
                    report.update(cleanup="verified_written_keys_absent", cleaned_objects=len(written_keys), existing_product_prefix_modified=False)
                except Exception as error:
                    report.update(status="failed", cleanup="failed", cleanup_failure_type=type(error).__name__)
            if engine.cache_info().currsize:
                engine().dispose()
            engine.cache_clear()
            report["r2_operation_counts"] = dict(counters)
    return report, 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    args = parser.parse_args()
    result, exit_code = run(args.env_file.resolve())
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    raise SystemExit(exit_code)
