"""Document v2 fixtures: actual local checkpoints, no R2 service/models/GPU."""
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
from io import BytesIO
import json
import logging
from pathlib import Path
from threading import Event
import time
from types import SimpleNamespace
import zipfile

import httpx
import numpy as np
from PIL import Image
import pytest

from comic_document_files import DocumentFileError, FileLimits
from classic_node.document_runner import PREFIX
from classic_node.document_workspace import DocumentWorkspace
from classic_node.object_transfer import ObjectTransfer
from classic_node.protocol import ControlFailure, NodeFailure, digest
from test_node_runtime import fixture as runtime_fixture
from test_node_scheduling import PendingPool, add_page, agent, clock


URL = 'https://fixture.r2.cloudflarestorage.com/private/page?X-Amz-Signature=private'


def reference(data=b'png', **changes):
    return {'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data),
            'mime': 'image/png', 'width': 10, 'height': 10, **changes}


def image_bytes(color='white'):
    out = BytesIO()
    with Image.new('RGB', (10, 10), color) as image:
        image.save(out, 'PNG')
    return out.getvalue()


def source_bytes():
    out = BytesIO()
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_STORED) as archive:
        archive.writestr(zipfile.ZipInfo('1.png', date_time=(1980, 1, 1, 0, 0, 0)), image_bytes())
    return out.getvalue()


