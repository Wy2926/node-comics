"""Single-image resource helper for explicit smoke runs; retries keep the same UUID."""
import hashlib
import httpx
from io import BytesIO
from PIL import Image

PROTOCOL_HEADERS = {'X-Translation-Protocol': 'overlay-v1'}


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
    result = client.put(route, json=body, headers=PROTOCOL_HEADERS).raise_for_status().json()
    if result["state"] == "needs_input":
        result = client.put(route + "/input", content=data,
            headers={**PROTOCOL_HEADERS, "Content-Type": body["image"]["content_type"]}).raise_for_status().json()
    return result


def download(client, translation, *, original=None):
    """Read authenticated artifact bytes and compose a test image without resubmitting."""
    result = translation.get("result") or {}
    representation = result.get('representation')
    if translation.get('state') != 'succeeded' or representation not in {'original', 'overlay-v1', 'full-image-v1'}:
        raise RuntimeError('Translation has no completed result')
    if representation != 'full-image-v1':
        if original is None or hashlib.sha256(original).hexdigest() != result['input_sha256']:
            raise RuntimeError('The exact submitted original is required')
    if representation == 'original':
        if result.get('artifact'):
            raise RuntimeError('Original result must not contain an artifact')
        return original
    artifact = result['artifact']
    path = '/v1/translations/' + translation['id'] + '/result'
    if artifact['path'] != path:
        raise RuntimeError('Unexpected artifact route')
    try:
        response = client.get(path, headers=PROTOCOL_HEADERS, follow_redirects=False)
    except httpx.RequestError:
        raise RuntimeError("Image download failed") from None
    if response.status_code != 200:
        raise RuntimeError("Image download returned HTTP " + str(response.status_code))
    data = response.content
    if (len(data) != artifact['byte_size'] or hashlib.sha256(data).hexdigest() != artifact['sha256']
            or response.headers.get('content-type', '').split(';')[0] != artifact['mime']):
        raise RuntimeError('Artifact integrity check failed')
    if representation == 'full-image-v1':
        return data
    with Image.open(BytesIO(original)) as source, Image.open(BytesIO(data)) as patch:
        if source.size != (result['width'], result['height']) or result.get('composite') != 'source-atop':
            raise RuntimeError('Unexpected overlay canvas')
        box = result['bbox']
        if (patch.size != (box['width'], box['height']) or min(box['x'], box['y']) < 0
                or box['x'] + box['width'] > source.width or box['y'] + box['height'] > source.height):
            raise RuntimeError('Unexpected overlay bounds')
        canvas, overlay = source.convert('RGBA'), patch.convert('RGBA')
        alpha = canvas.getchannel('A')
        canvas.paste(overlay, (box['x'], box['y']), overlay.getchannel('A'))
        canvas.putalpha(alpha)
        output = BytesIO()
        canvas.save(output, format='PNG')
        return output.getvalue()
