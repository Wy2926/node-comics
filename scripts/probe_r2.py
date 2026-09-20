"""Check download of an existing final R2 result; never upload probe images.

Run from the repository root with python (with backend/requirements.txt installed).
Only --configure-cors changes bucket CORS; existing rules are preserved.
Never print SDK diagnostics, credentials, object keys or signed URLs.
"""
import argparse
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys
import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.storage import get_store
from app.assets import access_json, owned_asset
from app.db import session_factory
from app.models import Asset, Job
from sqlalchemy import select
from botocore.exceptions import ClientError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cors-origin', action='append', default=[])
    parser.add_argument('--configure-cors', action='store_true')
    parser.add_argument('--result-asset-id', help='Existing final translation result to download')
    args = parser.parse_args()
    if not args.result_asset_id and not args.configure_cors:
        parser.error('Provide --result-asset-id or --configure-cors')
    report = {'checks': []}
    try:
        store = get_store('r2')
        if args.configure_cors:
            if not args.cors_origin:
                raise ValueError('At least one origin is required')
            try:
                rules = store.client.get_bucket_cors(Bucket=store.bucket).get('CORSRules', [])
            except ClientError as error:
                if error.response.get('Error', {}).get('Code') != 'NoSuchCORSConfiguration':
                    raise
                rules = []
            missing = [origin for origin in args.cors_origin if not any(
                (origin in rule['AllowedOrigins'] or '*' in rule['AllowedOrigins']) and 'GET' in rule['AllowedMethods'] for rule in rules)]
            if missing:
                rules.append({'AllowedOrigins': missing, 'AllowedMethods': ['GET', 'HEAD'],
                              'ExposeHeaders': ['Content-Type', 'Content-Length', 'ETag'], 'MaxAgeSeconds': 3600})
                store.client.put_bucket_cors(Bucket=store.bucket, CORSConfiguration={'CORSRules': rules})
            report['checks'].append('cors_configured_preserving_existing_rules')
        if not args.result_asset_id:
            print(json.dumps(report, ensure_ascii=False))
            return 0
        with session_factory()() as db:
            asset = db.get(Asset, args.result_asset_id)
            assert asset and asset.kind in {'classic', 'redraw'} and asset.storage_backend == 'r2'
            assert db.scalar(select(Job.id).where(Job.output_asset_id == asset.id, Job.status == 'succeeded').limit(1))
            owned_asset(db, asset.id, asset.owner_id)
            url = access_json(asset)['url']
            expected_size = (asset.width, asset.height)
            expected_hash = asset.sha256
        with httpx.Client(timeout=30, follow_redirects=False, trust_env=False) as client:
            response = client.get(url)
            assert response.status_code == 200
            assert hashlib.sha256(response.content).hexdigest() == expected_hash
            with Image.open(BytesIO(response.content)) as image:
                image.load()
                assert image.size == expected_size
            report['checks'].append('anonymous_signed_get_decodable_image')
            for origin in args.cors_origin:
                response = client.get(url, headers={'Origin': origin})
                report.setdefault('cors', []).append({'origin': origin, 'status': response.status_code,
                    'allowed_origin': response.headers.get('access-control-allow-origin')})
                assert response.status_code == 200
                assert response.headers.get('access-control-allow-origin') in (origin, '*')
            if args.cors_origin:
                report['checks'].append('cors_origins_verified')
    except Exception as error:
        report['error_type'] = type(error).__name__
    print(json.dumps(report, ensure_ascii=False))
    return 1 if 'error_type' in report else 0


if __name__ == '__main__':
    raise SystemExit(main())