def add_document(agent, key='document', *, action='doc_ocr', generation=1):
    server, expires = clock()
    lease = {'lease_id': key, 'lease_token': 'token-' + key, 'job_id': 'book', 'page_index': 1,
             'generation': 1, 'workspace_generation': generation, 'action': action, 'status': 'active',
             'expires_at': expires, 'language': 'en', 'input': reference(),
             'translations': {'translations': {'0': 'Translated'}, 'language': 'en', 'revision': 'r1'}}
    if action == 'doc_prepare':
        data = source_bytes()
        lease.update(source_type='zip', source={'ref': {'key': 'isolated/source.zip',
            'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data), 'mime': 'application/zip'},
            'transfer': {'url': URL, 'headers': {}, 'expires_in': 900}})
    if action == 'doc_zip':
        lease.update(output_key='isolated/result.zip', pages=[])
    agent.documents.adopt(lease, server, time.monotonic())
    return agent.documents.pages[key]


def pending_pools(agent):
    for name in ('download', 'compute', 'render', 'delivery'):
        getattr(agent.pipeline, name).shutdown(wait=True)
        setattr(agent.pipeline, name, PendingPool())


def write_source(ref, path, check):
    check()
    path.write_bytes(source_bytes())


def local_workspace(agent, page, *, prepared=True):
    workspace = DocumentWorkspace(agent.documents.state_dir, page.lease['job_id'],
        page.lease['workspace_generation'], owner_id=agent.local['node_id'], create=True, require_sandbox=False)
    page.document_workspace = workspace
    if prepared:
        data = source_bytes()
        rows = workspace.prepare({'sha256': hashlib.sha256(data).hexdigest(),
            'byte_size': len(data), 'mime': 'application/zip'}, 'zip', write_source)
        page.lease['input'] = {key: rows[0][key] for key in ('sha256', 'byte_size', 'mime', 'width', 'height')}
    return workspace


def analysis_for(page, *, text=True):
    return {'input_hash': page.lease['input']['sha256'], 'width': 10, 'height': 10,
        'segments': [{'id': '0', 'source': 'Source'}] if text else [], 'regions': [], 'mask': None}


def freeze_ocr(agent, page, *, text=True):
    local_workspace(agent, page)
    page.analysis = analysis_for(page, text=text)
    body = agent.documents.persist(page)
    agent.documents.freeze(page, body)
    return body


def frozen_zip(agent):
    page = add_document(agent, action='doc_zip')
    workspace = local_workspace(agent, page)
    analysis = analysis_for(page, text=False)
    saved = workspace.save_analysis(1, analysis)
    workspace.save_checkpoint(1, 'doc_ocr', {'analysis_ref': saved,
        'text': {'page_index': 1, 'analysis_hash': digest(analysis), 'segments': []}, 'no_text': True})
    page.lease['pages'] = [{'page_index': 1, 'output_ref': page.lease['input']}]
    agent.documents.freeze(page, agent.documents.package(page))
    return page


def refresh_reply(page):
    return {'source': {**page.lease['source'], 'transfer': {**page.lease['source']['transfer'], 'expires_in': 900}}}


def test_prepare_reuses_fresh_claim_signature_and_downloads_source_once(agent):
    page = add_document(agent, action='doc_prepare')
    local_workspace(agent, page, prepared=False)
    agent.transport.document_post = lambda *_: pytest.fail('Fresh source URL needs no resign')
    calls = []
    def download(ref, transfer, path, check):
        calls.append(transfer)
        write_source(ref, path, check)
    agent.documents.objects.download_to_file = download
    rows = agent.documents.prepare(page)
    assert len(rows['pages']) == 1
    assert agent.documents.prepare(page) == rows
    assert len(calls) == page.timings['download_get_attempts'] == 1
    assert 'download_sign_attempts' not in page.timings


def test_source_signature_expires_in_download_queue_and_resigns_once(agent):
    page = add_document(agent, action='doc_prepare')
    local_workspace(agent, page, prepared=False)
    agent.documents.set_source(page, page.lease['source'], time.monotonic() - 901)
    seen = []
    agent.transport.document_post = lambda path, body: (seen.append(path), refresh_reply(page))[1]
    agent.documents.objects.download_to_file = lambda ref, transfer, path, check: write_source(ref, path, check)
    assert len(agent.documents.prepare(page)['pages']) == 1
    assert seen == ['/leases/document/inputs'] and page.timings['download_sign_attempts'] == 1


def test_signature_expiry_uses_dispatch_monotonic_not_wall_clock(agent):
    page = add_document(agent, action='doc_prepare')
    server = datetime(2040, 1, 1, tzinfo=timezone.utc)
    lease = {**page.lease, 'expires_at': (server + timedelta(seconds=300)).isoformat()}
    sent = time.monotonic()
    agent.documents.adopt(lease, server.isoformat(), sent)
    assert page.deadline == sent + 298 and page.document_source[1] == sent + 898


def test_sync_replaces_memory_signature_without_persisting_url(agent):
    page = add_document(agent, action='doc_prepare')
    page.document_source = (page.document_source[0], 0)
    server, _ = clock()
    replacement = {**page.lease, **refresh_reply(page)}
    replacement['source']['transfer']['url'] = URL + '-renewed'
    agent.documents.adopt(replacement, server, time.monotonic())
    assert page.document_source[1] > time.monotonic()
    assert page.document_source[0]['transfer']['url'].endswith('-renewed')
    saved = json.dumps(agent.journal.get(PREFIX + 'document'))
    assert 'Signature' not in saved and 'cloudflarestorage' not in saved


@pytest.mark.parametrize('status', [403, 503])
def test_source_transfer_retry_resigns_once_and_keeps_bounded_file(agent, status):
    page = add_document(agent, action='doc_prepare')
    local_workspace(agent, page, prepared=False)
    paths, attempts = [], []
    agent.transport.document_post = lambda path, body: (paths.append(path), refresh_reply(page))[1]
    def download(ref, transfer, path, check):
        attempts.append(True)
        if len(attempts) == 1:
            raise ControlFailure('DOCUMENT_TRANSFER_FAILED', status)
        write_source(ref, path, check)
    agent.documents.objects.download_to_file = download
    assert len(agent.documents.prepare(page)['pages']) == 1
    assert paths == ['/leases/document/inputs'] and len(attempts) == 2


def test_second_forbidden_source_is_definitive(agent):
    page = add_document(agent, action='doc_prepare')
    local_workspace(agent, page, prepared=False)
    paths, attempts = [], []
    agent.transport.document_post = lambda path, body: (paths.append(path), refresh_reply(page))[1]
    def download(*_):
        attempts.append(True)
        raise ControlFailure('DOCUMENT_TRANSFER_FAILED', 403)
    agent.documents.objects.download_to_file = download
    with pytest.raises(ControlFailure) as failure:
        agent.documents.prepare(page)
    assert failure.value.status == 403
    assert len(attempts) == 2 and paths == ['/leases/document/inputs']


def test_expired_lease_stops_before_local_or_remote_download(agent):
    page = add_document(agent, action='doc_prepare')
    local_workspace(agent, page, prepared=False)
    page.deadline = time.monotonic() - 1
    agent.transport.document_post = agent.documents.objects.download_to_file = lambda *_: pytest.fail('Expired')
    with pytest.raises(NodeFailure, match='LEASE_STOPPED'):
        agent.documents.prepare(page)


def test_resign_cannot_change_source_identity(agent):
    page = add_document(agent, action='doc_prepare')
    local_workspace(agent, page, prepared=False)
    page.document_source = (page.document_source[0], 0)
    reply = refresh_reply(page)
    reply['source']['ref'] = {**reply['source']['ref'], 'sha256': '0' * 64}
    agent.transport.document_post = lambda *_: reply
    agent.documents.objects.download_to_file = lambda *_: pytest.fail('Identity changed')
    with pytest.raises(NodeFailure, match='CONTROL_INVALID_RESPONSE'):
        agent.documents.prepare(page)


def test_direct_transfers_have_no_control_credentials_and_validate_digest(monkeypatch, tmp_path):
    monkeypatch.setenv('HTTP_PROXY', 'http://unused.invalid:8080')
    seen = []
    def handler(request):
        seen.append(request)
        assert 'authorization' not in request.headers and 'cookie' not in request.headers
        if request.method == 'PUT':
            assert request.read() == b'png' and request.headers['if-none-match'] == '*'
            return httpx.Response(412)
        assert request.headers['if-match'] == 'version'
        return httpx.Response(200, content=b'png')
    objects = ObjectTransfer(transport=httpx.MockTransport(handler))
    try:
        get = {'url': URL, 'headers': {'If-Match': 'version'}}
        put = {'url': URL, 'headers': {'If-None-Match': '*', 'Content-Length': '3'}}
        path = objects.download_to_file(reference(), get, tmp_path / 'source.bin')
        assert path.read_bytes() == b'png'
        objects.upload_file(reference(), put, path)
        with pytest.raises(NodeFailure, match='INPUT_HASH_MISMATCH'):
            objects.download_to_file(reference(sha256='a' * 64), get, tmp_path / 'bad.bin')
    finally:
        objects.close()
    assert len(seen) == 3 and not (tmp_path / 'bad.bin').exists()


@pytest.mark.parametrize('transfer', [
    {'url': 'http://fixture.r2.cloudflarestorage.com/file'}, {'url': 'https://example.com/file'},
    {'url': 'https://fixture.r2.cloudflarestorage.com.evil.invalid/file'},
    {'url': 'https://user:secret@fixture.r2.cloudflarestorage.com/file'},
    {'url': URL, 'headers': {'Authorization': 'Bearer never-forward'}},
])
def test_transfer_cannot_forward_control_credentials_or_leave_r2(transfer):
    with pytest.raises(NodeFailure, match='DOCUMENT_TRANSFER_INVALID'):
        ObjectTransfer.target(transfer)


def test_transfer_rejects_redirects_and_oversize_without_retaining_partial_file(tmp_path):
    for response, code in [(httpx.Response(302, headers={'location': 'https://private.invalid'}), 'DOCUMENT_TRANSFER_FAILED'),
                           (httpx.Response(200, content=b'oversized'), 'INPUT_INVALID')]:
        objects = ObjectTransfer(transport=httpx.MockTransport(lambda _, response=response: response))
        try:
            with pytest.raises(NodeFailure, match=code):
                objects.download_to_file(reference(), {'url': URL}, tmp_path / 'source.bin')
            assert not (tmp_path / 'source.bin').exists()
        finally:
            objects.close()


def test_stream_download_never_overwrites_existing_source_and_cancel_cleans_partial(tmp_path):
    path = tmp_path / 'source.bin'
    path.write_bytes(b'owned')
    objects = ObjectTransfer(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b'png')))
    try:
        with pytest.raises(FileExistsError):
            objects.download_to_file(reference(), {'url': URL}, path)
        assert path.read_bytes() == b'owned'
        calls = []
        def check():
            calls.append(True)
            if len(calls) > 1:
                raise NodeFailure('LEASE_STOPPED')
        with pytest.raises(NodeFailure, match='LEASE_STOPPED'):
            objects.download_to_file(reference(), {'url': URL}, tmp_path / 'partial', check)
        assert not (tmp_path / 'partial').exists()
    finally:
        objects.close()


