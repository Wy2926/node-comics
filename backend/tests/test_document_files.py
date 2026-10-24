from dataclasses import replace
from io import BytesIO
import hashlib
import json
from pathlib import Path
import stat
import struct
import zipfile

import pytest
from PIL import Image

from app.documents.files import (DocumentFileError, FileLimits, normalize_pages, package_zip,
                                  run_file_operation, scan_source)


def png(size=(64, 96)):
    stream = BytesIO()
    Image.new('RGB', size, 'white').save(stream, 'PNG')
    return stream.getvalue()


def archive(path, rows):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_STORED) as stream:
        for name, data in rows:
            stream.writestr(name, data)
    return path


def test_natural_page_order_and_streamed_complete_zip(tmp_path):
    source = archive(tmp_path / 'source.zip', [('10.png', png()), ('2.png', png()), ('1.png', png()), ('readme.txt', b'metadata')])
    manifest = scan_source(source, 'zip')
    assert [entry['source_name'] for entry in manifest] == ['1.png', '2.png', '10.png']
    pages = list(normalize_pages(source, 'zip', tmp_path / 'pages', manifest=manifest))
    result = package_zip(pages, tmp_path / 'translated.zip')
    assert result['byte_size'] > sum(page['byte_size'] for page in pages)
    with zipfile.ZipFile(result['path']) as packed:
        assert packed.namelist() == ['0001.png', '0002.png', '0003.png']
        assert all(info.compress_type == zipfile.ZIP_STORED for info in packed.infolist())
        assert packed.testzip() is None


@pytest.mark.parametrize('unsafe', ['../page.png', '/page.png', 'C:/page.png', 'nested/../../page.png',
                                   'nested\\..\\page.png', 'name:stream.png'])
def test_archive_path_attacks_rejected_before_materialization(tmp_path, unsafe):
    source = archive(tmp_path / 'source.zip', [(unsafe, png())])
    with pytest.raises(DocumentFileError, match='DOCUMENT_UNSAFE_ARCHIVE_PATH'):
        scan_source(source, 'zip')
    assert not (tmp_path / 'page.png').exists()


def test_symlink_is_rejected(tmp_path):
    link = zipfile.ZipInfo('page.png')
    link.create_system, link.external_attr = 3, (stat.S_IFLNK | 0o777) << 16
    source = archive(tmp_path / 'source.zip', [(link, b'/private/secret')])
    with pytest.raises(DocumentFileError, match='DOCUMENT_UNSAFE_ARCHIVE_ENTRY'):
        scan_source(source, 'zip')


def test_duplicate_normalized_path_and_nested_archives_rejected(tmp_path):
    source = archive(tmp_path / 'source.zip', [('A.png', png()), ('a.png', png())])
    with pytest.raises(DocumentFileError, match='DOCUMENT_DUPLICATE_PAGE'):
        scan_source(source, 'zip')
    source = archive(tmp_path / 'nested.zip', [('page.png', png()), ('inner.zip', b'archive')])
    with pytest.raises(DocumentFileError, match='DOCUMENT_UNSUPPORTED_ENTRY'):
        scan_source(source, 'zip')


def test_201_pages_rejected_without_truncation(tmp_path):
    source = archive(tmp_path / 'source.zip', [(f'{index}.png', png()) for index in range(201)])
    with pytest.raises(DocumentFileError, match='DOCUMENT_PAGE_LIMIT'):
        scan_source(source, 'zip')


def test_encryption_flag_rejected(tmp_path):
    source = archive(tmp_path / 'source.zip', [('page.png', png())])
    data = bytearray(source.read_bytes())
    offset = data.index(b'PK\x01\x02')
    struct.pack_into('<H', data, offset + 8, struct.unpack_from('<H', data, offset + 8)[0] | 1)
    source.write_bytes(data)
    with pytest.raises(DocumentFileError, match='DOCUMENT_ENCRYPTED'):
        scan_source(source, 'zip')


def test_bomb_metadata_and_expanded_budget_rejected(tmp_path):
    source = archive(tmp_path / 'source.zip', [('page.png', png())])
    with pytest.raises(DocumentFileError, match='DOCUMENT_ARCHIVE_BUDGET'):
        scan_source(source, 'zip', limits=replace(FileLimits(), max_expanded_bytes=1))
    data = bytearray(source.read_bytes())
    offset = data.index(b'PK\x01\x02')
    struct.pack_into('<L', data, offset + 24, 100_000_000)
    source.write_bytes(data)
    with pytest.raises(DocumentFileError, match='DOCUMENT_ARCHIVE_BUDGET'):
        scan_source(source, 'zip')


