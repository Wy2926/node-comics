"""Single-image resource helper for explicit smoke runs; retries keep the same UUID."""
import hashlib
import httpx
from io import BytesIO
from PIL import Image


def body_for(data, mode, language="zh-Hans"):
    with Image.open(BytesIO(data)) as picture:
        mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[picture.format]
    return {"mode": mode, "target_language": language,
        "image": {"sha256": hashlib.sha256(data).hexdigest(), "byte_size": len(data), "content_type": mime}}


def submit_page(client, data, key, mode, language="zh-Hans"):
    from uuid import UUID
    key = str(UUID(key))
    body = body_for(data, mode, language)
    route = "/v1/translations/" + key
    result = client.put(route, json=body).raise_for_status().json()
    if result["state"] == "needs_input":
        result = client.put(route + "/input", content=data,
            headers={"Content-Type": body["image"]["content_type"]}).raise_for_status().json()
    return result


def download(client, translation):
    """Use the completed snapshot's signed URL without another access request."""
    from urllib.parse import urljoin, urlsplit
    result = translation.get("result") or {}
    if not result.get("download_url"):
        raise RuntimeError("Translation has no downloadable result")
    url = urljoin(str(client.base_url), result["download_url"])
    own = urlsplit(url)[:2] == urlsplit(str(client.base_url))[:2]
    try:
        response = client.get(url) if own else httpx.get(url, timeout=60, trust_env=False)
    except httpx.RequestError:
        raise RuntimeError("Image download failed") from None
    if response.status_code != 200:
        raise RuntimeError("Image download returned HTTP " + str(response.status_code))
    return response.content