def test_document_claim_receipt_replays_before_new_admission(agent):
    agent.config['document_slots'] = 1
    calls = []
    def post(_, body):
        calls.append(dict(body))
        if len(calls) == 1:
            raise ControlFailure('CONTROL_UNAVAILABLE')
        server, _ = clock()
        return {'request_id': body['request_id'], 'server_time': server, 'leases': []}
    agent.transport.document_post = post
    with pytest.raises(ControlFailure):
        agent.documents.claim()
    agent.config['enabled'] = False
    assert not agent.documents.claim()
    assert calls[0] == calls[1] and calls[0]['count'] == 1
    assert agent.journal.get('document-claim') is None


def test_document_admission_and_json_residency_share_classic_budget(agent):
    agent.config.update(document_slots=1, execution_slots=2)
    add_page(agent).step = 'text'
    page = add_document(agent)
    assert agent.claim_capacity() == agent.documents.capacity() == 0
    base = agent.pipeline.input_reservation(page)
    page.lease['analysis_ref'] = reference(byte_size=5000)
    assert agent.pipeline.input_reservation(page) == base + 5000 * 4
    agent.pipeline.limit = base - 1
    agent.documents.tick()
    assert page.completion['error'] == 'INPUT_MEMORY_EXCEEDED'


def test_document_gpu_work_cannot_bypass_interactive_compute_pool(agent):
    pending_pools(agent)
    agent.local['local_pages'] = 1
    classic = add_page(agent)
    classic.step, classic.future = 'analyze', Future()
    page = add_document(agent)
    page.step = 'analyze'
    agent.documents.tick()
    assert page.future is None and agent.pipeline.compute.calls == []
    classic.future, classic.step = None, 'text'
    agent.documents.tick()
    assert page.future is agent.pipeline.compute.calls[0][0]


@pytest.mark.parametrize('prepared', [False, True])
def test_document_inpaint_replaces_raw_masks_with_accounted_render_masks(agent, prepared):
    pending_pools(agent)
    page = add_document(agent, action='doc_render')
    agent.documents.tick()
    reserved = page.reserved
    assert page.mask_reserved == 10 * 10 * 6
    agent.pipeline.download.finish(response={'input': b'png', 'analysis': analysis_for(page)})
    agent.documents.advance(page)
    assert page.step == 'inpaint'
    page.masks = {name: np.zeros((10, 10), dtype=np.uint8) for name in ('mask', 'raw_mask', 'bubble_mask')}
    if prepared:
        page.masks.update(bubble_inset=np.zeros((10, 10), dtype=np.uint8),
                          bubble_labels=np.zeros((10, 10), dtype=np.int32),
                          bubble_stats=np.zeros((2, 5), dtype=np.int32))
    page.future = Future()
    page.future.set_result(np.zeros((10, 10, 3), dtype=np.uint8))
    agent.documents.advance(page)
    assert page.step == 'render'
    assert set(page.masks) == ({'bubble_inset', 'bubble_labels', 'bubble_stats'} if prepared else {'bubble_mask'})
    retained = sum(mask.nbytes for mask in page.masks.values())
    assert page.mask_reserved == retained <= 10 * 10 * 6
    assert page.reserved == agent.pipeline.used == reserved - 10 * 10 * 6 + retained
    agent.pipeline.release(page)
    assert not page.masks and page.mask_reserved == page.reserved == agent.pipeline.used == 0