def test_central_directory_budget_checked_before_zipfile_load(tmp_path):
    source = archive(tmp_path / 'source.zip', [('page.png', png())])
    data = bytearray(source.read_bytes())
    offset = data.rindex(b'PK\x05\x06')
    struct.pack_into('<L', data, offset + 12, 20_000_000)
    source.write_bytes(data)
    with pytest.raises(DocumentFileError, match='DOCUMENT_ARCHIVE_BUDGET'):
        scan_source(source, 'zip')


def test_pixel_and_spool_limits_are_not_the_source_200mb_limit(tmp_path):
    source = archive(tmp_path / 'source.zip', [('page.png', png())])
    with pytest.raises(DocumentFileError, match='DOCUMENT_PAGE_TOO_LARGE'):
        list(normalize_pages(source, 'zip', tmp_path / 'pixels', limits=replace(FileLimits(), max_page_pixels=1)))
    with pytest.raises(DocumentFileError, match='DOCUMENT_ARCHIVE_BUDGET|DOCUMENT_SPOOL_BUDGET'):
        list(normalize_pages(source, 'zip', tmp_path / 'spool', limits=replace(FileLimits(), max_spool_bytes=100)))


def test_bad_page_does_not_disappear_from_manifest(tmp_path):
    source = archive(tmp_path / 'source.zip', [('1.png', png()), ('2.png', b'not-a-png')])
    assert len(scan_source(source, 'zip')) == 2
    with pytest.raises(DocumentFileError, match='DOCUMENT_INVALID_PAGE'):
        list(normalize_pages(source, 'zip', tmp_path / 'pages'))


@pytest.mark.parametrize('name', ['2.svg', '2.jxl', '2.apng', '2.unknown', 'nested.zip', 'page-without-suffix'])
def test_unknown_page_formats_are_not_silently_ignored(tmp_path, name):
    source = archive(tmp_path / 'source.zip', [('1.png', png()), (name, b'unsupported picture')])
    with pytest.raises(DocumentFileError, match='DOCUMENT_UNSUPPORTED_ENTRY'):
        scan_source(source, 'zip')


def test_manifest_changes_are_not_silently_reindexed(tmp_path):
    source = archive(tmp_path / 'source.zip', [('1.png', png())])
    manifest = scan_source(source, 'zip')
    manifest[0]['source_name'] = 'changed'
    with pytest.raises(DocumentFileError, match='DOCUMENT_MANIFEST_MISMATCH'):
        list(normalize_pages(source, 'zip', tmp_path / 'pages', manifest=manifest))


def test_pdf_rasterizes_all_pages_as_png(tmp_path):
    pytest.importorskip('pypdfium2')
    source = tmp_path / 'source.pdf'
    first, second = Image.new('RGB', (120, 160), 'white'), Image.new('RGB', (160, 120), 'blue')
    first.save(source, 'PDF', save_all=True, append_images=[second])
    manifest = scan_source(source, 'pdf')
    assert len(manifest) == 2
    pages = list(normalize_pages(source, 'pdf', tmp_path / 'pages', manifest=manifest))
    assert len(pages) == 2 and all(page['mime'] == 'image/png' for page in pages)
    for page in pages:
        with Image.open(page['path']) as image:
            assert image.size == (page['width'], page['height'])
            assert image.format == 'PNG'


def test_package_refuses_missing_or_corrupted_pages_and_keeps_existing_files(tmp_path):
    page = tmp_path / '1.png'
    page.write_bytes(png())
    descriptor = {'path': page, 'page_index': 1, 'sha256': hashlib.sha256(page.read_bytes()).hexdigest(),
                  'byte_size': page.stat().st_size, 'mime': 'image/png'}
    with pytest.raises(DocumentFileError, match='DOCUMENT_INCOMPLETE_PAGES'):
        package_zip([{**descriptor, 'page_index': 2}], tmp_path / 'missing.zip')
    with pytest.raises(DocumentFileError, match='DOCUMENT_OUTPUT_MISMATCH'):
        package_zip([{**descriptor, 'sha256': '0' * 64}], tmp_path / 'corrupt.zip')
    assert not (tmp_path / 'corrupt.zip').exists()
    target = tmp_path / 'existing.zip'
    target.write_bytes(b'owned-by-user')
    with pytest.raises(FileExistsError):
        package_zip([descriptor], target)
    assert target.read_bytes() == b'owned-by-user'


