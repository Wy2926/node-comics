"""One idempotent classic smoke page. Results and dialogue remain in ignored storage."""
import argparse
import json
from pathlib import Path
import time
import uuid
import httpx
from PIL import Image
from io import BytesIO
from submission_client import submit_page, download

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true', help='Create the recorded page if not submitted previously')
parser.add_argument('--wait', action='store_true')
parser.add_argument('--record', default='classic-smoke')
parser.add_argument('--image', type=Path, help='Optional isolated test PNG/JPEG/WebP')
args = parser.parse_args()
if not args.record.replace('-', '').replace('_', '').isalnum():
    parser.error('record must be a simple name')
folder = ROOT / 'private-test-data' / args.record
folder.mkdir(parents=True, exist_ok=True)
record = folder / 'cluster-operation.json'
state = json.loads(record.read_text()) if record.exists() else {'key': str(uuid.uuid4())}
record.write_text(json.dumps(state))

with httpx.Client(base_url='http://127.0.0.1:18088', timeout=30, trust_env=False) as client:
    auth = client.post('/v1/auth/dev', json={'username': 'classic-smoke'}).raise_for_status().json()
    client.headers['Authorization'] = 'Bearer ' + auth['access_token']
    if args.run:
        source = (args.image or ROOT / 'apps/extension/public/samples/starlight-bookshop.png').read_bytes()
        result = submit_page(client, source, state['key'], 'classic')
        state['job_id'] = result['id']
        (folder / 'original.png').write_bytes(source)
        record.write_text(json.dumps(state))
    if not state.get('job_id'):
        raise SystemExit('No recorded task. Use --run to create one.')
    deadline = time.monotonic() + (1200 if args.wait else 0)
    last = None
    while True:
        job = client.get('/v1/jobs/' + state['job_id']).raise_for_status().json()
        if job['phase'] != last:
            print(json.dumps({'job_id': job['id'], 'status': job['status'], 'phase': job['phase'], 'error': job['error']}, ensure_ascii=False), flush=True)
            last = job['phase']
        if job['status'] in ('succeeded', 'failed', 'cancelled', 'no_text') or time.monotonic() >= deadline:
            break
        time.sleep(3)
    (folder / 'job.json').write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding='utf-8')
    detail = client.get('/v1/jobs/' + state['job_id'] + '/classic').raise_for_status().json() if job['input_asset_id'] else {'artifacts': {}, 'segments': [], 'translations': [], 'timings': {}}
    (folder / 'stages.json').write_text(json.dumps(detail, ensure_ascii=False, indent=2), encoding='utf-8')
    artifacts = dict(detail['artifacts'])
    if job.get('output_asset_id'):
        artifacts['result'] = job['output_asset_id']
    for name, asset_id in artifacts.items():
        raw = download(client, asset_id)
        with Image.open(BytesIO(raw)) as image:
            image.load()
        (folder / (name + '.png')).write_bytes(raw)
    print(json.dumps({'status': job['status'], 'segment_count': len(detail['segments']), 'translation_count': len(detail['translations']), 'timings': detail['timings'], 'evidence': str(folder)}, ensure_ascii=False))
