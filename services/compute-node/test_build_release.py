"""Distribution boundary: initialized node data must never enter a release ZIP."""
import json
from pathlib import Path
import zipfile

import pytest

from build_release import archive_release, sha256
from build_support import copy_sources, download, safe_extract_zip, remove_unused_launchers


def test_archive_preserves_version_name_and_excludes_private_data(tmp_path):
    release = tmp_path / 'NodeComicsNode-0.1.0-windows-x64'
    release.mkdir()
    (release / 'node.exe').write_bytes(b'release fixture')
    (release / 'data').mkdir()
    (release / 'data/node.json').write_text('private fixture credential')
    (release / 'release.json').write_text(json.dumps({'files': {'node.exe': sha256(release / 'node.exe')}}))
    archive_release(release)
    archive = tmp_path / (release.name + '.zip')
    with zipfile.ZipFile(archive) as package:
        assert package.namelist() == [release.name + '/node.exe', release.name + '/release.json']
        assert package.testzip() is None
    assert archive.with_suffix('.zip.sha256').read_text() == sha256(archive) + '  ' + archive.name + '\n'
    with pytest.raises(ValueError, match='already exists'):
        archive_release(release)


def test_archive_rejects_modified_release(tmp_path):
    (tmp_path / 'node.exe').write_bytes(b'changed')
    (tmp_path / 'release.json').write_text(json.dumps({'files': {'node.exe': '0' * 64}}))
    with pytest.raises(ValueError, match='changed since manifest'):
        archive_release(tmp_path)
    assert not tmp_path.with_name(tmp_path.name + '.zip').exists()


def test_download_checks_cached_inputs(tmp_path):
    source = tmp_path / 'source.bin'
    source.write_bytes(b'fixed input')
    target = tmp_path / 'downloaded.bin'
    download(source.as_uri(), sha256(source), target)
    assert target.read_bytes() == source.read_bytes()
    target.write_bytes(b'corrupt cache')
    with pytest.raises(ValueError, match='Cached input checksum'):
        download(source.as_uri(), sha256(source), target)


def test_tool_archive_cannot_escape_destination(tmp_path):
    archive = tmp_path / 'tool.zip'
    with zipfile.ZipFile(archive, 'w') as package:
        package.writestr('../outside.txt', 'not allowed')
    with pytest.raises(ValueError, match='Unsafe archive entry'):
        safe_extract_zip(archive, tmp_path / 'tool')
    assert not (tmp_path / 'outside.txt').exists()


def test_source_copy_normalizes_git_line_endings(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'module.py').write_bytes(b'value = 1\r\n')
    (source / '.env').write_text('never package')
    copy_sources(source, tmp_path / 'copied')
    assert (tmp_path / 'copied/module.py').read_bytes() == b'value = 1\n'
    assert not (tmp_path / 'copied/.env').exists()


def test_unused_absolute_launchers_are_removed_from_runtime(tmp_path):
    (tmp_path / 'bin').mkdir()
    (tmp_path / 'bin/tool.exe').write_bytes(b'build path launcher')
    metadata = tmp_path / 'package.dist-info'
    metadata.mkdir()
    (metadata / 'METADATA').write_text('Name: package\n')
    (metadata / 'RECORD').write_text('bin/tool.exe,hash,19\npackage.dist-info/METADATA,hash,14\n')
    remove_unused_launchers(tmp_path)
    assert not (tmp_path / 'bin').exists()
    assert (metadata / 'RECORD').read_text() == 'package.dist-info/METADATA,hash,14\n'
