"""Validate synthetic extension events against GA4; never calls the collection endpoint.

Run with the backend Python and --env-file pointing to an authorized private file.
Without --env-file, reads only GA4_* process variables. No other .env is loaded.
Validation checks syntax, not the secret's correctness or actual report ingestion.
"""
from argparse import ArgumentParser
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
from uuid import uuid4

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from app.analytics import COMMON_PARAMS, COUNTS, DURATIONS, ENUMS, EVENT_PARAMS, EventBatch, build_payload

VALIDATE_URL = 'https://www.google-analytics.com/debug/mp/collect'
CONFIG_KEYS = ('GA4_EXTENSION_MEASUREMENT_ID', 'GA4_EXTENSION_API_SECRET')


def synthetic_payload() -> dict:
    at = int(time.time() * 1_000_000)
    version = json.loads((ROOT / 'apps/extension/package.json').read_text(encoding='utf-8'))['version']
    events = []
    for name, fields in EVENT_PARAMS.items():
        params = {}
        for field in fields | COMMON_PARAMS:
            if field in ENUMS:
                params[field] = sorted(ENUMS[field])[0]
            elif field in COUNTS:
                params[field] = 2
            elif field in DURATIONS:
                params[field] = 1000
            elif field == 'extension_version':
                params[field] = version
        events.append({'event_id': str(uuid4()), 'name': name, 'params': params, 'timestamp_micros': at})
    batch = EventBatch.model_validate({'client_id': str(uuid4()), 'session_id': at // 1_000_000, 'events': events})
    return {**build_payload(batch, batch.events), 'validation_behavior': 'ENFORCE_RECOMMENDATIONS'}


def validate(measurement_id: str, secret: str, transport: httpx.BaseTransport | None = None) -> dict:
    result = {'validated_at': datetime.now(timezone.utc).isoformat(), 'endpoint': 'GA4 validation only',
        'validation_behavior': 'ENFORCE_RECOMMENDATIONS', 'valid': False, 'validation_messages': []}
    if not re.fullmatch(r'G-[A-Z0-9]{4,20}', measurement_id) or not secret:
        return {**result, 'error': 'ANALYTICS_CONFIG_INVALID'}
    payload = synthetic_payload()
    result['event_count'] = len(payload['events'])
    result['event_names'] = [event['name'] for event in payload['events']]
    request = httpx.Request('POST', VALIDATE_URL, params={'measurement_id': measurement_id, 'api_secret': secret},
        json=payload, extensions={'timeout': {'connect': 10., 'read': 10., 'write': 10., 'pool': 10.}})
    try:
        # Direct transport emits no httpx client URL log and does not follow redirects.
        with transport or httpx.HTTPTransport(retries=0) as connection:
            response = connection.handle_request(request)
            try:
                result['http_status'] = response.status_code
                if response.status_code != 200:
                    return {**result, 'error': 'ANALYTICS_VALIDATION_HTTP_FAILED'}
                content = bytearray()
                for chunk in response.iter_bytes():
                    if len(content) + len(chunk) > 64 * 1024:
                        return {**result, 'error': 'ANALYTICS_VALIDATION_RESPONSE_INVALID'}
                    content.extend(chunk)
                reply = json.loads(content)
            finally:
                response.close()
        messages = reply.get('validationMessages') if isinstance(reply, dict) else None
        if not isinstance(messages, list):
            return {**result, 'error': 'ANALYTICS_VALIDATION_RESPONSE_INVALID'}
        safe_messages = []
        for message in messages:
            if not isinstance(message, dict):
                return {**result, 'error': 'ANALYTICS_VALIDATION_RESPONSE_INVALID'}
            safe_messages.append({key: re.sub(r'https?://\S+', '[redacted URL]', str(message.get(key, '')).replace(secret, '[redacted]'))[:2000]
                for key in ('fieldPath', 'description', 'validationCode')})
        return {**result, 'valid': not safe_messages, 'validation_messages': safe_messages}
    except (httpx.HTTPError, OSError, ValueError, TypeError):
        # Exception strings can contain the secret-bearing request URL.
        return {**result, 'error': 'ANALYTICS_VALIDATION_UNAVAILABLE'}


def main() -> int:
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, help='Only this explicitly selected private dotenv file is read')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/analytics-config/validation.json')
    args = parser.parse_args()
    # Prevent verbose third-party logging from exposing credentials, even under caller configuration.
    logging.getLogger('httpx').disabled = True
    for name in ('httpcore', 'httpcore.connection', 'httpcore.http11', 'httpcore.http2', 'httpcore.proxy'):
        logging.getLogger(name).disabled = True
    try:
        values = dotenv_values(args.env_file, interpolate=False, encoding='utf-8-sig') if args.env_file else os.environ
        config = {key: values.get(key, '') or '' for key in CONFIG_KEYS}
        result = validate(config['GA4_EXTENSION_MEASUREMENT_ID'], config['GA4_EXTENSION_API_SECRET'])
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result['valid'] else 1
    except Exception:
        # Do not let CLI tracebacks accidentally disclose a secret or configured request URL.
        print('ANALYTICS_VALIDATION_TOOL_FAILED')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
