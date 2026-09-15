"""Exercise configured R2 with an isolated synthetic image; no database or AI calls.

Run from the repository root with backend/.venv/Scripts/python.exe.
Only --configure-cors changes bucket CORS; existing rules are preserved.
Never print SDK diagnostics, credentials, object keys or signed URLs.
"""
import argparse
from io import BytesIO
import json
from pathlib import Path
import sys
from uuid import uuid4
import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.storage import get_store
from botocore.exceptions import ClientError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cors-origin', action='append', default=[])
    parser.add_argument('--configure-cors', action='store_true')
    args = parser.parse_args()
    report = {'checks': [], 'cleaned_up': False}
    store = None
    key = f'{uuid4()}/{uuid4()}'
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
        buffer = BytesIO()
        Image.new('RGB', (64, 96), '#7cacdb').save(buffer, 'PNG')
        original = buffer.getvalue()
        store.put(key, original, 'image/png')
        assert store.exists(key)
        assert store.read(key) == original
        report['checks'].append('sdk_put_head_get_exact_bytes')
        url = store.download_url(key, 60)
        with httpx.Client(timeout=30, follow_redirects=False, trust_env=False) as client:
            response = client.get(url)
            assert response.status_code == 200 and response.content == original
            assert response.headers.get('content-type', '').startswith('image/png')
            with Image.open(BytesIO(response.content)) as image:
                image.load()
                assert image.size == (64, 96)
            report['checks'].append('anonymous_signed_get_decodable_image')
            for origin in args.cors_origin:
                response = client.get(url, headers={'Origin': origin})
                report.setdefault('cors', []).append({'origin': origin, 'status': response.status_code,
                    'allowed_origin': response.headers.get('access-control-allow-origin')})
                assert response.status_code == 200
                assert response.headers.get('access-control-allow-origin') in (origin, '*')
            if args.cors_origin:
                report['checks'].append('cors_origins_verified')
            store.delete(key)
            assert not store.exists(key)
            response = client.get(url)
            assert response.status_code in (403, 404)
            report['checks'].append('delete_revokes_existing_signed_url')
        report['cleaned_up'] = True
    except Exception as error:
        report['error_type'] = type(error).__name__
    finally:
        if store is not None and not report['cleaned_up']:
            try:
                store.delete(key)
                report['cleaned_up'] = True
            except Exception:
                report['cleanup_pending'] = True
    print(json.dumps(report, ensure_ascii=False))
    return 1 if 'error_type' in report else 0


if __name__ == '__main__':
    raise SystemExit(main())
