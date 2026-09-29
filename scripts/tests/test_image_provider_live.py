"""Run the real-image verifier against synthetic provider bytes, never a paid API."""
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory


CHILD = r"""
import base64
from io import BytesIO
import os
from pathlib import Path
import sys
import httpx
from PIL import Image
from fakeredis import FakeRedis
root, key_file, run_dir = map(Path, sys.argv[1:])
sys.path[:0] = [str(root / 'backend'), str(root / 'scripts')]
os.environ.update(APP_ENV='test', DEV_AUTH='true', DEV_AUTH_SECRET='isolated-synthetic-verifier-signing-key')
from app.config import Settings, settings
Settings.model_config['env_file'] = None
settings.cache_clear()
from app import redis_state
redis = FakeRedis(decode_responses=True)
redis_state.client = lambda: redis
from app.adapters import images
from urllib.parse import urlsplit
def synthetic_endpoint(url, **kwargs):
    parsed = urlsplit(url)
    assert parsed.hostname == 'provider.invalid'
    return parsed
images.safe_endpoint = synthetic_endpoint
payload = BytesIO()
Image.new('RGB', (512, 512), 'white').save(payload, format='PNG')
class SyntheticTransport(httpx.BaseTransport):
    def __init__(self, *args, **kwargs):
        pass
    def handle_request(self, request):
        assert request.url.host == 'provider.invalid'
        assert request.url.path == '/v1/images/edits' and request.method == 'POST'
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(payload.getvalue()).decode()}],
            'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}},
            headers={'x-request-id': 'isolated-synthetic-response'})
images.CheckedTransport = SyntheticTransport
import verify_image_provider_live
sys.argv = ['verify_image_provider_live', '--key-file', str(key_file), '--run-dir', str(run_dir),
            '--base-url', 'https://provider.invalid/v1', '--model', 'synthetic-image-model']
raise SystemExit(verify_image_provider_live.main())
"""


def test_verifier_uses_uuid_result_protocol_and_retains_one_call_evidence():
    root = Path(__file__).resolve().parents[2]
    artifacts = root / 'artifacts'
    artifacts.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix='image-verifier-mock-', dir=artifacts) as temporary:
        work = Path(temporary)
        key_file = work / 'isolated.env'
        key_file.write_text('NC_REAL_IMAGE_API_KEY=isolated-synthetic-no-paid-access\n', encoding='utf-8')
        run_dir = work / 'run'
        result = subprocess.run([sys.executable, '-c', CHILD, str(root), str(key_file), str(run_dir)],
            capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        report = json.loads((run_dir / 'report.json').read_text(encoding='utf-8'))
        assert report['observed']['requests'] == 1
        assert report['published_result'] and report['temporary_input_deleted']
        assert report['cross_user_access_status'] == 404
        assert report['settlement_records'] == 1
        assert report['job']['status'] == 'succeeded'
        assert report['translation_id'] != report['job_id']
        assert (run_dir / 'call-intent.json').is_file()
