from dataclasses import replace
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import stat
import struct
from concurrent.futures import ThreadPoolExecutor
import zipfile

import pytest
from PIL import Image

from comic_document_files import DocumentFileError, FileLimits
from classic_node import document_workspace as workspaces
from classic_node.document_workspace import DocumentWorkspace, inventory
from classic_node.protocol import digest


def png(color='white', size=(32, 48)):
    stream = BytesIO()
    with Image.new('RGB', size, color) as image:
        image.save(stream, 'PNG')
    return stream.getvalue()


def source_bytes(count=2):
    stream = BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED) as archive:
        for index in range(1, count + 1):
            archive.writestr(zipfile.ZipInfo(f'{index}.png', date_time=(1980, 1, 1, 0, 0, 0)), png())
    return stream.getvalue()


def ref(data, mime='application/zip', **extra):
    return {'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data), 'mime': mime, **extra}


def download(data, calls=None):
    def write(descriptor, path, check):
        check()
        if calls is not None:
            calls.append(descriptor)
        with path.open('xb') as output:
            output.write(data)
    return write


def prepared(tmp_path, *, count=2, job_id='job-one', generation=1, limits=None):
    workspace = DocumentWorkspace(tmp_path, job_id, generation, owner_id='node-a', limits=limits,
                                  require_sandbox=False, create=True)
    data = source_bytes(count)
    rows = workspace.prepare(ref(data), 'zip', download(data))
    return workspace, rows


def save_ocr(workspace, row, *, text=True):
    analysis = {'version': 'fixture', 'format': 'fixture', 'input_hash': row['sha256'],
        'width': row['width'], 'height': row['height'], 'mask': None,
        'segments': [{'id': '0', 'source': '测试！'}] if text else [], 'regions': []}
    saved = workspace.save_analysis(row['page_index'], analysis)
    body = {'analysis_ref': saved, 'text': {'page_index': row['page_index'],
        'analysis_hash': digest(analysis), 'segments': analysis['segments']}, 'no_text': not text,
        'quality_flags': []}
    workspace.save_checkpoint(row['page_index'], 'doc_ocr', body)
    return analysis, saved, body


def save_render(workspace, row):
    data = png('red', (row['width'], row['height']))
    saved = workspace.save_output(row['page_index'], data,
        ref(data, 'image/png', width=row['width'], height=row['height']))
    body = {'output_ref': saved, 'quality_flags': []}
    workspace.save_checkpoint(row['page_index'], 'doc_render', body)
    return saved, body


def test_complete_book_survives_restart_and_only_source_is_downloaded(tmp_path, monkeypatch):
    workspace, rows = prepared(tmp_path)
    analysis, analysis_ref, ocr = save_ocr(workspace, rows[0])
    output_ref, render = save_render(workspace, rows[0])
    save_ocr(workspace, rows[1], text=False)
    assert analysis_ref['sha256'] == digest(analysis)
    assert set(analysis_ref) == {'sha256', 'byte_size', 'mime'}
    reopened = DocumentWorkspace(tmp_path, 'job-one', 1, owner_id='node-a', require_sandbox=False)
    assert reopened.analysis(1, analysis_ref) == analysis
    assert reopened.checkpoint(1, 'doc_ocr') == ocr
    assert reopened.checkpoint(1, 'doc_render') == render
    calls = []
    assert reopened.prepare(ref(source_bytes()), 'zip', download(source_bytes(), calls)) == rows
    assert calls == []
    pages = [{'page_index': 1, 'output_ref': output_ref}, {'page_index': 2, 'output_ref': rows[1]}]
    path, output = reopened.package(pages)
    with zipfile.ZipFile(path) as archive:
        assert archive.namelist() == ['0001.png', '0002.png']
        assert archive.testzip() is None
        assert archive.read('0002.png') == reopened.input(2, rows[1])
        assert all(info.compress_type == zipfile.ZIP_STORED for info in archive.infolist())
    assert not (workspace.path / 'output' / '0002.png').exists()
    assert output == ref(path.read_bytes())
    monkeypatch.setattr(workspaces, 'package_zip', lambda *args, **kwargs: pytest.fail('ZIP recomputed'))
    assert reopened.package(pages) == (path, output)
    assert inventory(tmp_path) == [{'job_id': 'job-one', 'workspace_generation': 1}]


def test_same_generation_cannot_change_source_or_owner(tmp_path):
    workspace, rows = prepared(tmp_path, count=1)
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
        workspace.prepare(ref(source_bytes(2)), 'zip', download(source_bytes(2)))
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
        DocumentWorkspace(tmp_path, 'job-one', 1, owner_id='another-node')
    assert workspace.input(1, rows[0])


@pytest.mark.parametrize('job_id', ['../other', '/absolute', 'a/b', 'a\\b', '.', 'NUL', 'a:stream', ''])
def test_workspace_identifiers_cannot_escape_private_root(tmp_path, job_id):
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
        DocumentWorkspace(tmp_path, job_id, 1, create=True)
    assert not (tmp_path / 'documents').exists()


@pytest.mark.parametrize('generation', [0, -1, True, '../other', 2 ** 31])
def test_generation_is_strict_and_bounded(tmp_path, generation):
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
        DocumentWorkspace(tmp_path, 'job', generation, create=True)


def test_missing_workspace_and_missing_page_are_not_empty_successes(tmp_path):
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISSING'):
        DocumentWorkspace(tmp_path, 'missing', 1)
    workspace, rows = prepared(tmp_path, count=1)
    (workspace.path / 'pages' / '0001.png').unlink()
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISSING'):
        workspace.input(1, rows[0])
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISSING'):
        workspace.prepare(ref(source_bytes(1)), 'zip', download(source_bytes(1)))


def test_incomplete_prepare_never_publishes_partial_pages_and_retry_reuses_source(tmp_path, monkeypatch):
    workspace = DocumentWorkspace(tmp_path, 'job', 1, create=True, require_sandbox=False)
    data, calls, original = source_bytes(), [], workspaces.run_file_operation
    def interrupted(action, source, kind, directory, **kwargs):
        (directory / '0001.png').write_bytes(png())
        raise DocumentFileError('DOCUMENT_PARSE_TIMEOUT')
    monkeypatch.setattr(workspaces, 'run_file_operation', interrupted)
    with pytest.raises(DocumentFileError, match='PARSE_TIMEOUT'):
        workspace.prepare(ref(data), 'zip', download(data, calls))
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISSING'):
        workspace.input(1)
    assert json.loads((workspace.path / 'manifest.json').read_text())['prepared'] is False
    monkeypatch.setattr(workspaces, 'run_file_operation', original)
    rows = workspace.prepare(ref(data), 'zip', download(data, calls))
    assert len(rows) == 2 and len(calls) == 1


def test_download_interruption_and_hash_mismatch_are_not_adopted(tmp_path):
    workspace = DocumentWorkspace(tmp_path, 'job', 1, create=True, require_sandbox=False)
    data = source_bytes(1)
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
        workspace.prepare(ref(data), 'zip', download(b'wrong'))
    assert not (workspace.path / 'source.bin').exists()
    assert len(workspace.prepare(ref(data), 'zip', download(data))) == 1


def test_deadline_is_checked_before_download_and_packaging(tmp_path):
    def stop():
        raise RuntimeError('deadline')
    workspace = DocumentWorkspace(tmp_path, 'job', 1, create=True, require_sandbox=False)
    calls = []
    with pytest.raises(RuntimeError, match='deadline'):
        workspace.prepare(ref(source_bytes(1)), 'zip', download(source_bytes(1), calls), check=stop)
    assert not calls
    with pytest.raises(RuntimeError, match='deadline'):
        workspace.package(check=stop)


def test_input_ref_hash_dimensions_and_disk_corruption_are_checked(tmp_path):
    workspace, rows = prepared(tmp_path, count=1)
    for changed in ({'sha256': '0' * 64}, {'width': 1}, {'height': 2}, {'byte_size': 3}, {'mime': 'image/jpeg'}):
        with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
            workspace.input(1, {**rows[0], **changed})
    path = workspace.path / 'pages' / '0001.png'
    data = bytearray(path.read_bytes())
    data[-1] ^= 1
    path.write_bytes(data)
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
        workspace.input(1, rows[0])


def test_analysis_checkpoint_hash_is_exact_shared_canonical_digest(tmp_path):
    workspace, rows = prepared(tmp_path, count=1)
    analysis, saved, body = save_ocr(workspace, rows[0])
    reordered = dict(reversed(list(analysis.items())))
    assert saved == workspace.save_analysis(1, reordered)
    assert saved['sha256'] == digest(analysis)
    assert workspace.analysis(1, saved) == reordered
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
        workspace.save_analysis(1, {**analysis, 'input_hash': '0' * 64})
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
        workspace.analysis(1, {**saved, 'sha256': '0' * 64})
    assert workspace.checkpoint(1, 'doc_ocr') == body


@pytest.mark.parametrize('changed', [{'width': 1}, {'height': 1}, {'byte_size': 1},
    {'sha256': 'invalid'}, {'mime': 'image/jpeg'}])
def test_render_metadata_cannot_mislabel_bytes(tmp_path, changed):
    workspace, rows = prepared(tmp_path, count=1)
    data = png('red')
    output = ref(data, 'image/png', width=32, height=48)
    with pytest.raises(DocumentFileError):
        workspace.save_output(1, data, {**output, **changed})
    assert not (workspace.path / 'output' / '0001.png').exists()


def test_checkpoint_rejects_credentials_partial_results_and_cross_page_binding(tmp_path):
    workspace, rows = prepared(tmp_path, count=1)
    analysis = {'input_hash': rows[0]['sha256'], 'width': 32, 'height': 48, 'segments': []}
    saved = workspace.save_analysis(1, analysis)
    body = {'analysis_ref': saved, 'text': {'page_index': 1, 'analysis_hash': digest(analysis), 'segments': []},
            'no_text': True}
    for broken in ({}, {**body, 'lease_token': 'private'}, {**body, 'url': 'private'},
                   {**body, 'text': {**body['text'], 'page_index': 2}},
                   {**body, 'text': {**body['text'], 'analysis_hash': '0' * 64}},
                   {**body, 'text': {**body['text'], 'segments': [{'id': '1', 'source': 'different'}]}, 'no_text': False}):
        with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
            workspace.save_checkpoint(1, 'doc_ocr', broken)
    assert workspace.checkpoint(1, 'doc_ocr') is None
    workspace.save_checkpoint(1, 'doc_ocr', body)
    assert workspace.checkpoint(1, 'doc_ocr') == body


def test_package_refuses_unfinished_pages_and_keeps_all_page_order(tmp_path):
    workspace, rows = prepared(tmp_path)
    with pytest.raises(DocumentFileError, match='INCOMPLETE_PAGES'):
        workspace.package([{'page_index': 1, 'output_ref': rows[0]}])
    with pytest.raises(DocumentFileError, match='INCOMPLETE_PAGES'):
        workspace.package([{'page_index': i + 1, 'output_ref': row} for i, row in enumerate(rows)])
    output, _ = save_render(workspace, rows[0])
    save_ocr(workspace, rows[1], text=False)
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
        workspace.package([{'page_index': 1, 'output_ref': {**output, 'sha256': '0' * 64}},
                           {'page_index': 2, 'output_ref': rows[1]}])
    assert not (workspace.path / 'result.zip').exists()


def test_manifest_atomic_replace_failure_cannot_publish_partial_analysis(tmp_path, monkeypatch):
    workspace, rows = prepared(tmp_path, count=1)
    original, called = workspaces.os.replace, []
    def fail_manifest(source, destination):
        if Path(destination).name == 'manifest.json':
            called.append(True)
            raise OSError('simulated disk failure')
        return original(source, destination)
    monkeypatch.setattr(workspaces.os, 'replace', fail_manifest)
    with pytest.raises(OSError, match='disk failure'):
        save_ocr(workspace, rows[0])
    assert called
    assert workspace.checkpoint(1, 'doc_ocr') is None
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISSING'):
        workspace.analysis(1)
    assert not (workspace.path / 'manifest.json.part').exists()
    monkeypatch.setattr(workspaces.os, 'replace', original)
    save_ocr(workspace, rows[0])
    assert workspace.checkpoint(1, 'doc_ocr')


def test_spool_budget_is_shared_across_tasks_and_counts_atomic_temporaries(tmp_path):
    limits = replace(FileLimits(), max_spool_bytes=1000)
    first = DocumentWorkspace(tmp_path, 'first', 1, limits=limits, create=True)
    second = DocumentWorkspace(tmp_path, 'second', 1, limits=limits, create=True)
    assert first._spool is second._spool
    first._atomic('source.bin', b'a' * 500)
    with pytest.raises(DocumentFileError, match='SPOOL_BUDGET'):
        second._atomic('source.bin', b'b' * 500)
    with pytest.raises(DocumentFileError, match='SPOOL_BUDGET'):
        first._atomic('source.bin', b'a' * 600)
    assert (first.path / 'source.bin').read_bytes() == b'a' * 500
    assert not (second.path / 'source.bin').exists()


def test_spool_budget_recounts_uncommitted_files_after_restart(tmp_path):
    limits = replace(FileLimits(), max_spool_bytes=2000)
    first = DocumentWorkspace(tmp_path, 'first', 1, limits=limits, create=True)
    (first.path / 'source.bin.part').write_bytes(b'x' * 1000)
    workspaces._ROOTS.pop(tmp_path / 'documents')
    second = DocumentWorkspace(tmp_path, 'second', 1, limits=limits, create=True)
    with pytest.raises(DocumentFileError, match='SPOOL_BUDGET'):
        second._atomic('source.bin', b'x' * 1000)


def test_concurrent_workspaces_share_one_budget_admission(tmp_path):
    limits = replace(FileLimits(), max_spool_bytes=1700)
    first = DocumentWorkspace(tmp_path, 'first', 1, limits=limits, create=True)
    second = DocumentWorkspace(tmp_path, 'second', 1, limits=limits, create=True)
    def write(workspace):
        try:
            with workspace._spool.lock:
                workspace._atomic('source.bin', b'x' * 1000)
            return True
        except DocumentFileError:
            return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(write, (first, second))) == [False, True]