def test_ocr_checkpoint_persists_locally_and_releases_buffers_before_llm(agent):
    pending_pools(agent)
    page = add_document(agent)
    workspace = local_workspace(agent, page)
    page.step, page.future = 'analyze', Future()
    page.data, page.rgb = b'png', np.zeros((10, 10, 3), dtype=np.uint8)
    page.future.set_result(analysis_for(page))
    agent.documents.advance(page)
    assert page.step == 'persist'
    agent.documents.freeze(page, agent.documents.persist(page))
    assert page.step == 'deliver' and page.data is page.rgb is page.analysis is None
    saved = agent.journal.get(PREFIX + 'document')
    assert URL not in json.dumps(saved) and agent.journal.output(PREFIX + 'document') is None
    assert set(saved['completion']) == {'analysis_ref', 'text', 'no_text', 'quality_flags', 'lease_token', 'workspace_generation'}
    assert (workspace.path / 'analysis' / '0001.json').is_file()
    assert workspace.checkpoint(1, 'doc_ocr')['text'] == saved['completion']['text']
    page.future = Future()
    page.future.set_result({'status': 'terminal', 'outcome': 'succeeded'})
    agent.documents.tick()
    assert not agent.documents.pages and agent.pipeline.used == 0
    assert agent.journal.get(PREFIX + 'document') is None and workspace.path.exists()
    assert agent.pipeline.compute.calls == []


def test_intermediate_ocr_render_download_and_delivery_never_call_r2(agent):
    page = add_document(agent)
    workspace = local_workspace(agent, page)
    agent.documents.objects.download_to_file = lambda *_: pytest.fail('Intermediate GET')
    agent.documents.objects.upload_file = lambda *_: pytest.fail('Intermediate PUT')
    assert agent.documents.download(page)['input'] == workspace.input(1)
    page.analysis = analysis_for(page)
    agent.documents.freeze(page, agent.documents.persist(page))
    paths = []
    agent.transport.document_post = lambda path, body: (paths.append(path), {'status': 'terminal'})[1]
    assert agent.documents.deliver(page)['status'] == 'terminal'
    render = add_document(agent, 'render', action='doc_render')
    render.document_workspace = workspace
    render.lease.update(input=page.lease['input'], analysis_ref=page.completion['analysis_ref'])
    fetched = agent.documents.download(render)
    render.analysis = fetched['analysis']
    data = image_bytes('red')
    render.rendered = {'output_bytes': data, 'result': {'output': reference(data)}}
    agent.documents.freeze(render, agent.documents.persist(render))
    assert agent.documents.deliver(render)['status'] == 'terminal'
    assert paths == ['/leases/document/complete', '/leases/render/complete']
    assert agent.journal.output(PREFIX + 'render') is None


def test_freeze_does_not_rehash_or_store_page_binary(agent, monkeypatch):
    page = add_document(agent, action='doc_render')
    output = reference()
    with monkeypatch.context() as patch:
        patch.setattr('classic_node.document_workspace.hashlib.sha256', lambda *_: pytest.fail('Metadata only freeze'))
        agent.documents.freeze(page, {'output_ref': output, 'quality_flags': []})
    assert page.completion['output_ref'] == output and agent.journal.output(PREFIX + 'document') is None


@pytest.mark.parametrize('changed', [{'byte_size': 4}, {'mime': 'image/webp'}, {'width': 11},
                                    {'height': 11}, {'sha256': 'not-a-digest'}])
def test_encoder_metadata_must_match_local_output_before_checkpoint(agent, changed):
    page = add_document(agent, action='doc_render')
    workspace = local_workspace(agent, page)
    page.analysis = analysis_for(page)
    data = image_bytes('red')
    page.rendered = {'output_bytes': data, 'result': {'output': reference(data, **changed)}}
    with pytest.raises(DocumentFileError):
        agent.documents.persist(page)
    assert workspace.checkpoint(1, 'doc_render') is None and agent.journal.output(PREFIX + 'document') is None


def test_timings_restore_without_wire_expansion_or_private_logs(agent, caplog):
    page = add_document(agent)
    page.timings.update(download=2.5, render=1.5, render_layout='private OCR text', complete=float('inf'), secret_url=URL)
    freeze_ocr(agent, page)
    saved = agent.journal.get(PREFIX + 'document')
    assert saved['timings'] == {'download': 2.5, 'render': 1.5}
    assert 'timings' not in saved['completion'] and URL not in json.dumps(saved)
    agent.pipeline.release(page)
    del agent.documents.pages['document']
    restored = add_document(agent)
    assert restored.timings == saved['timings'] and restored.step == 'deliver'
    with caplog.at_level(logging.INFO, logger='classic-node'):
        agent.documents.log_timings(restored, 'restored')
    assert '"download":2.5' in caplog.text
    assert 'private' not in caplog.text and 'secret_url' not in caplog.text and 'Signature' not in caplog.text


