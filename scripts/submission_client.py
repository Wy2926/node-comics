"""New durable submission helper for explicit smoke runs; never creates a new retry key."""
import hashlib
import httpx
from io import BytesIO
from PIL import Image


def body_for(data, key, mode, language="zh-Hans"):
    with Image.open(BytesIO(data)) as picture:
        mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[picture.format]
    return {"mode": mode, "target_language": language, "max_quota_pages": 1,
        "items": [{"client_item_id": key, "image_sha256": hashlib.sha256(data).hexdigest(),
                   "byte_size": len(data), "content_type": mime, "name": "isolated-smoke"}]}


def submit_page(client, data, key, mode, language="zh-Hans"):
    body = body_for(data, key, mode, language)
    result = client.post("/v1/translation-submissions", json=body, headers={"Idempotency-Key": key}).raise_for_status().json()
    item = result["items"][0]
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
