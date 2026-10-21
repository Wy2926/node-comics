"""Distribution boundary: initialized node data must never enter a release ZIP."""
import json
import zipfile

import pytest

from build_release import Builder, archive_release, sha256
from build_support import copy_sources, download, safe_extract_zip, remove_unused_launchers


def test_cuda_export_keeps_only_the_matching_windows_wheel_hash(tmp_path, monkeypatch):
    import build_release
    project = tmp_path / 'project'
    project.mkdir()
    lock = '\n'.join('''[[package]]
name = "NAME"
wheels = [
 { url = "https://download.pytorch.org/NAME-cp312-cp312-win_amd64.whl", hash = "sha256:WIN" },
 { url = "https://download.pytorch.org/NAME-cp312-cp312-manylinux.whl", hash = "sha256:LINUX" },
]
'''.replace('NAME', name) for name in ('torch', 'torchvision'))
    (project / 'uv.lock').write_text(lock)
    target = tmp_path / 'requirements.txt'
    exported = ''.join(name + '==1.0 \\\n    --hash=sha256:WIN \\\n    --hash=sha256:LINUX\n' for name in ('torch', 'torchvision'))
    exported += 'other==1.0 \\\n    --hash=sha256:OTHER\n'
    monkeypatch.setattr(build_release, 'run', lambda *args, **kwargs: target.write_text(exported))
    builder = Builder.__new__(Builder)
    builder.uv, builder.env = 'uv', {}
    builder.requirements(project, target)
    result = target.read_text()
    assert result.count('--hash=sha256:WIN') == 2
    assert '--hash=sha256:LINUX' not in result
    assert '--hash=sha256:OTHER' in result
    assert 'torch @ https://download.pytorch.org/torch-cp312-cp312-win_amd64.whl' in result


def test_archive_keeps_stable_name_and_excludes_private_and_generated_data(tmp_path):
    release = tmp_path / 'NodeComicsNode'
    release.mkdir()
    (release / 'node.exe').write_bytes(b'release fixture')
    for name in ('data/node.json', 'payload/runtime/python.exe', '.setup/downloads/large.bin'):
        path = release / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('must not distribute')
    (release / 'portable.json').write_text(json.dumps({'files': {'node.exe': sha256(release / 'node.exe')}}))
    archive_release(release, manifest_name='portable.json')
    archive = tmp_path / (release.name + '.zip')
    with zipfile.ZipFile(archive) as package:
        assert package.namelist() == ['NodeComicsNode/node.exe', 'NodeComicsNode/portable.json']
        assert package.testzip() is None
    assert archive.with_suffix('.zip.sha256').read_text() == sha256(archive) + '  ' + archive.name + '\n'
    with pytest.raises(ValueError, match='already exists'):
        archive_release(release, manifest_name='portable.json')


def test_archive_rejects_modified_release(tmp_path):
    (tmp_path / 'node.exe').write_bytes(b'changed')
    (tmp_path / 'portable.json').write_text(json.dumps({'files': {'node.exe': '0' * 64}}))
    with pytest.raises(ValueError, match='changed since manifest'):
        archive_release(tmp_path, manifest_name='portable.json')
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


def test_download_resumes_partial_and_restarts_when_range_is_ignored(tmp_path, monkeypatch):
    from io import BytesIO
    import hashlib
    import build_support
    payload = b'complete verified model'
    checksum = hashlib.sha256(payload).hexdigest()
    for status in (200, 206):
        target = tmp_path / str(status)
        target.with_name(target.name + '.partial').write_bytes(payload[:8])

        def open_url(request, **kwargs):
            assert request.get_header('Range') == 'bytes=8-'
            response = BytesIO(payload[8:] if status == 206 else payload)
            response.status = status
            response.headers = {'Content-Range': f'bytes 8-{len(payload) - 1}/{len(payload)}'}
            return response

        monkeypatch.setattr(build_support.urllib.request, 'urlopen', open_url)
        download('https://example.com/model', checksum, target)
        assert target.read_bytes() == payload


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
    (source / 'local.egg-info').mkdir()
    (source / 'local.egg-info/SOURCES.txt').write_text('generated local build metadata')
    copy_sources(source, tmp_path / 'copied')
    assert (tmp_path / 'copied/module.py').read_bytes() == b'value = 1\n'
    assert not (tmp_path / 'copied/.env').exists()
    assert not (tmp_path / 'copied/local.egg-info').exists()


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


def test_first_install_runtime_has_no_copied_application_code(tmp_path, monkeypatch):
    import build_release
    builder = Builder.__new__(Builder)
    builder.output, builder.session, builder.assets = (tmp_path / name for name in ('payload', 'session', 'assets'))
    builder.output.mkdir()
    base = builder.session / 'python'
    (base / 'DLLs').mkdir(parents=True)
    (base / 'Lib').mkdir()
    (base / 'Lib/stdlib.py').write_text('stdlib fixture')
    for name in ('python.exe', 'pythonw.exe', 'LICENSE.txt'):
        (base / name).write_text(name)
    for directory in ('upstream', 'models', 'fonts', 'licenses', 'hyphenation'):
        (builder.assets / directory).mkdir(parents=True)
    (builder.assets / 'mtu-assets.json').write_text('{}')
    builder.backend, builder.uv, builder.env = 'amd', 'uv', {}
    builder.environment = lambda _: 'packaging-python'
    builder.requirements = lambda _, target: target.write_text('gpu==amd\n', newline='\n')
    def run(args, **kwargs):
        if '-c' in args:
            assert args[:3] == [build_release.sys.executable, '-I', '-B']
            assert args[-2:] == [build_release.ENGINE, builder.output / 'models']
            return json.dumps({'models/fixture': 'model-hash'})
        assert args[:3] == ['uv', 'pip', 'install']
    monkeypatch.setattr(build_release, 'run', run)
    builder.package_runtime()
    assert not (builder.output / 'engine').exists()
    assert '../engine' not in (builder.output / 'runtime/python312._pth').read_text()
    assert builder.model_hashes == {'models/fixture': 'model-hash'}


def test_build_only_emits_portable_package(tmp_path, monkeypatch):
    import build_release
    builder = Builder.__new__(Builder)
    builder.output, builder.version, builder.go = tmp_path / 'NodeComicsNode', '0.3.0', 'go'
    builder.env, builder.tool_envs = {}, {'packaging': 'pytest-python'}
    builder.prepare_go = lambda: None
    builder.environment = lambda name: None
    builder.package_sources = lambda: None
    for name in ('prepare_models', 'package_runtime', 'package_fonts'):
        monkeypatch.setattr(builder, name, lambda: pytest.fail('small-package build prepared a GPU environment'))
    manifests = []
    builder.write_manifest = manifests.append
    monkeypatch.setattr(build_release, 'run', lambda *args, **kwargs: None)
    builder.build()
    assert manifests == ['portable.json']
    assert (builder.output / 'Start.cmd').is_file()
    assert not (builder.output / 'payload').exists()
    with pytest.raises(ValueError, match='never overwrite a configured node'):
        builder.build()