def test_final_zip_delivery_records_sign_put_complete_retries_without_wire_metrics(agent, caplog):
    page = frozen_zip(agent)
    page.timings.update(download=1.5, analyze=2.)
    agent.documents.freeze(page, {key: value for key, value in page.completion.items()
                                  if key not in ('lease_token', 'workspace_generation')})
    put_count, complete_count = [], []
    def post(path, body):
        assert 'timings' not in body
        if path.endswith('/uploads'):
            return {'uploads': {'output': {'url': URL}}}
        complete_count.append(True)
        if len(complete_count) == 1:
            raise ControlFailure('CONTROL_UNAVAILABLE')
        return {'status': 'terminal', 'outcome': 'succeeded'}
    def upload(ref, transfer, path, check):
        assert Path(path).name == 'result.zip' and Path(path).is_file()
        put_count.append(True)
        if len(put_count) == 1:
            raise ControlFailure('DOCUMENT_TRANSFER_FAILED', 503)
    agent.transport.document_post, agent.documents.objects.upload_file = post, upload
    with caplog.at_level(logging.INFO, logger='classic-node'):
        result = agent.documents.deliver(page)
        page.future = Future()
        page.future.set_result(result)
        agent.documents.advance(page)
    assert page.timings['upload_sign_attempts'] == page.timings['upload_put_attempts'] == 2
    assert page.timings['upload_retries'] == page.timings['complete_retries'] == 1
    assert page.timings['complete_attempts'] == 2
    assert agent.journal.get(PREFIX + 'document')['timings'] == {'download': 1.5, 'analyze': 2.}
    assert 'stage=uploaded' in caplog.text and 'stage=deliver' in caplog.text
    assert 'cloudflarestorage' not in caplog.text and 'isolated/' not in caplog.text
    assert 'lease_token' not in caplog.text and 'Signature' not in caplog.text


def test_successful_zip_put_is_not_repeated_after_restart_or_lost_completion(agent):
    page = frozen_zip(agent)
    puts, calls = [], []
    def post(path, body):
        calls.append(path)
        if path.endswith('/uploads'):
            return {'uploads': {'output': {'url': URL}}}
        return {'status': 'terminal'}
    agent.transport.document_post = post
    agent.documents.objects.upload_file = lambda *_: puts.append(True)
    assert agent.documents.deliver(page)['status'] == 'terminal'
    lease = dict(page.lease)
    agent.pipeline.release(page)
    del agent.documents.pages['document']
    server, _ = clock()
    agent.documents.adopt(lease, server, time.monotonic())
    restored = agent.documents.pages['document']
    assert restored.step == 'deliver' and agent.journal.output(PREFIX + 'document') is None
    assert agent.documents.deliver(restored)['status'] == 'terminal'
    assert len(puts) == 1 and calls.count('/leases/document/uploads') == 1
    assert calls.count('/leases/document/complete') == 2


def test_failed_adoption_journal_write_does_not_leak_resident_reservation(agent, monkeypatch):
    page = add_document(agent)
    freeze_ocr(agent, page)
    lease = dict(page.lease)
    agent.pipeline.release(page)
    del agent.documents.pages['document']
    server, _ = clock()

    def unavailable(*_):
        raise OSError('journal unavailable')

    monkeypatch.setattr(agent.journal, 'put', unavailable)
    with pytest.raises(OSError, match='journal unavailable'):
        agent.documents.adopt(lease, server, time.monotonic())
    assert 'document' not in agent.documents.pages and agent.pipeline.used == 0


def test_nonterminal_delivery_keeps_timings_without_binary_or_recomputation(agent):
    page = add_document(agent)
    page.timings['analyze'] = 1.25
    freeze_ocr(agent, page)
    page.timings.update(complete=.75, complete_attempts=2, complete_retries=1)
    page.future = Future()
    page.future.set_exception(ControlFailure('CONTROL_UNAVAILABLE', 503))
    agent.documents.advance(page)
    saved = agent.journal.get(PREFIX + 'document')
    assert saved['timings'] == pytest.approx(page.timings, abs=1e-6)
    assert agent.journal.output(PREFIX + 'document') is None
    agent.pipeline.release(page)
    del agent.documents.pages['document']
    restored = add_document(agent)
    assert restored.step == 'deliver' and restored.timings == saved['timings']


def test_second_forbidden_final_upload_is_definitive(agent):
    page = frozen_zip(agent)
    paths = []
    agent.transport.document_post = lambda path, body: (paths.append(path), {'uploads': {'output': {'url': URL}}})[1]
    def upload(*_):
        raise ControlFailure('DOCUMENT_TRANSFER_FAILED', 403)
    agent.documents.objects.upload_file = upload
    with pytest.raises(ControlFailure) as failure:
        agent.documents.deliver(page)
    assert failure.value.status == 403 and paths == ['/leases/document/uploads'] * 2
    assert page.timings['upload_retries'] == 1