@pytest.mark.parametrize('name', ['page.png', '日本語-é-🎨.png'])
def test_subprocess_scan_and_normalize_without_production_sandbox(tmp_path, name):
    source = archive(tmp_path / 'source.zip', [(name, png())])
    manifest = run_file_operation('scan', source, 'zip', require_sandbox=False)
    pages = run_file_operation('normalize', source, 'zip', tmp_path / 'pages', manifest,
                               require_sandbox=False)
    assert len(pages) == 1 and pages[0]['path'].is_file()
    assert pages[0]['source_name'] == name


def test_unsandboxed_runtime_probe_checks_pdf_and_zip_in_current_source(tmp_path, monkeypatch):
    import comic_document_files as shared
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('PYTHONPATH', str(tmp_path / 'obsolete-code'))
    assert shared._parser_command() == [shared.sys.executable, '-I',
        str(Path(shared.__file__).with_name('__main__.py'))]
    assert shared.check_parser_runtime(tmp_path, require_sandbox=False)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('returncode, output', [(1, b''), (0, b'wrong-probe')])
def test_unsandboxed_runtime_probe_rejects_unusable_parser(tmp_path, monkeypatch, returncode, output):
    import comic_document_files as shared
    from types import SimpleNamespace
    monkeypatch.setattr(shared.subprocess, 'run',
        lambda *args, **kwargs: SimpleNamespace(returncode=returncode, stdout=output))
    with pytest.raises(DocumentFileError, match='DOCUMENT_PARSER_UNAVAILABLE'):
        shared.check_parser_runtime(tmp_path, require_sandbox=False)


def test_runtime_probe_requires_sandbox_without_automatic_fallback(tmp_path, monkeypatch):
    import comic_document_files as shared
    calls = []
    def unavailable(path, *, require_sandbox):
        calls.append(require_sandbox)
        raise DocumentFileError('DOCUMENT_SANDBOX_UNAVAILABLE')
    monkeypatch.setattr(shared, 'check_parser_sandbox', unavailable)
    monkeypatch.setattr(shared.subprocess, 'run', lambda *a, **k: pytest.fail('Unexpected fallback'))
    with pytest.raises(DocumentFileError, match='DOCUMENT_SANDBOX_UNAVAILABLE'):
        shared.check_parser_runtime(tmp_path)
    assert calls == [True]


def test_cbz_uses_same_bounded_zip_parser(tmp_path):
    import comic_document_files as shared
    source = archive(tmp_path / 'source.cbz', [('2.png', png()), ('1.png', png())])
    pages = shared.run_file_operation('normalize', source, 'cbz', tmp_path / 'pages', require_sandbox=False)
    assert [page['source_name'] for page in pages] == ['1.png', '2.png']


def test_child_is_not_given_r2_credentials(monkeypatch, tmp_path):
    from app.documents import files
    monkeypatch.setenv('DOCUMENT_R2_SECRET_ACCESS_KEY', 'private-test-key')
    source = archive(tmp_path / 'source.zip', [('page.png', png())])
    captured = {}
    class Child:
        returncode = 0
        def __init__(self, command, **kwargs):
            captured.update(kwargs)
            self.stdout = BytesIO(json.dumps({'result': []}).encode())
        def poll(self):
            return 0
        def wait(self):
            return 0
    monkeypatch.setattr(files.subprocess, 'Popen', Child)
    run_file_operation('scan', source, 'zip', require_sandbox=False)
    assert 'DOCUMENT_R2_SECRET_ACCESS_KEY' not in captured['env']
    assert all('secret' not in value.lower() for value in captured['env'].values())


def test_parser_stdout_flood_is_bounded_and_killed(monkeypatch, tmp_path):
    from app.documents import files
    source = archive(tmp_path / 'source.zip', [('page.png', png())])
    killed = []
    class Child:
        returncode = 0
        def __init__(self, command, **kwargs):
            self.stdout = BytesIO(b'x' * (files.MAX_IPC_BYTES + 1))
        def poll(self):
            return 0
        def wait(self):
            return 0
        def kill(self):
            killed.append(True)
    monkeypatch.setattr(files.subprocess, 'Popen', Child)
    with pytest.raises(DocumentFileError, match='DOCUMENT_PARSE_FAILED'):
        run_file_operation('scan', source, 'zip', require_sandbox=False)
    assert killed == [True]


