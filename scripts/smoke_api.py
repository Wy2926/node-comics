"""Local integration smoke. --translate performs ONE resumable, real upstream request.

The operation ID is saved before sending. Re-running reconciles that same operation;
it never automatically creates another paid request after an uncertain result.
No credentials, OCR text, provider URLs or signed URLs are written to evidence.
"""
import argparse
import hashlib
import io
import json
import time
import uuid
from pathlib import Path

import httpx
from PIL import Image
from submission_client import submit_page, body_for, download

ROOT = Path(__file__).resolve().parents[1]


def checked(response, statuses=(200,)):
    if response.status_code not in statuses:
        raise RuntimeError(f"API returned HTTP {response.status_code}: {response.text[:400]}")
    return response.json()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://127.0.0.1:18088")
    parser.add_argument("--mode", choices=("redraw",), default="redraw")
    parser.add_argument("--translate", action="store_true")
    parser.add_argument("--grant-plus", action="store_true", help="Explicitly grant this isolated local test account one PLUS month")
    parser.add_argument("--wait", action="store_true")
    args = parser.parse_args()
    evidence = ROOT / "artifacts" / "cluster-smoke"
    evidence.mkdir(parents=True, exist_ok=True)
    record_path = evidence / f"cluster-live-{args.mode}.json"
    record = json.loads(record_path.read_text("utf-8")) if record_path.exists() else {
        "mode": args.mode, "username": f"acceptance-{args.mode}-{uuid.uuid4().hex[:10]}",
        "operation_id": str(uuid.uuid4()), "checks": [],
    }

    def save():
        record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), "utf-8")

    def passed(name):
        if name not in record["checks"]:
            record["checks"].append(name)

    save()
    with httpx.Client(base_url=args.api, timeout=60, trust_env=False) as client:
        auth = checked(client.post("/v1/auth/dev", json={"username": record["username"]}))
        client.headers["Authorization"] = "Bearer " + auth["access_token"]
        record["user_id"] = auth["user"]["id"]
        if args.grant_plus:
            operator = checked(client.post("/v1/auth/dev", json={"username": "admin"}))
            checked(client.post(f"/v1/admin/users/{auth['user']['id']}/membership",
                headers={"Authorization": "Bearer " + operator["access_token"],
                         "Idempotency-Key": "smoke-membership-" + record["operation_id"]},
                json={"months": 1, "note": "Explicit isolated smoke membership"}))
        record["capabilities"] = checked(client.get("/v1/capabilities"))
        record["usage"] = checked(client.get("/v1/me/usage"))
        passed("isolated_local_login_and_capabilities")
        if not args.translate and "job_id" not in record:
            save()
            print(json.dumps({"status": "api_ready", "mode": args.mode}, ensure_ascii=False))
            return
        if "job_id" not in record and not record["capabilities"]["entitlements"]["modes"][args.mode]["allowed"]:
            raise RuntimeError("Test account requires PLUS or a valid redraw gift; explicitly use --grant-plus for a local test membership")
        sample = (ROOT / "samples" / "starlight-bookshop.png").read_bytes()
        record["input_sha256"] = hashlib.sha256(sample).hexdigest()
        result = submit_page(client, sample, record["operation_id"], args.mode)
        record["job_id"] = result["id"]
        save()
        replay = submit_page(client, sample, record["operation_id"], args.mode)
        assert replay["id"] == result["id"]
        passed("duplicate_click_returns_same_job")
        conflict = client.post("/v1/translation-submissions", json=body_for(sample, record["operation_id"], args.mode, "en"),
                               headers={"Idempotency-Key": record["operation_id"]})
        assert conflict.status_code == 409
        passed("idempotency_key_rejects_changed_payload")
        with httpx.Client(base_url=args.api, timeout=30, trust_env=False) as stranger:
            other = checked(stranger.post("/v1/auth/dev", json={"username": record["username"] + "-other"}))
            stranger.headers["Authorization"] = "Bearer " + other["access_token"]
            assert stranger.get(f"/v1/jobs/{record['job_id']}").status_code == 404
            if result["input_asset_id"]:
                assert stranger.get(f"/v1/images/{result['input_asset_id']}/content").status_code == 404
            passed("another_user_cannot_read_job_or_original")
        deadline = time.monotonic() + (1200 if args.wait else 0)
        while True:
            job = checked(client.get(f"/v1/jobs/{record['job_id']}"))
            record["job"] = job
            record["usage"] = checked(client.get("/v1/me/usage"))
            save()
            print(json.dumps({"job_id": job["id"], "mode": args.mode, "status": job["status"],
                              "phase": job["phase"], "error": job.get("error")}, ensure_ascii=False), flush=True)
            if job["status"] not in ("awaiting_upload", "validating_upload", "queued", "running") or time.monotonic() >= deadline:
                break
            time.sleep(5)
        if job["status"] == "succeeded":
            output = download(client, job["output_asset_id"])
            picture = Image.open(io.BytesIO(output))
            picture.load()
            assert picture.width > 0 and picture.height > 0
            record["output"] = {"width": picture.width, "height": picture.height, "format": picture.format,
                                "sha256": hashlib.sha256(output).hexdigest(), "bytes": len(output)}
            output_path = evidence / f"translated-{args.mode}.png"
            picture.save(output_path)
            passed("delivered_image_downloaded_and_decoded")
            passed("server_job_survives_client_disconnect")
            save()
        elif job["status"] in ("failed", "outcome_unknown"):
            print("Upstream call will NOT be automatically repeated.", flush=True)
        print(json.dumps({"evidence": str(record_path), "checks": record["checks"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
