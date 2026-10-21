import argparse
import json
from pathlib import Path

import pytest

import portable_install
from build_release import Builder
from build_support import archive_release, build_environment, sha256


def seed(directory):
    directory.mkdir()
    (directory / 'node.exe').write_bytes(b'launcher fixture')
    (directory / 'portable.json').write_text(json.dumps({
        'format': 'gpu-portable-v1', 'version': '0.2.0',
        'files': {'node.exe': sha256(directory / 'node.exe')}}))
    return argparse.Namespace(root=directory, run=directory / '.setup/tools', uv=Path('uv'), backend='amd')


@pytest.mark.parametrize('forbidden', ['payload/runtime/python.exe', '.setup/cache.bin', 'data/node.json'])
def test_archive_rejects_private_or_generated_files_even_if_listed(tmp_path, forbidden):
    args = seed(tmp_path / 'portable')
    path = args.root / forbidden
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('not distributable')
    manifest = json.loads((args.root / 'portable.json').read_text())
    manifest['files'][forbidden] = sha256(path)
    (args.root / 'portable.json').write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match='Invalid distribution'):
        archive_release(args.root, manifest_name='portable.json')


def test_installer_publishes_only_complete_payload_and_retries(tmp_path, monkeypatch):
    args = seed(tmp_path / 'portable')
    attempts = []

    class FixtureBuilder:
        def __init__(self, options):
            self.output = options.output
            assert options.backend == 'amd'
        def prepare_models(self):
            (self.output / 'model').write_text('verified model fixture')
        def package_runtime(self):
            assert not (args.root / 'payload').exists()
            attempts.append(1)
            if len(attempts) == 1:
                raise OSError('interrupted download')
            (self.output / 'runtime').write_text('verified runtime fixture')
        def package_fonts(self):
            pass
        def write_manifest(self):
            (self.output / 'release.json').write_text(json.dumps({'backend': 'amd', 'python': '3.12.11'}))

    monkeypatch.setattr(portable_install, 'Builder', FixtureBuilder)
    with pytest.raises(OSError, match='interrupted'):
        portable_install.install(args)
    assert not (args.root / 'payload').exists()
    portable_install.install(args)
    assert (args.root / 'payload/runtime').is_file()
    manifest = json.loads((args.root / 'payload/release.json').read_text())
    assert manifest['backend'] == 'amd'
    assert 'seed_sha256' not in manifest
    assert not (args.root / 'data').exists()
    with pytest.raises(ValueError, match='never overwrite'):
        portable_install.install(args)


def test_installer_rejects_unknown_package_format_before_any_download(tmp_path, monkeypatch):
    args = seed(tmp_path / 'portable')
    (args.root / 'portable.json').write_text(json.dumps({'format': 'unknown'}))
    monkeypatch.setattr(portable_install, 'Builder', lambda _: pytest.fail('started unsupported installation'))
    with pytest.raises(ValueError, match='Unsupported portable package'):
        portable_install.install(args)
    assert not (args.root / '.setup').exists()


def test_manifest_dependency_hashes_are_independent_of_application_version(tmp_path):
    from build_release import ENGINE
    manifests = []
    for version in ('0.2.0', '0.3.0'):
        builder = Builder.__new__(Builder)
        builder.output = tmp_path / version
        builder.output.mkdir()
        builder.session = tmp_path
        builder.version = version
        builder.lock = {'python': {'version': '3.12.11'}}
        (builder.output / 'node.exe').write_text('new application code ' + version)
        def requirements(project, target):
            assert project in (ENGINE, ENGINE / 'environments/amd')
            target.write_text('gpu==' + ('cuda' if project == ENGINE else 'amd') + '\n', newline='\n')
        builder.requirements = requirements
        builder.write_manifest('portable.json')
        manifests.append(json.loads((builder.output / 'portable.json').read_text()))
    old, new = manifests
    assert old['version'] != new['version'] and old['files'] != new['files']
    assert old['requirements_sha256'] == new['requirements_sha256']
    assert set(new['requirements_sha256']) == {'cuda', 'amd'}
    assert new['requirements_sha256']['cuda'] != new['requirements_sha256']['amd']
    assert new['python'] == '3.12.11' and new['format'] == 'gpu-portable-v1'
    assert 'seed_sha256' not in new and 'backend' not in new