def test_prepare_parser_budget_subtracts_other_workspaces(tmp_path, monkeypatch):
    limits = replace(FileLimits(), max_spool_bytes=3 * 1024 * 1024)
    first = DocumentWorkspace(tmp_path, 'first', 1, limits=limits, require_sandbox=False, create=True)
    second = DocumentWorkspace(tmp_path, 'second', 1, limits=limits, require_sandbox=False, create=True)
    first._atomic('source.bin', b'x' * 300_000)
    captured, original = [], workspaces.run_file_operation
    def operation(*args, **kwargs):
        captured.append(kwargs['limits'].max_spool_bytes)
        return original(*args, **kwargs)
    monkeypatch.setattr(workspaces, 'run_file_operation', operation)
    data = source_bytes(1)
    second.prepare(ref(data), 'zip', download(data))
    assert captured[0] < limits.max_spool_bytes - 300_000


def test_cleanup_is_exact_generation_and_never_a_page_receipt(tmp_path):
    first, rows = prepared(tmp_path, count=1)
    second, _ = prepared(tmp_path, count=1, generation=2)
    other, _ = prepared(tmp_path, count=1, job_id='other-job')
    save_ocr(first, rows[0], text=False)
    assert first.path.exists()
    first.cleanup()
    assert not first.path.exists() and second.path.exists() and other.path.exists()
    assert sorted(row['workspace_generation'] for row in inventory(tmp_path)) == [1, 2]


