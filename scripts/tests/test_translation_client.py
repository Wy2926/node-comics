"""Smoke helper contract checks with synthetic bytes and no model calls."""
import hashlib
import importlib.util
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import httpx
from PIL import Image
import pytest

spec = importlib.util.spec_from_file_location('translation_client', Path(__file__).parents[1] / 'translation_client.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def picture(color, size=(3, 4), format='PNG'):
    output = BytesIO()
    Image.new('RGBA', size, color).save(output, format=format, lossless=True)
    return output.getvalue()


def test_submit_keeps_uuid_and_sends_protocol_for_input():
    original, request_id, calls = picture('white'), str(uuid4()), []

    def respond(request):
        calls.append(request.url.path)
        assert request.headers['x-translation-protocol'] == 'overlay-v1'
        return httpx.Response(202, json={'id': request_id, 'state': 'running' if request.url.path.endswith('/input') else 'needs_input'})

    with httpx.Client(base_url='https://center.example', transport=httpx.MockTransport(respond)) as client:
        assert helper.submit_page(client, original, request_id, 'classic')['state'] == 'running'
    assert calls == [f'/v1/translations/{request_id}', f'/v1/translations/{request_id}/input']


@pytest.mark.parametrize('representation', ['original', 'overlay-v1', 'full-image-v1'])
def test_download_uses_authenticated_artifact_or_local_original(representation):
    original, artifact = picture((255, 255, 255, 128)), picture('black', (1, 1), 'WEBP')
    request_id = str(uuid4())
    result = {'representation': representation, 'input_sha256': hashlib.sha256(original).hexdigest(),
        'width': 3, 'height': 4, 'artifact': None}
    if representation != 'original':
        result['artifact'] = {'path': f'/v1/translations/{request_id}/result', 'byte_size': len(artifact),
            'sha256': hashlib.sha256(artifact).hexdigest(), 'mime': 'image/webp'}
    if representation == 'overlay-v1':
        result.update(composite='source-atop', bbox={'x': 1, 'y': 2, 'width': 1, 'height': 1})
    calls = []

    def respond(request):
        calls.append(request)
        assert request.headers['x-translation-protocol'] == 'overlay-v1'
        assert request.headers['authorization'] == 'Bearer isolated'
        assert request.url.host == 'center.example'
        return httpx.Response(200, content=artifact, headers={'Content-Type': 'image/webp'})

    with httpx.Client(base_url='https://center.example', headers={'Authorization': 'Bearer isolated'},
            transport=httpx.MockTransport(respond)) as client:
        output = helper.download(client, {'id': request_id, 'state': 'succeeded', 'result': result}, original=original)
    assert len(calls) == (0 if representation == 'original' else 1)
    if representation == 'overlay-v1':
        with Image.open(BytesIO(output)) as image:
            assert image.getpixel((1, 2)) == (0, 0, 0, 128)
            assert image.getpixel((0, 0)) == (255, 255, 255, 128)
    else:
        assert output == (original if representation == 'original' else artifact)