def test_parser_deadline_kills_child(monkeypatch, tmp_path):
    from app.documents import files
    source = archive(tmp_path / 'source.zip', [('page.png', png())])
    killed = []
    class Child:
        returncode = None
        def __init__(self, command, **kwargs):
            self.stdout = BytesIO(b'')
        def poll(self):
            return self.returncode
        def wait(self):
            return self.returncode
        def kill(self):
            killed.append(True)
            self.returncode = -9
    monkeypatch.setattr(files.subprocess, 'Popen', Child)
    with pytest.raises(DocumentFileError, match='DOCUMENT_PARSE_TIMEOUT'):
        run_file_operation('scan', source, 'zip', require_sandbox=False, timeout=0.001)
    assert killed == [True]


def test_required_sandbox_fails_closed_when_unavailable(monkeypatch, tmp_path):
    import comic_document_files as files
    source = archive(tmp_path / 'source.zip', [('page.png', png())])
    monkeypatch.setattr(files.sys, 'platform', 'unsupported')
    with pytest.raises(DocumentFileError, match='DOCUMENT_SANDBOX_UNAVAILABLE'):
        run_file_operation('scan', source, 'zip', require_sandbox=True)


def test_shared_package_is_the_only_parser_implementation_and_backend_injects_settings(monkeypatch, tmp_path):
    import comic_document_files as shared
    from app.documents import files
    from types import SimpleNamespace
    assert files.DocumentFileError is shared.DocumentFileError
    assert issubclass(files.FileLimits, shared.FileLimits)
    configured = replace(shared.FileLimits(), max_page_pixels=1)
    monkeypatch.setattr(files, 'get_document_settings', lambda: SimpleNamespace(
        **{name: getattr(configured, name) for name in configured.__dataclass_fields__}))
    source = archive(tmp_path / 'source.zip', [('page.png', png())])
    with pytest.raises(DocumentFileError, match='DOCUMENT_PAGE_TOO_LARGE'):
        list(files.normalize_pages(source, 'zip', tmp_path / 'configured'))
    assert list(shared.normalize_pages(source, 'zip', tmp_path / 'standalone'))


def test_shared_sandbox_launches_isolated_parser_not_backend_or_engine(monkeypatch, tmp_path):
    import comic_document_files as shared
    with monkeypatch.context() as patch:
        patch.setattr(shared.sys, 'platform', 'linux')
        command = shared._sandbox_command(tmp_path / 'source', tmp_path / 'output')
    assert command[:3] == [shared.sys.executable, '-I', str(Path(shared.__file__).with_name('linux_sandbox.py'))]
    assert str(Path(shared.__file__).resolve().parent.parent.parent) not in command
    assert command[-2:] == [str(tmp_path / 'source'), str(tmp_path / 'output')]


def test_shared_pdf_child_has_no_application_import_and_preserves_all_pages(tmp_path):
    import comic_document_files as shared
    pytest.importorskip('pypdfium2')
    source = tmp_path / 'source.pdf'
    with Image.new('RGB', (64, 96), 'white') as first, Image.new('RGB', (96, 64), 'blue') as second:
        first.save(source, 'PDF', save_all=True, append_images=[second])
    rows = shared.run_file_operation('normalize', source, 'pdf', tmp_path / 'pages',
                                    limits=shared.FileLimits(), require_sandbox=False)
    assert len(rows) == 2
    assert [row['page_index'] for row in rows] == [1, 2]
    assert all(row['path'].is_file() and row['mime'] == 'image/png' for row in rows)


def test_zip_digest_is_computed_during_write_without_full_zip_readback(tmp_path, monkeypatch):
    source = archive(tmp_path / 'source.zip', [('1.png', png()), ('2.png', png())])
    pages = list(normalize_pages(source, 'zip', tmp_path / 'pages'))
    destination = tmp_path / 'result.zip'
    original, reads = Path.open, []
    def opened(path, *args, **kwargs):
        if path == destination and (args[0] if args else kwargs.get('mode', 'r')) == 'rb':
            reads.append(path)
        return original(path, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'open', opened)
        result = package_zip(pages, destination)
    assert reads == []
    assert result['sha256'] == hashlib.sha256(destination.read_bytes()).hexdigest()
    with zipfile.ZipFile(destination) as packed:
        assert packed.testzip() is None
        assert packed.namelist() == ['0001.png', '0002.png']