def test_generation_limit_and_reparse_points_fail_closed(tmp_path, monkeypatch):
    DocumentWorkspace(tmp_path, 'job', 1, create=True)
    monkeypatch.setattr(workspaces, 'MAX_WORKSPACES', 1)
    with pytest.raises(DocumentFileError, match='WORKSPACE_BUDGET'):
        DocumentWorkspace(tmp_path, 'other', 1, create=True)
    fake = type('Info', (), {'st_mode': stat.S_IFDIR, 'st_file_attributes': stat.FILE_ATTRIBUTE_REPARSE_POINT})()
    monkeypatch.setattr(Path, 'lstat', lambda self: fake)
    with pytest.raises(DocumentFileError, match='WORKSPACE_UNSAFE'):
        inventory(tmp_path)


def test_links_cannot_escape_workspace_or_authorized_cleanup(tmp_path):
    workspace, rows = prepared(tmp_path, count=1)
    outside = tmp_path / 'outside.png'
    outside.write_bytes(png())
    target = workspace.path / 'pages' / '0001.png'
    target.unlink()
    try:
        target.symlink_to(outside)
    except OSError:
        pytest.skip('Host does not allow test symlink creation')
    with pytest.raises(DocumentFileError, match='WORKSPACE_UNSAFE'):
        workspace.input(1, rows[0])
    with pytest.raises(DocumentFileError, match='WORKSPACE_UNSAFE'):
        workspace.cleanup()
    assert outside.read_bytes() == png()