@pytest.mark.parametrize('same_size', [False, True])
def test_recovered_final_zip_is_verified_before_upload(agent, same_size):
    page = frozen_zip(agent)
    path = page.document_workspace.path / 'result.zip'
    data = bytearray(path.read_bytes())
    data[-1] ^= 1
    path.write_bytes(data if same_size else b'bad')
    agent.transport.document_post = lambda *_: {'uploads': {'output': {'url': URL}}}
    agent.documents.objects.close()
    agent.documents.objects = ObjectTransfer(transport=httpx.MockTransport(lambda _: pytest.fail('Corrupt ZIP must not PUT')))
    with pytest.raises(NodeFailure, match='INPUT_HASH_MISMATCH'):
        agent.documents.deliver(page)


@pytest.mark.parametrize('step,code', [('analyze', 'CLASSIC_ANALYZE_FAILED'), ('inpaint', 'CLASSIC_INPAINT_FAILED'),
    ('render', 'CLASSIC_RENDER_FAILED'), ('prepare', 'DOCUMENT_INVALID_FILE'), ('package', 'DOCUMENT_PACKAGE_FAILED')])
def test_unexpected_page_failure_isolated_and_never_logs_private_error_body(agent, caplog, step, code):
    pending_pools(agent)
    failed, other = add_document(agent, 'failed'), add_document(agent, 'other')
    failed.step, failed.future = step, Future()
    failed.future.set_exception(RuntimeError('private OCR text and ' + URL))
    other.step = 'analyze'
    agent.network_log.failed = lambda *_: pytest.fail('Raw exceptions must not reach NetworkLog')
    with caplog.at_level(logging.ERROR, logger='classic-node'):
        agent.documents.tick()
    assert failed.completion['error'] == code and failed.step == 'deliver'
    assert other.future is not None and len(agent.pipeline.compute.calls) == 1
    assert 'event=page_failed' in caplog.text and f'code={code}' in caplog.text
    assert 'RuntimeError' in caplog.text and 'private' not in caplog.text and 'Signature' not in caplog.text


def test_zip_terminal_upload_receipt_does_not_put_again(agent):
    page = frozen_zip(agent)
    paths = []
    agent.transport.document_post = lambda path, body: (paths.append(path),
        {'receipt': {'status': 'terminal', 'outcome': 'succeeded'}})[1]
    agent.documents.objects.upload_file = lambda *_: pytest.fail('Already accepted')
    assert agent.documents.deliver(page)['status'] == 'terminal'
    assert paths == ['/leases/document/uploads']


def test_transient_delivery_preserves_checkpoint_but_definitive_rejection_freezes_error(agent):
    page = add_document(agent)
    freeze_ocr(agent, page)
    frozen = dict(page.completion)
    agent.documents.fail(page, ControlFailure('CONTROL_UNAVAILABLE', 503))
    assert page.completion == frozen and page.document_workspace.checkpoint(1, 'doc_ocr')
    agent.documents.fail(page, ControlFailure('DOCUMENT_ARTIFACT_INVALID', 422))
    assert page.completion['error'] == 'DOCUMENT_ARTIFACT_INVALID'
    assert agent.journal.output(PREFIX + 'document') is None


def test_expired_page_drains_and_acknowledges_without_reusing_gpu(agent):
    pending_pools(agent)
    page = add_document(agent)
    page.deadline = time.monotonic() - 1
    agent.documents.tick()
    assert page.stopped and page.step == 'deliver'
    assert not agent.pipeline.download.calls and not agent.pipeline.compute.calls
    agent.pipeline.delivery.finish(response={'status': 'terminal', 'outcome': 'failed'})
    agent.documents.tick()
    assert not agent.documents.pages and agent.journal.leases(PREFIX) == {}


@pytest.mark.parametrize('action', ['doc_ocr', 'doc_render'])
def test_new_lease_replays_task_checkpoint_without_ocr_or_render_recomputation(agent, action):
    page = add_document(agent)
    freeze_ocr(agent, page)
    workspace = page.document_workspace
    if action == 'doc_render':
        page.lease['action'] = action
        page.analysis = analysis_for(page)
        data = image_bytes('red')
        page.rendered = {'output_bytes': data, 'result': {'output': reference(data)}}
        agent.documents.freeze(page, agent.documents.persist(page))
    expected = {key: value for key, value in page.completion.items() if key not in ('lease_token', 'workspace_generation')}
    agent.journal.remove(PREFIX + 'document')
    agent.pipeline.release(page)
    del agent.documents.pages['document']
    restored = add_document(agent, 'new-lease', action=action)
    restored.document_workspace = workspace
    restored.lease['input'] = page.lease['input']
    value = agent.documents.download(restored)
    assert value == {'completion': expected}
    restored.future = Future()
    restored.future.set_result(value)
    agent.documents.advance(restored)
    assert restored.step == 'deliver' and restored.completion['lease_token'] == 'token-new-lease'
    assert agent.journal.output(PREFIX + 'new-lease') is None


