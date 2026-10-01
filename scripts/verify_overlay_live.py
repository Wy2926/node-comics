"""Verify canonical images with an authorized real LLM/GPU and isolated Docker.
Sources are read only; one supplier/node serves a sequential chapter. Persist
UUIDs before submission, retry explicit 429 only, observe ambiguous writes without
resubmitting. Existing run directories are refused. Never print OCR or secrets.
"""
import argparse
from collections import Counter
from email.utils import parsedate_to_datetime
import gc
import hashlib
import json
import logging
from pathlib import Path
import re
import ssl
import sys
import time
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from PIL import Image

EXTENSIONS = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}
TERMINAL = {'succeeded', 'failed', 'needs_attention', 'cancelled'}


class VerificationFailure(Exception):
    """Only fixed error codes, never supplier/server exception messages."""


def save_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def dotenv(path):
    values = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def source_files(source):
    if source.is_file():
        return [source]
    if not source.is_dir():
        raise VerificationFailure('SOURCE_NOT_FOUND')
    files = [p for p in source.iterdir() if p.is_file() and p.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'}]
    files.sort(key=lambda p: [int(s) if s.isdigit() else s.casefold() for s in re.split(r'(\d+)', p.name)])
    if not files:
        raise VerificationFailure('SOURCE_IMAGES_EMPTY')
    return files


def canonical_source(path):
    source = path.read_bytes()
    with Image.open(path) as image:
        mime, (width, height) = Image.MIME.get(image.format), image.size
        if mime not in EXTENSIONS:
            raise VerificationFailure('SOURCE_FORMAT_UNSUPPORTED')
        # Direct API verifier accepts only already normalized input. The official
        # client applies EXIF/sRGB/first-frame normalization before sending bytes.
        if (getattr(image, 'is_animated', False) or image.getexif() or
                any(image.info.get(k) for k in ('icc_profile', 'gamma', 'chromaticity'))):
            raise VerificationFailure('SOURCE_REQUIRES_CLIENT_NORMALIZATION')
        # Admission belongs to the isolated center, not a stale verifier ceiling.
    return source, {'sha256': hashlib.sha256(source).hexdigest(), 'byte_size': len(source),
                    'content_type': mime, 'normalization_version': 1}, width, height


def error_code(value):
    error = value.get('error') if isinstance(value, dict) else None
    code = error.get('code') if isinstance(error, dict) else error
    return code if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,95}', code) else 'REQUEST_FAILED'


def checked(response, statuses=(200,)):
    try:
        value = response.json()
    except ValueError:
        raise VerificationFailure('INVALID_RESPONSE') from None
    if response.status_code not in statuses:
        raise VerificationFailure(error_code(value))
    return value


def retry_after(response):
    value = response.headers.get('Retry-After', '')
    try:
        return max(.1, float(value))
    except ValueError:
        try:
            return max(.1, parsedate_to_datetime(value).timestamp() - time.time())
        except (ValueError, TypeError, OverflowError):
            return 1.


