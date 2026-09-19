"""Durable page-operation helper for explicit smoke runs; retries keep the same key."""
import hashlib
import httpx
from io import BytesIO
from PIL import Image


def body_for(data, key, mode, language="zh-Hans"):
    with Image.open(BytesIO(data)) as picture:
        mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[picture.format]
    return {"trigger": "manual", "items": [{"page_key": key, "operation_key": key,
        "mode": mode, "target_language": language, "max_quota_pages": 1,
        "image": {"client_item_id": key, "image_sha256": hashlib.sha256(data).hexdigest(),
                  "byte_size": len(data), "content_type": mime, "name": "isolated-smoke"}}]}


def submit_page(client, data, key, mode, language="zh-Hans"):
    body = body_for(data, key, mode, language)
    result = client.post("/v1/translation-plans", json=body).raise_for_status().json()
    item = result["items"][0]
    if item["disposition"] not in {"ready", "pending", "accepted"}:
        raise RuntimeError("Translation operation was not admitted: " + item.get("code", item["disposition"]))
    upload = item.get("upload")
    if upload:
        if upload["status"] == "awaiting_upload":
            client.put(upload["url"], content=data, headers=upload.get("headers", {})).raise_for_status()
        client.post("/v1/uploads/" + upload["id"] + "/complete").raise_for_status()
    return client.get("/v1/jobs/" + item["job"]["id"]).raise_for_status().json()


def download(client, asset_id):
    access = client.get("/v1/images/" + asset_id + "/access").raise_for_status().json()
    try:
        response = client.get(access["url"]) if access["authorization_required"] else httpx.get(access["url"], timeout=60, trust_env=False)
    except httpx.RequestError:
        raise RuntimeError("Image download failed") from None
    if response.status_code != 200:
        raise RuntimeError("Image download returned HTTP " + str(response.status_code))
    return response.content