def test_concurrent_claim_and_sync_adopt_one_page_without_orphaning_work(agent, monkeypatch):
    from classic_node import agent as agent_module

    first_read, second_started, second_read = Event(), Event(), Event()
    reads, created = [], []
    original_get, original_put, original_page = agent.journal.get, agent.journal.put, agent_module.Page

    def get(key, default=None):
        if key == PREFIX + 'document':
            reads.append(key)
            if len(reads) == 1:
                first_read.set()
                assert second_started.wait(1)
                # Without serialization the second adopter enters this read
                # while the first still holds an unpublished Page snapshot.
                second_read.wait(.25)
            else:
                second_read.set()
        return original_get(key, default)

    def put(key, value):
        if key == PREFIX + 'document':
            # A scheduling tick must never observe a Page before its initial
            # journal write; that write could overwrite a fresh completion.
            assert 'document' not in agent.documents.pages
        return original_put(key, value)

    def page(*args):
        value = original_page(*args)
        value.future = Future()
        agent.pipeline.resize_reservation(value, 4096)
        created.append(value)
        return value

    def sync_adopt():
        second_started.set()
        return add_document(agent)

    monkeypatch.setattr(agent.journal, 'get', get)
    monkeypatch.setattr(agent.journal, 'put', put)
    monkeypatch.setattr(agent_module, 'Page', page)
    with ThreadPoolExecutor(2) as pool:
        claim = pool.submit(add_document, agent)
        assert first_read.wait(1)
        sync = pool.submit(sync_adopt)
        claimed, synced = claim.result(timeout=1), sync.result(timeout=1)
    assert reads == [PREFIX + 'document'] and created == [claimed]
    assert claimed is synced is agent.documents.pages['document']
    assert not claimed.future.done() and claimed.reserved == agent.pipeline.used == 4096


def test_workspace_cleanup_requires_authoritative_terminal_state_and_no_active_lease(agent):
    page = add_document(agent)
    workspace = local_workspace(agent, page)
    server, _ = clock()
    reply = {'server_time': server, 'leases': [], 'workspaces': []}
    agent.transport.document_post = lambda *_: reply
    agent.documents.sync()
    assert workspace.path.exists()
    reply['workspaces'] = [{'job_id': 'book', 'status': 'succeeded', 'workspace_generation': 1}]
    agent.documents.sync()
    assert workspace.path.exists()  # Active local work must drain first.
    agent.pipeline.release(page)
    del agent.documents.pages['document']
    agent.documents.sync()
    assert not workspace.path.exists()


def test_capability_probe_fails_closed_once_when_sandbox_is_unavailable(agent, monkeypatch, caplog):
    calls = []
    def unavailable(path, *, require_sandbox):
        calls.append(require_sandbox)
        raise DocumentFileError('DOCUMENT_SANDBOX_UNAVAILABLE')
    monkeypatch.setattr('comic_document_files.check_parser_sandbox', unavailable)
    with caplog.at_level(logging.WARNING, logger='classic-node'):
        assert agent.documents.protocol() is None
        assert agent.documents.protocol() is None
    assert calls == [True] and agent.documents.capacity() == 0
    assert 'DOCUMENT_PARSER_SANDBOX_UNAVAILABLE' in caplog.text


def test_document_decode_uses_existing_normalized_runtime_contract(agent):
    page = add_document(agent)
    local_workspace(agent, page)
    page.data = page.document_workspace.input(1)
    decoded = []
    def decode(data, metadata):
        assert metadata['normalization_version'] == 1
        decoded.append(metadata)
        return np.zeros((10, 10, 3), dtype=np.uint8), None
    agent.runtime.decode = decode
    agent.runtime.analyze = lambda rgb, sha: analysis_for(page)
    agent.runtime.restore_masks = lambda *args: None
    agent.runtime.inpaint = lambda rgb, analysis, **kwargs: rgb
    page.analysis = agent.documents.analyze(page)
    assert agent.documents.inpaint(page).shape == (10, 10, 3)
    assert len(decoded) == 2 and 'normalization_version' not in page.lease['input']


def test_document_render_uses_lease_page_limit_from_its_workspace(agent):
    pending_pools(agent)
    page = add_document(agent, action='doc_prepare')
    page.lease['file_limits'] = {'max_page_bytes': 4096}
    workspace = agent.documents.workspace(page)
    page.lease['action'], page.step = 'doc_render', 'render'
    page.rgb = page.cleaned = np.zeros((10, 10, 3), dtype=np.uint8)
    page.analysis, page.translations = analysis_for(page), page.lease['translations']
    calls = []
    agent.runtime.render = lambda *args, **kwargs: calls.append(kwargs)
    agent.documents.tick()
    agent.pipeline.render.finish()
    assert page.future.result() is None and len(calls) == 1
    assert calls[0]['full_image_max_bytes'] == workspace.limits.max_page_bytes == 4096