def test_hardlinks_are_rejected_before_reads_or_cleanup(tmp_path):
    workspace, rows = prepared(tmp_path, count=1)
    outside = tmp_path / 'outside.png'
    outside.write_bytes(png())
    target = workspace.path / 'pages' / '0001.png'
    target.unlink()
    os.link(outside, target)
    with pytest.raises(DocumentFileError, match='WORKSPACE_UNSAFE'):
        workspace.input(1, rows[0])
    with pytest.raises(DocumentFileError, match='WORKSPACE_UNSAFE'):
        workspace.cleanup()
    assert outside.exists()


def test_production_sandbox_is_required_and_never_falls_back(tmp_path, monkeypatch):
    import comic_document_files
    monkeypatch.setattr(comic_document_files.shutil, 'which', lambda _: None)
    workspace = DocumentWorkspace(tmp_path, 'job', 1, create=True)
    data = source_bytes(1)
    with pytest.raises(DocumentFileError, match='SANDBOX_UNAVAILABLE'):
        workspace.prepare(ref(data), 'zip', download(data))
    assert json.loads((workspace.path / 'manifest.json').read_text())['prepared'] is False
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISSING'):
        workspace.input(1)


def test_fresh_render_reuses_encoder_digest_and_checkpoint_does_not_read_png(tmp_path, monkeypatch):
    workspace, rows = prepared(tmp_path, count=1)
    data = png('red')
    output = ref(data, 'image/png', width=32, height=48)
    original, reads = Path.open, []
    def opened(path, *args, **kwargs):
        if path.suffix == '.png' and (args[0] if args else kwargs.get('mode', 'r')) == 'rb':
            reads.append(path)
        return original(path, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(workspaces.hashlib, 'sha256', lambda *_: pytest.fail('Do not rehash fresh encoder bytes'))
        saved = workspace.save_output(1, data, output)
    monkeypatch.setattr(Path, 'open', opened)
    workspace.save_checkpoint(1, 'doc_render', {'output_ref': saved})
    assert reads == []
    workspace.checkpoint(1, 'doc_render')
    assert reads == [workspace.path / 'output' / '0001.png']


def test_packaging_reads_each_output_once_and_cached_result_reads_no_output_or_zip(tmp_path, monkeypatch):
    workspace, rows = prepared(tmp_path)
    first, _ = save_render(workspace, rows[0])
    second, _ = save_render(workspace, rows[1])
    original, reads = Path.open, []
    def opened(path, *args, **kwargs):
        if path.suffix in ('.png', '.zip') and (args[0] if args else kwargs.get('mode', 'r')) == 'rb':
            reads.append(path)
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', opened)
    pages = [{'page_index': 1, 'output_ref': first}, {'page_index': 2, 'output_ref': second}]
    path, saved = workspace.package(pages)
    assert [file.name for file in reads] == ['0001.png', '0002.png']
    reads.clear()
    assert workspace.package(pages) == (path, saved)
    assert reads == []


def test_same_size_output_corruption_is_rejected_by_resume_and_zip_stream(tmp_path):
    workspace, rows = prepared(tmp_path, count=1)
    output, _ = save_render(workspace, rows[0])
    target = workspace.path / 'output' / '0001.png'
    data = bytearray(target.read_bytes())
    data[-1] ^= 1
    target.write_bytes(data)
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISMATCH'):
        workspace.checkpoint(1, 'doc_render')
    with pytest.raises(DocumentFileError, match='OUTPUT_MISMATCH'):
        workspace.package([{'page_index': 1, 'output_ref': output}])
    assert not (workspace.path / 'result.zip').exists()


def test_authorized_cleanup_recovers_orphan_and_releases_over_budget_spool(tmp_path):
    workspace = DocumentWorkspace(tmp_path, 'job', 1, create=True)
    (workspace.path / 'manifest.json').unlink()
    (workspace.path / 'source.bin.part').write_bytes(b'x' * 3000)
    workspaces._ROOTS.pop(tmp_path / 'documents')
    orphan = DocumentWorkspace(tmp_path, 'job', 1, limits=replace(FileLimits(), max_spool_bytes=1024))
    with pytest.raises(DocumentFileError, match='WORKSPACE_MISSING'):
        orphan.input(1)
    orphan.cleanup()
    orphan.cleanup()
    assert inventory(tmp_path) == []
