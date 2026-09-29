"""One explicitly authorized real image-edit call through the persisted job pipeline.

Run with backend/.venv/Scripts/python.exe scripts/verify_image_provider_live.py
  --key-file <ignored dotenv file with NC_REAL_IMAGE_API_KEY>
  --run-dir artifacts/real-image-verification/<new run name>

This creates a public synthetic image and a fresh SQLite/local-file environment.
It never reuses the application database and refuses to repeat a recorded call.
Only numeric usage and bounded response metadata enter the result report.
"""
import argparse
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
import logging
import os
from pathlib import Path
import secrets
import sys
import time
from uuid import uuid4

from translation_client import PROTOCOL_HEADERS, download, submit_page


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--key-file', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--base-url', default='https://sub2api.nodelane.net/v1')
    parser.add_argument('--model', default='gpt-image-2')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    run_dir = args.run_dir.resolve()
    if not run_dir.is_relative_to(root / 'artifacts'):
        parser.error('run-dir must be within this repository artifacts directory')
    if run_dir.exists():
        parser.error('run-dir already exists; inspect its retained task instead of repeating a paid call')
    run_dir.mkdir(parents=True)
    from dotenv import dotenv_values
    key = dotenv_values(args.key_file).get('NC_REAL_IMAGE_API_KEY')
    if not key:
        parser.error('private key file must define NC_REAL_IMAGE_API_KEY')
    os.environ.update(APP_ENV='test', DEV_AUTH='true', DEV_AUTH_SECRET=secrets.token_urlsafe(40), DEV_ADMIN_USERNAME='admin',
        REDIS_URL=os.environ.get('TEST_REDIS_URL', 'redis://127.0.0.1:6379/0'), REDIS_NAMESPACE='image-proof-' + secrets.token_hex(16),
        DATABASE_URL=f"sqlite:///{(run_dir / 'task.sqlite').as_posix()}", STORAGE_PATH=str(run_dir / 'objects'),
        STRIPE_ENABLED='false', CREEM_ENABLED='false',
        CLASSIC_ENABLED='false', OPENAI_API_KEY='', PROVIDERS_JSON='', ADMIN_WEB_PATH='/console-image-verification/',
        NC_REAL_IMAGE_API_KEY=key)
    del key
    sys.path.insert(0, str(root / 'backend'))
    from app.config import Settings
    Settings.model_config['env_file'] = None
    logging.disable(logging.CRITICAL)  # HTTP trace/debug logging must never retain auth headers.
    from fastapi.testclient import TestClient
    from PIL import Image, ImageDraw, ImageFont
    from sqlalchemy import func, select
    from app.main import app
    from app.db import session_factory
    from app.models import Asset, Attempt, Job, Ledger, Provider, User, now
    from app.providers import ProviderConfig
    from app.queue_models import ExecutionLease
    from app.translation_requests import TranslationRequest
    from app.assets import available
    from app.scheduler import claim_stage
    from app.workers import run_control_stage
    from app.control_pools import report_pools
    from app.adapters import images

    sample = Image.new('RGB', (512, 512), '#f3efff')
    draw = ImageDraw.Draw(sample)
    draw.rounded_rectangle((18, 18, 494, 494), radius=18, fill='#ffffff', outline='#312b4d', width=5)
    draw.ellipse((72, 246, 240, 414), fill='#c5b4f0', outline='#312b4d', width=5)
    draw.ellipse((274, 246, 442, 414), fill='#f6c5b5', outline='#312b4d', width=5)
    for x in (118, 178, 320, 380):
        draw.ellipse((x, 304, x + 13, 325), fill='#312b4d')
    draw.arc((125, 319, 190, 363), 0, 180, fill='#312b4d', width=4)
    draw.arc((327, 319, 392, 363), 0, 180, fill='#312b4d', width=4)
    draw.rounded_rectangle((48, 50, 464, 210), radius=40, fill='white', outline='#312b4d', width=4)
    draw.polygon([(132, 209), (159, 245), (179, 209)], fill='white', outline='#312b4d')
    font_path = Path('C:/Windows/Fonts/arialbd.ttf')
    font = ImageFont.truetype(str(font_path), 30) if font_path.exists() else ImageFont.load_default(size=30)
    draw.text((256, 102), 'HELLO, WORLD!', anchor='mm', fill='#222033', font=font)
    draw.text((256, 154), "LET'S READ!", anchor='mm', fill='#222033', font=font)
    source_path = run_dir / 'source.png'
    sample.save(source_path)
    source_bytes = source_path.read_bytes()
    observed = {'requests': 0}
    report = {'translation_id': str(uuid4()), 'started_at': datetime.now(timezone.utc).isoformat(), 'endpoint': args.base_url.rstrip('/') + '/images/edits',
        'model': args.model, 'target_language': 'zh-Hans', 'storage_validation': 'isolated SQLite and private local files; no production validation',
        'input': {'path': str(source_path), 'width': 512, 'height': 512, 'bytes': len(source_bytes)},
        'parameters': {'quality': 'low', 'size': '1024x1024'}, 'observed': observed}

    def write_report():
        (run_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    class ObservedTransport(images.CheckedTransport):
        def handle_request(self, request):
            if request.method != 'POST' or str(request.url) != report['endpoint']:
                raise RuntimeError('Unexpected provider request blocked')
            if observed['requests'] or (run_dir / 'call-intent.json').exists():
                raise RuntimeError('Second paid request blocked; inspect original result')
            observed['requests'] += 1
            intent = {'job_id': report.get('job_id'), 'endpoint': report['endpoint'], 'model': args.model,
                'started_at': datetime.now(timezone.utc).isoformat()}
            with (run_dir / 'call-intent.json').open('x', encoding='utf-8') as handle:
                json.dump(intent, handle)
            started = time.perf_counter()
            response = super().handle_request(request)
            observed['http_status'] = response.status_code
            observed['headers_seconds'] = round(time.perf_counter() - started, 3)
            observed['request_id'] = (response.headers.get('x-request-id') or response.headers.get('request-id') or '')[:200] or None
            write_report()
            return response

    images.CheckedTransport = ObservedTransport
    write_report()
    try:
        with TestClient(app, headers=PROTOCOL_HEADERS) as client:
            login = client.post('/v1/auth/dev', json={'username': 'admin'})
            assert login.status_code == 200, 'isolated administrator login failed'
            auth = {'Authorization': 'Bearer ' + login.json()['access_token']}
            client.headers.update(auth)
            operator_id = client.get('/v1/me', headers=auth).json()['user']['id']
            with session_factory()() as db:
                user = db.get(User, operator_id)
                user.membership_id = 'live-image-verification-membership'
                user.plus_started_at = now() - timedelta(days=1)
                user.plus_expires_at = now() + timedelta(days=30)
                user.plus_timezone = 'UTC'
                user.plus_monthly_pages = 3
                db.commit()
                report_pools(db)
            config = ProviderConfig(id='authorized-live-image', label='Authorized isolated image test', base_url=args.base_url,
                credential_ref='NC_REAL_IMAGE_API_KEY', model=args.model, parameters=report['parameters'], timeout_seconds=600,
                enabled=True).model_dump()
            saved = client.put('/v1/admin/providers/authorized-live-image', headers=auth, json=config)
            assert saved.status_code == 200, 'provider configuration rejected before any paid call'
            submit_started = time.perf_counter()
            submitted = submit_page(client, source_bytes, report['translation_id'], 'redraw')
            assert submitted['state'] in {'queued', 'running'}, 'task submission rejected before any paid call'
            with session_factory()() as db:
                receipt = db.get(TranslationRequest, (operator_id, report['translation_id']))
                assert receipt and receipt.job_id, 'translation UUID has no persisted job'
                report['job_id'] = receipt.job_id
            report['submit_seconds'] = round(time.perf_counter() - submit_started, 3)
            write_report()
            with session_factory()() as db:
                lease = claim_stage(db, 'control-redraw', ['redraw'], executor_id='isolated-real-image-verifier')
                assert lease and lease.job_id == report['job_id'], 'isolated task could not claim redraw lease'
                lease_id = lease.id
                db.commit()
            run_started = time.perf_counter()
            run_control_stage(lease_id)
            report['worker_seconds'] = round(time.perf_counter() - run_started, 3)
            with session_factory()() as db:
                job = db.get(Job, report['job_id'])
                attempt = db.get(Attempt, job.attempt_id)
                lease = db.get(ExecutionLease, lease_id)
                report['job'] = {field: getattr(job, field) for field in ('status', 'phase', 'settlement', 'quota_pages', 'error_code', 'error_message')}
                report['job']['completed_at'] = job.completed_at.isoformat() + 'Z' if job.completed_at else None
                report['attempt'] = {'id': attempt.id, 'request_id': attempt.request_id, 'usage': attempt.usage, 'cost_state': attempt.cost_state,
                    'error_code': attempt.error_code, 'call_seconds': round((attempt.completed_at - attempt.call_started_at).total_seconds(), 3)
                    if attempt.completed_at and attempt.call_started_at else None}
                report['lease_outcome'] = lease.outcome
                output = db.get(Asset, job.output_asset_id) if job.output_asset_id else None
                report['published_result'] = bool(job.status == 'succeeded' and output and
                    output.owner_id == operator_id and output.representation == 'full-image-v1' and available(output))
                source = db.get(Asset, job.input_asset_id)
                report['temporary_input_deleted'] = bool(source and source.purged_at and not available(source))
                report['settlement_records'] = db.scalar(select(func.count()).select_from(Ledger).where(Ledger.job_id == job.id, Ledger.kind == 'settle'))
                provider = db.get(Provider, 'authorized-live-image')
                report['provider_validated'] = bool(provider.validated_at and provider.validation_job_id == job.id)
            write_report()
            if report['job']['status'] != 'succeeded':
                print(json.dumps({'status': report['job']['status'], 'error_code': report['job']['error_code'], 'requests': observed['requests'], 'report': str(run_dir / 'report.json')}))
                return 2
            snapshot = client.get('/v1/translations/' + report['translation_id']).raise_for_status().json()
            output_bytes = download(client, snapshot, original=source_bytes)
            output_path = run_dir / 'translated.png'
            output_path.write_bytes(output_bytes)
            with Image.open(BytesIO(output_bytes)) as decoded:
                decoded.load()
                report['output'] = {'path': str(output_path), 'width': decoded.width, 'height': decoded.height,
                    'format': decoded.format, 'bytes': len(output_bytes)}
            other = client.post('/v1/auth/dev', json={'username': 'other-reader'})
            other_auth = {'Authorization': 'Bearer ' + other.json()['access_token']}
            denied = client.get('/v1/translations/' + report['translation_id'] + '/result', headers=other_auth)
            report['cross_user_access_status'] = denied.status_code
            assert denied.status_code == 404, 'other user unexpectedly gained access'
            assert observed['requests'] == 1 and report['published_result'] and report['provider_validated']
            assert report['temporary_input_deleted'], 'terminal job left its temporary original on the server'
            assert report['settlement_records'] == 1 and report['job']['settlement'] == 'settled'
            report['finished_at'] = datetime.now(timezone.utc).isoformat()
            write_report()
            print(json.dumps({'status': 'succeeded', 'requests': observed['requests'], 'worker_seconds': report['worker_seconds'],
                'output': report['output'], 'report': str(run_dir / 'report.json')}, ensure_ascii=False))
            return 0
    except Exception as error:
        report['verifier_error_type'] = type(error).__name__
        write_report()
        print(json.dumps({'status': 'verification_interrupted', 'error_type': type(error).__name__, 'requests': observed['requests'], 'report': str(run_dir / 'report.json')}))
        return 3
    finally:
        os.environ.pop('NC_REAL_IMAGE_API_KEY', None)


if __name__ == '__main__':
    raise SystemExit(main())