def test_full_host_affine_book_has_one_source_get_and_only_final_zip_put(agent):
    requests = []
    def handler(request):
        requests.append(request.method)
        assert 'authorization' not in request.headers
        if request.method == 'GET':
            return httpx.Response(200, content=source_bytes())
        assert request.method == 'PUT'
        with zipfile.ZipFile(BytesIO(request.read())) as archive:
            assert archive.namelist() == ['0001.png']
            assert archive.read('0001.png') == image_bytes('red')
        return httpx.Response(200)
    agent.documents.objects.close()
    agent.documents.objects = ObjectTransfer(transport=httpx.MockTransport(handler))
    control = []
    def post(path, body):
        control.append(path)
        if path.endswith('/uploads'):
            return {'uploads': {'output': {'url': URL, 'headers': {'Content-Length': str(body['output_ref']['byte_size'])}}}}
        assert path.endswith('/complete')
        return {'status': 'terminal'}
    agent.transport.document_post = post
    prepare = add_document(agent, 'prepare', action='doc_prepare')
    workspace = local_workspace(agent, prepare, prepared=False)
    prepared = agent.documents.prepare(prepare)
    agent.documents.freeze(prepare, prepared)
    agent.documents.deliver(prepare)
    ocr = add_document(agent, 'ocr')
    ocr.document_workspace = workspace
    ocr.lease['input'] = prepared['pages'][0]['input_ref']
    assert agent.documents.download(ocr)['input'] == workspace.input(1)
    ocr.analysis = analysis_for(ocr)
    agent.documents.freeze(ocr, agent.documents.persist(ocr))
    agent.documents.deliver(ocr)
    render = add_document(agent, 'render', action='doc_render')
    render.document_workspace = workspace
    render.lease.update(input=ocr.lease['input'], analysis_ref=ocr.completion['analysis_ref'])
    render.analysis = agent.documents.download(render)['analysis']
    data = image_bytes('red')
    render.rendered = {'output_bytes': data, 'result': {'output': reference(data)}}
    agent.documents.freeze(render, agent.documents.persist(render))
    agent.documents.deliver(render)
    zipped = add_document(agent, 'zip', action='doc_zip')
    zipped.document_workspace = workspace
    zipped.lease['pages'] = [{'page_index': 1, 'output_ref': render.completion['output_ref']}]
    agent.documents.freeze(zipped, agent.documents.package(zipped))
    assert agent.documents.deliver(zipped)['status'] == 'terminal'
    assert requests == ['GET', 'PUT']
    assert [path for path in control if path.endswith('/uploads')] == ['/leases/zip/uploads']
    assert agent.journal.db.execute('SELECT COUNT(*) FROM outputs').fetchone()[0] == 0
    assert workspace.path.exists()  # Stage receipts never authorize early deletion.


@pytest.mark.parametrize('opacity', [None, 90, 0])
def test_document_output_encodes_original_full_image_pixels_with_long_translation(opacity):
    runtime, data, metadata, analysis, translated = runtime_fixture(opacity)
    rgb, alpha = runtime.decode(data, metadata)
    cleaned = rgb.copy()
    cleaned[2, 3] = (1, 2, 3)
    translated['translations']['0'] = 'Long document translation ' * 200
    result = runtime.render(rgb, cleaned, analysis, translated, 'en', alpha,
                            full_image_max_bytes=FileLimits().max_page_bytes)
    assert result['result']['representation'] == 'full-image'
    with Image.open(BytesIO(result['output_bytes'])) as image:
        assert image.format == 'PNG' and image.size == (80, 64)
        assert np.array_equal(np.asarray(image)[..., :3], cleaned)
        if opacity is not None:
            assert np.all(np.asarray(image)[..., 3] == opacity)


@pytest.mark.parametrize('execution', ['local', 'pool', 'fallback', 'empty'])
def test_document_png_budget_is_independent_from_overlay_budget(monkeypatch, execution):
    from classic_node import protocol
    from classic_node.render_pool import RenderMemoryError, render_page
    runtime, data, metadata, analysis, translated = runtime_fixture(90)
    rgb, alpha = runtime.decode(data, metadata)
    cleaned = rgb.copy()
    cleaned[2, 3] = (1, 2, 3)
    if execution == 'empty':
        translated['translations']['0'] = ''
    expected = runtime.render(rgb, cleaned, analysis, translated, 'en', alpha,
                              full_image_max_bytes=FileLimits().max_page_bytes)
    size = len(expected['output_bytes'])
    limits = []
    if execution in ('pool', 'fallback'):
        def render(*args, **kwargs):
            limits.append(kwargs.get('full_image_max_bytes'))
            if execution == 'fallback':
                raise RenderMemoryError()
            return render_page(runtime.engine.renderer, *args, **kwargs)
        runtime.render_pool = SimpleNamespace(render=render)
    monkeypatch.setattr(protocol, 'MAX_RESULT_BYTES', 1)
    try:
        assert runtime.render(rgb, cleaned, analysis, translated, 'en', alpha,
                              full_image_max_bytes=size) == expected
        with pytest.raises(NodeFailure, match='CLASSIC_OUTPUT_TOO_LARGE'):
            runtime.render(rgb, cleaned, analysis, translated, 'en', alpha,
                           full_image_max_bytes=size - 1)
        if execution in ('pool', 'fallback'):
            assert limits == [size, size - 1]
        with pytest.raises(NodeFailure, match='CLASSIC_OUTPUT_TOO_LARGE'):
            runtime.render(rgb, cleaned, analysis, translated, 'en', alpha)
        assert protocol.MAX_RESULT_BYTES == 1
    finally:
        alpha.close()


@pytest.mark.parametrize('limit', [0, -1, True, '128', None])
def test_document_png_requires_an_explicit_positive_page_budget(limit, monkeypatch):
    from classic_node.protocol import pack_full_image
    monkeypatch.setattr(Image, 'fromarray', lambda *_: pytest.fail('Reject before encoding'))
    with pytest.raises(NodeFailure, match='CLASSIC_OUTPUT_TOO_LARGE'):
        pack_full_image(np.zeros((2, 2, 3), dtype=np.uint8), None, max_bytes=limit)