def summarize(pages, elapsed):
    times = sorted(p['elapsed_seconds'] for p in pages)
    successful = [p for p in pages if p['state'] == 'succeeded']
    successful_input = sum(p.get('input_bytes', 0) for p in successful)
    artifact_bytes = sum(p.get('artifact_bytes', 0) for p in successful)
    return {'pages': len(pages), 'states': dict(Counter(p['state'] for p in pages)),
            'kinds': dict(Counter(p.get('kind', 'unknown') for p in successful)),
            'representations': dict(Counter(p.get('representation', 'unknown') for p in successful)),
            'elapsed_seconds': round(elapsed, 3), 'input_bytes': sum(p.get('input_bytes', 0) for p in pages),
            'successful_input_bytes': successful_input, 'artifact_bytes': artifact_bytes,
            'artifact_to_input_ratio': round(artifact_bytes / successful_input, 6) if successful_input else None,
            'page_seconds_p50': times[len(times) // 2] if times else None,
            'page_seconds_p95': times[min(len(times) - 1, int(len(times) * .95))] if times else None}


def run_page(client, auth, other, agent, source_path, directory, ordinal, timeout):
    directory.mkdir()
    started = time.monotonic()
    deadline = started + timeout
    item = {'ordinal': ordinal, 'source_name': source_path.name, 'directory': directory.name,
            'request_id': str(uuid4()), 'state': 'preparing', 'artifact_bytes': 0, 'checks': {}}
    request_path = '/v1/translations/' + item['request_id']

    def save():
        item['elapsed_seconds'] = round(time.monotonic() - started, 3)
        save_json(directory / 'report.json', item)

    def tick(delay=.1):
        until = min(deadline, time.monotonic() + delay)
        while True:
            agent.poll_control()
            agent.reap()
            if time.monotonic() >= deadline:
                raise VerificationFailure('PAGE_TIMEOUT_OBSERVE_EXISTING_UUID')
            remaining = until - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(.1, remaining))

    def write(path, **kwargs):
        while True:
            tick(0)
            try:
                response = client.put(path, headers=auth if 'content' not in kwargs else
                                      {**auth, 'Content-Type': item['input_mime']}, **kwargs)
            except httpx.TransportError:
                item['ambiguous_write'] = True
                save()
                return None  # Observe this UUID; never repeat an ambiguous write.
            if response.status_code != 429:
                return checked(response, (200, 202))
            item['admission_retries'] = item.get('admission_retries', 0) + 1
            item['retry_after_seconds'] = retry_after(response)
            save()
            tick(item['retry_after_seconds'])

    try:
        source, image, width, height = canonical_source(source_path)
        source_name = 'source' + EXTENSIONS[image['content_type']]
        (directory / source_name).write_bytes(source)
        body = {'image': image, 'mode': 'classic', 'target_language': 'zh-Hans'}
        item.update(input_bytes=len(source), input_mime=image['content_type'], input_sha256=image['sha256'],
                    width=width, height=height, source_file=source_name, state='submitting')
        save_json(directory / 'intent.json', {'request_id': item['request_id'], 'body': body})
        save()  # Persist intent before the first possible paid call.
        state = write(request_path, json=body)
        uploaded = False
        while True:
            if state:
                item['state'] = state['state']
                save()
                if state['state'] in TERMINAL:
                    save_json(directory / 'snapshot.json', state)
                    break
                if state['state'] == 'needs_input' and not uploaded:
                    uploaded = True
                    state = write(request_path + '/input', content=source)
                    continue
            tick(.25)
            try:
                response = client.get(request_path, headers=auth)
            except httpx.TransportError:
                continue
            if response.status_code in {404, 429, 502, 503, 504}:
                if response.status_code == 429:
                    tick(retry_after(response))
                continue
            state = checked(response)
        if state['state'] != 'succeeded':
            item['error_code'] = error_code(state)
            return item
        result = state['result']
        if result['input_sha256'] != image['sha256'] or result['normalization_version'] != 1:
            raise VerificationFailure('RESULT_INPUT_MISMATCH')
        representation = result['representation']
        if representation not in {'overlay-v1', 'full-image-v1', 'original'}:
            raise VerificationFailure('RESULT_REPRESENTATION_INVALID')
        if representation != 'full-image-v1' and (result['width'], result['height']) != (width, height):
            raise VerificationFailure('RESULT_DIMENSIONS_MISMATCH')
        save_json(directory / 'result.json', result)
        item.update(kind=result['kind'], representation=representation)
        artifact = result.get('artifact')
        if representation == 'original':
            if artifact is not None:
                raise VerificationFailure('ORIGINAL_HAS_ARTIFACT')
            item['checks']['original_without_download'] = True
        else:
            if not artifact or artifact['path'] != request_path + '/result':
                raise VerificationFailure('RESULT_PATH_MISMATCH')
            fetched = client.get(artifact['path'], headers=auth)
            if fetched.status_code != 200 or fetched.headers.get('content-type', '').split(';')[0] != artifact['mime']:
                raise VerificationFailure('ARTIFACT_RESPONSE_INVALID')
            if len(fetched.content) != artifact['byte_size'] or hashlib.sha256(fetched.content).hexdigest() != artifact['sha256']:
                raise VerificationFailure('ARTIFACT_DIGEST_MISMATCH')
            artifact_file = 'artifact' + EXTENSIONS[artifact['mime']]
            (directory / artifact_file).write_bytes(fetched.content)
            item.update(artifact_file=artifact_file, artifact_bytes=len(fetched.content), artifact_sha256=artifact['sha256'])
            if (client.get(artifact['path'], headers={'X-Translation-Protocol': 'overlay-v1'}).status_code != 401
                    or client.get(artifact['path'], headers=other).status_code != 404):
                raise VerificationFailure('ARTIFACT_AUTHORIZATION_FAILED')
            item['checks'].update(authenticated_download=True, anonymous_denied=True, other_account_denied=True)
        details = checked(client.get(request_path + '/classic', headers=auth))
        save_json(directory / 'classic.json', details)
        repeated = checked(client.put(request_path, headers=auth, json=body))
        if repeated.get('result') != result:
            raise VerificationFailure('UUID_REPLAY_CHANGED_RESULT')
        item['checks']['uuid_replay'] = True
    except VerificationFailure as error:
        item.update(observed_state=item['state'], state='verification_failed', error_code=str(error))
    except httpx.TransportError:
        item.update(observed_state=item['state'], state='verification_failed', error_code='TRANSPORT_ERROR_OBSERVE_EXISTING_UUID')
    except Exception as error:
        item.update(observed_state=item['state'], state='verification_failed', error_code='UNEXPECTED_' + type(error).__name__.upper())
    finally:
        save()
    return item


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='https://localhost:18493')
    parser.add_argument('--ca', type=Path, required=True)
    parser.add_argument('--key-file', type=Path, required=True)
    parser.add_argument('--runtime-config', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True, help='Canonical static image or directory of page images')
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--timeout', type=int, default=900, help='Per-page deadline, including admission retries')
    parser.add_argument('--protocol', choices=['chat_completions', 'responses'], default='chat_completions')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    run = args.run_dir.resolve()
    if urlsplit(args.base_url).hostname not in {'localhost', '127.0.0.1'}:
        parser.error('This verifier only targets an isolated loopback Docker center')
    if not run.is_relative_to(root / 'artifacts') or run.exists():
        parser.error('Use a new directory inside artifacts; inspect old UUIDs instead of repeating unknown calls')
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    files = source_files(args.source)
    private = dotenv(args.key_file)
    if not all(private.get(k) for k in ('TEXT_API_KEY', 'TEXT_BASE_URL', 'TEXT_MODEL')):
        parser.error('Private dotenv must contain TEXT_API_KEY, TEXT_BASE_URL and TEXT_MODEL')
    run.mkdir(parents=True)
    logging.disable(logging.CRITICAL)
    sys.path.insert(0, str(root / 'services/classic-engine'))
    from classic_node.agent import Agent
    from classic_node.journal import Journal
    from classic_node.runtime import Runtime
    from classic_node.transport import Transport

    config = json.loads(args.runtime_config.read_text(encoding='utf-8'))
    runtime = Runtime(config)
    report = {'schema': 'node-comics-overlay-verification/1', 'real_text_provider': True,
              'real_image_engine': True, 'r2_used': False, 'engine_version': runtime.version,
              'model': private['TEXT_MODEL'], 'expected_pages': len(files), 'pages': []}
    started = time.monotonic()

    def save():
        report['summary'] = summarize(report['pages'], time.monotonic() - started)
        save_json(run / 'report.json', report)

    save()
    transport = journal = agent = None
    try:
        with httpx.Client(base_url=args.base_url, verify=ssl.create_default_context(cafile=str(args.ca)),
                          trust_env=False, follow_redirects=False, timeout=30) as client:
            def login(username):
                result = checked(client.post('/v1/auth/dev', json={'username': username}))
                return {'Authorization': 'Bearer ' + result['access_token'], 'X-Translation-Protocol': 'overlay-v1'}
            admin = login('admin')
            if checked(client.get('/v1/capabilities', headers=admin))['result_protocol'] != 'overlay-v1':
                raise VerificationFailure('PROTOCOL_HANDSHAKE_FAILED')
            providers = checked(client.get('/v1/admin/translation-providers', headers=admin))['items']
            if any(provider['name'] != 'Isolated real overlay verification' for provider in providers):
                raise VerificationFailure('CENTER_HAS_UNRELATED_PROVIDER')
            for provider in providers:
                if provider['enabled']:
                    checked(client.patch('/v1/admin/translation-providers/' + provider['id'],
                                         headers=admin, json={'enabled': False}))
            settings = checked(client.get('/v1/admin/system-settings', headers=admin))
            values = settings['values']
            values['free_daily_pages'] = max(values['free_daily_pages'], len(files) + 100)
            checked(client.put('/v1/admin/system-settings', headers=admin,
                               json={'expected_version': settings['version'], 'values': values}))
            username = 'overlay-batch-' + uuid4().hex
            auth, other = login(username), login('other-overlay-user')
            report['reader_username'] = username
            provider = checked(client.post('/v1/admin/translation-providers', headers=admin, json={
                'name': 'Isolated real overlay verification', 'channel': 'openai', 'enabled': True,
                'text_weight': 1, 'title_weight': 0, 'requests_per_minute': 60,
                'api_key': private['TEXT_API_KEY'], 'config': {
                    'base_url': private['TEXT_BASE_URL'], 'model': private['TEXT_MODEL'],
                    'protocol': args.protocol, 'reasoning_effort': 'low',
                    'max_output_tokens': 8192, 'timeout_seconds': 120, 'max_attempts': 1,
                    'group_bytes': 1800}}), (201,))
            private.clear()
            nodes = checked(client.get('/v1/admin/compute-nodes', headers=admin))['items']
            existing = next((node for node in nodes if node['resource_id'] == 'overlay-live:vulkan:1'), None)
            if existing:
                if existing['name'] != 'Isolated real GPU' or existing['running']:
                    raise VerificationFailure('TEST_RESOURCE_HAS_UNRELATED_OR_ACTIVE_NODE')
                node = checked(client.post('/v1/admin/compute-nodes/' + existing['id'] + '/rotate-credential', headers=admin))
            else:
                node = checked(client.post('/v1/admin/compute-nodes', headers=admin,
                    json={'name': 'Isolated real GPU', 'resource_id': 'overlay-live:vulkan:1'}), (201,))
            report.update(provider_id=provider['id'], node_id=node['node_id'])
            save()
            config.update(node_id=node['node_id'], node_token=node['token'], resource_id='overlay-live:vulkan:1',
                          control_url=args.base_url, control_ca=str(args.ca.resolve()))
            transport = Transport(config)
            journal = Journal(run / 'node-journal')
            agent = Agent(config, runtime, transport, journal)
            agent.register()
            if checked(client.get('/health/cluster'))['status'] != 'ready':
                raise VerificationFailure('CENTER_NOT_READY')
            for ordinal, source_path in enumerate(files, 1):
                item = run_page(client, auth, other, agent, source_path, run / f'{ordinal:05}', ordinal, args.timeout)
                report['pages'].append(item)
                save()
                print(json.dumps({'page': ordinal, 'total': len(files), 'state': item['state'],
                                  'seconds': item['elapsed_seconds'], 'input_bytes': item.get('input_bytes', 0),
                                  'artifact_bytes': item.get('artifact_bytes', 0), 'error_code': item.get('error_code')}, ensure_ascii=False), flush=True)
            print(json.dumps({'summary': report['summary']}, ensure_ascii=False), flush=True)
    finally:
        save()
        if agent is not None:
            agent.close()
        if transport is not None:
            transport.close()
        if journal is not None:
            journal.close()
        runtime.close()
        agent = transport = journal = None
        del runtime
        gc.collect()
        import ncnn
        ncnn.destroy_gpu_instance()
    return 0 if all(p['state'] == 'succeeded' for p in report['pages']) else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except VerificationFailure as error:
        print(json.dumps({'error_code': str(error)}), flush=True)
        sys.exit(1)