def test_payload_manifest_is_not_bound_to_application_archive(tmp_path):
    builder = Builder.__new__(Builder)
    builder.output = tmp_path
    builder.version, builder.backend = '0.3.0', 'amd'
    builder.lock = {'python': {'version': '3.12.11'}}
    builder.model_hashes, builder.fonts = {'models/fixture': 'model-hash'}, ['fonts/fixture.ttf']
    (tmp_path / 'runtime-requirements.txt').write_text('gpu==amd\n', newline='\n')
    builder.write_manifest()
    manifest = json.loads((tmp_path / 'release.json').read_text())
    assert manifest['backend'] == 'amd' and manifest['python'] == '3.12.11'
    assert manifest['fonts'] == builder.fonts and manifest['models'] == builder.model_hashes
    assert 'seed_sha256' not in manifest and 'requirements_sha256' not in manifest


def test_bootstrap_environment_is_process_local(tmp_path, monkeypatch):
    monkeypatch.setenv('TEMP', 'outside-temp')
    monkeypatch.setenv('UV_PROJECT_ENVIRONMENT', 'outside-env')
    monkeypatch.setenv('PYTHONPATH', 'outside-python')
    import os
    result = build_environment(tmp_path)
    assert 'UV_PROJECT_ENVIRONMENT' not in result and 'PYTHONPATH' not in result
    for key in ('TEMP', 'TMP', 'UV_CACHE_DIR', 'HF_HOME', 'TORCH_HOME', 'CUDA_CACHE_PATH'):
        assert Path(result[key]).is_relative_to(tmp_path)
    assert os.environ['TEMP'] == 'outside-temp'


def test_amd_export_pins_non_pypi_artifacts_and_preserves_cuda_separation(tmp_path, monkeypatch):
    import build_release
    root = Path(build_release.__file__).parent
    pins = json.loads((root / 'portable-amd-artifacts.json').read_text())
    project = tmp_path / 'project'
    project.mkdir()
    (project / 'uv.lock').write_text('\n'.join(
        f'[[package]]\nname = "{name}"\nversion = "{pin["version"]}"\nwheels = [{{url = "{pin["url"]}"}}]\n'
        for name, pin in pins.items()))
    target = tmp_path / 'requirements.txt'
    exported = ''.join(f'{name}=={pin["version"]}\n' for name, pin in pins.items())
    monkeypatch.setattr(build_release, 'run', lambda *a, **k: target.write_text(exported))
    builder = Builder.__new__(Builder)
    builder.uv, builder.env = 'uv', {}
    builder.requirements(project, target)
    result = target.read_text()
    for name, pin in pins.items():
        assert f'{name} @ {pin["url"]} --hash=sha256:{pin["sha256"]}' in result
    assert 'cu126' not in result and 'onnxruntime-gpu' not in result
    (project / 'uv.lock').write_text((project / 'uv.lock').read_text().replace('10.1.0', '10.2.0'))
    with pytest.raises(ValueError, match='differs from environment lock'):
        builder.requirements(project, target)


def test_real_cuda_lock_contains_hashes_for_both_windows_wheels():
    import tomllib
    from build_release import ENGINE
    packages = tomllib.loads((ENGINE / 'uv.lock').read_text(encoding='utf-8'))['package']
    for name in ('torch', 'torchvision'):
        package, = [p for p in packages if p['name'] == name]
        wheel, = [w for w in package['wheels'] if w['url'].endswith('cp312-cp312-win_amd64.whl')]
        assert wheel['hash'].startswith('sha256:') and len(wheel['hash']) == 71
