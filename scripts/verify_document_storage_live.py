"""Opt-in real R2/PDF smoke; never uploads private user files or changes bucket policy.

Run with backend/.venv/Scripts/python.exe on Windows. The default parser sandbox
is mandatory on Linux; --allow-unsandboxed is only for this isolated local smoke.
Only a fresh random subprefix is created/deleted. Secrets and signed URLs are not
printed, included in reports, or persisted. This does not validate GPU/LLM quality.
"""
from argparse import ArgumentParser
from collections import Counter
from contextlib import closing
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
from time import perf_counter
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'services/classic-engine'))

import httpx
from dotenv import dotenv_values
from PIL import Image, ImageDraw
from app.documents.config import DocumentSettings
from comic_document_files import run_file_operation, package_zip
from app.documents.storage import DocumentStore, DocumentStoreError
from classic_node.object_transfer import ObjectTransfer


class VerificationError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def verify(env_file, *, allow_unsandboxed=False):
    values = dotenv_values(env_file)
    required = ('R2_ENDPOINT_URL', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    if any(not values.get(name) for name in required):
        raise VerificationError('R2_TEST_CONFIGURATION_MISSING')
    base = (values.get('R2_KEY_PREFIX') or 'isolated').strip('/')
    prefix = base + '/document-smoke-' + uuid4().hex
    config = DocumentSettings(_env_file=None, enabled=True, r2_endpoint_url=values['R2_ENDPOINT_URL'],
        r2_bucket=values['R2_BUCKET'], r2_access_key_id=values['R2_ACCESS_KEY_ID'],
        r2_secret_access_key=values['R2_SECRET_ACCESS_KEY'], r2_key_prefix=prefix)
    store, job = DocumentStore(config), uuid4().hex
    operations, timings, uploads = Counter(), {}, []
    report = {'status': 'running', 'source_limit_bytes': 200_000_000,
              'parser_boundary': 'local-process-only' if allow_unsandboxed else 'linux-bubblewrap',
              'gpu_or_llm_verified': False}

    def track(**kwargs):
        event = kwargs.get('event_name', '')
        operations[event.rsplit('.', 1)[-1] or 's3'] += 1
    store.client.meta.events.register('before-send.s3.*', track)

    def upload_parts(client, path, key, mime):
        with path.open('rb') as source:
            sha = hashlib.file_digest(source, 'sha256').hexdigest()
        upload_id = store.create_multipart(key, mime, sha256=sha)
        uploads.append((key, upload_id))
        number = 0
        with path.open('rb') as source:
            while chunk := source.read(config.upload_part_bytes):
                number += 1
                signed = store.presign_upload_part(key, upload_id, number, byte_size=len(chunk))
                response = client.put(signed['url'], content=chunk, headers=signed['headers'])
                operations['presigned_upload_part'] += 1
                if response.status_code != 200:
                    raise VerificationError('R2_SIGNED_PART_HTTP_' + str(response.status_code))
        ref = store.complete_multipart(key, upload_id, expected_size=path.stat().st_size, expected_sha256=sha)
        uploads.remove((key, upload_id))
        return {**ref, 'sha256': sha}, number

    started = perf_counter()
    try:
        with TemporaryDirectory(prefix='document-r2-smoke-') as temporary, closing(ObjectTransfer()) as transfers, httpx.Client(
                timeout=httpx.Timeout(120, connect=15), follow_redirects=False) as client:
            directory = Path(temporary)
            source = directory / 'multipart-fixture'
            with source.open('wb') as handle:
                chunk = bytes(range(256)) * 4096
                for _ in range(16):
                    handle.write(chunk)
                handle.write(b'isolated-document-multipart-final-part')
            at = perf_counter()
            ref, count = upload_parts(client, source, store.key('input', job, 'multipart', 'source'),
                                      'application/octet-stream')
            store.get_to_file(ref, directory / 'downloaded-fixture')
            timings['multipart_upload_seal_download_seconds'] = round(perf_counter() - at, 3)
            report['multipart'] = {'parts': count, 'byte_size': ref['byte_size'], 'sha256': ref['sha256']}
            if count != 2:
                raise VerificationError('MULTIPART_PART_COUNT')

            at = perf_counter()
            large = store.put_file(store.key('output', job, 'large-artifact', 'fixture.bin'),
                                   source, 'application/octet-stream')
            store.get_to_file(large, directory / 'downloaded-large-artifact')
            if large['sha256'] != ref['sha256']:
                raise VerificationError('LARGE_ARTIFACT_HASH')
            timings['worker_multipart_upload_download_seconds'] = round(perf_counter() - at, 3)
            report['worker_multipart'] = {'byte_size': large['byte_size'], 'sha256': large['sha256']}

            pdf = directory / 'two-pages.pdf'
            images = []
            for number in (1, 2):
                image = Image.new('RGB', (360, 480), 'white')
                ImageDraw.Draw(image).text((30, 40), f'Node Comics isolated document storage page {number}', fill='black')
                images.append(image)
            images[0].save(pdf, 'PDF', save_all=True, append_images=images[1:])
            for image in images:
                image.close()
            pdf_ref, _ = upload_parts(client, pdf, store.key('input', job, 'pdf', 'source'), 'application/pdf')
            downloaded = directory / 'source.pdf'
            document_io = Counter()
            transfers.client.event_hooks['request'].append(lambda request: document_io.update([request.method]))
            transfers.download_to_file(pdf_ref, store.presign_get(pdf_ref), downloaded)
            at = perf_counter()
            normalized = run_file_operation('normalize', downloaded, 'pdf', directory / 'pages',
                                             require_sandbox=not allow_unsandboxed)
            timings['pdf_prepare_seconds'] = round(perf_counter() - at, 3)
            if len(normalized) != 2:
                raise VerificationError('PDF_PAGE_COUNT')
            at = perf_counter()
            artifact = package_zip(normalized, directory / 'translated.zip')
            output = {name: artifact[name] for name in ('sha256', 'byte_size', 'mime')}
            output['key'] = store.key('output', job, 'packaged', 'translated.zip')
            transfers.upload_file(output, store.presign_put(output), artifact['path'])
            store.verify(output)
            if document_io != {'GET': 1, 'PUT': 1}:
                raise VerificationError('DOCUMENT_INTERMEDIATE_TRANSFER')
            report['document_node_io'] = dict(document_io)
            report['document_intermediate_r2_objects'] = 0
            signed = store.presign_download(output['key'], 'isolated-translated.zip')
            final = directory / 'download.zip'
            digest, received = hashlib.sha256(), 0
            with client.stream('GET', signed['url'], headers=signed['headers']) as response:
                operations['presigned_download'] += 1
                if response.status_code != 200:
                    raise VerificationError('R2_SIGNED_DOWNLOAD_HTTP_' + str(response.status_code))
                with final.open('xb') as handle:
                    for chunk in response.iter_bytes(1024 * 1024):
                        received += len(chunk)
                        if received > output['byte_size']:
                            raise VerificationError('ZIP_DOWNLOAD_SIZE')
                        digest.update(chunk)
                        handle.write(chunk)
            if received != output['byte_size'] or digest.hexdigest() != output['sha256']:
                raise VerificationError('ZIP_DOWNLOAD_HASH')
            with zipfile.ZipFile(final) as archive:
                if archive.namelist() != ['0001.png', '0002.png'] or archive.testzip() is not None:
                    raise VerificationError('ZIP_CONTENTS')
                for name in archive.namelist():
                    with Image.open(BytesIO(archive.read(name))) as image:
                        image.verify()
            url = urlsplit(signed['url'])
            unsigned = client.get(urlunsplit((url.scheme, url.netloc, url.path, '', '')))
            operations['unsigned_s3_read'] += 1
            report['unsigned_s3_status'] = unsigned.status_code
            match = re.search(r'<Code>([A-Za-z0-9_]{1,60})</Code>', unsigned.text[:4096])
            report['unsigned_s3_error_code'] = match.group(1) if match else None
            # R2's S3 endpoint currently rejects an entirely unsigned URL with
            # 400 InvalidArgument. Also require a rejected *invalid* signature;
            # this is an endpoint/object access check, not a bucket-policy audit.
            if unsigned.status_code not in {400, 401, 403}:
                raise VerificationError('UNSIGNED_S3_READ_NOT_DENIED')
            if unsigned.status_code == 400 and report['unsigned_s3_error_code'] != 'InvalidArgument':
                raise VerificationError('UNSIGNED_S3_UNEXPECTED_ERROR')
            query = parse_qsl(url.query, keep_blank_values=True)
            if not any(key == 'X-Amz-Signature' for key, _ in query):
                raise VerificationError('SIGNED_URL_SIGNATURE_MISSING')
            query = [(key, '0' * len(value) if key == 'X-Amz-Signature' else value) for key, value in query]
            tampered = client.get(urlunsplit((url.scheme, url.netloc, url.path, urlencode(query), '')))
            operations['invalid_signature_s3_read'] += 1
            match = re.search(r'<Code>([A-Za-z0-9_]{1,60})</Code>', tampered.text[:4096])
            report['invalid_signature_s3_status'] = tampered.status_code
            report['invalid_signature_s3_error_code'] = match.group(1) if match else None
            if tampered.status_code != 403 or report['invalid_signature_s3_error_code'] != 'SignatureDoesNotMatch':
                raise VerificationError('INVALID_SIGNATURE_S3_READ_NOT_DENIED')
            timings['zip_upload_download_seconds'] = round(perf_counter() - at, 3)
            report.update(status='passed', pdf_pages=2,
                output={'byte_size': output['byte_size'], 'sha256': output['sha256'], 'entries': ['0001.png', '0002.png']},
                unsigned_s3_status=unsigned.status_code)
    finally:
        cleanup_ok = True
        for key, upload_id in uploads:
            try:
                store.abort_multipart(key, upload_id)
            except DocumentStoreError:
                cleanup_ok = False
        deleted = 0
        for category in ('input', 'work', 'output'):
            try:
                # Only this execution's category/job subprefix; no bucket listing/cleanup.
                for _ in range(5):
                    result = store.delete_prefix(f'{prefix}/{category}/{job}', limit=100)
                    deleted += result['deleted']
                    if not result['more']:
                        break
                else:
                    cleanup_ok = False
            except DocumentStoreError:
                cleanup_ok = False
        report.update(cleanup={'complete': cleanup_ok, 'objects_deleted': deleted},
                      operations=dict(operations), timings=timings, total_seconds=round(perf_counter() - started, 3))
        if not cleanup_ok:
            # This isolated prefix is safe to show and identifies only test fixtures.
            report['cleanup_prefix'] = prefix + '/'
        print(json.dumps(report, ensure_ascii=False))
    if not report['cleanup']['complete']:
        raise VerificationError('R2_TEST_CLEANUP_INCOMPLETE')


if __name__ == '__main__':
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env')
    parser.add_argument('--allow-unsandboxed', action='store_true',
                        help='Isolated developer smoke only; never use for a production worker')
    args = parser.parse_args()
    try:
        verify(args.env_file, allow_unsandboxed=args.allow_unsandboxed)
    except Exception as error:
        # No exception repr/traceback: HTTP transport errors may contain signed URLs.
        print(json.dumps({'status': 'failed', 'code': getattr(error, 'code', type(error).__name__)}))
        raise SystemExit(1) from None
