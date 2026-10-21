import hashlib
import json
import shutil
import subprocess
import sys

import pytest

import run_node


def snapshot(paths):
    return {path: (path.stat().st_mtime_ns, path.read_bytes() if path.is_file() else None)
            for path in paths}


def write_seed(root, files, version='one'):
    hashes = {}
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    (root / 'portable.json').write_text(json.dumps({
        'version': version, 'files': hashes}), encoding='utf-8')


def sources(version, *, obsolete=False):
    result = {
        'source/classic-engine/classic_node/__init__.py': '',
        'source/classic-engine/classic_node/__main__.py': (
            'import importlib.util, json, sys\n'
            'import mtu_engine, comic_document_files\n'
            'print(json.dumps({"version": ' + repr(version) + ', '
            '"engine": mtu_engine.VERSION, "documents": comic_document_files.VERSION, '
            '"obsolete": importlib.util.find_spec("classic_node.obsolete") is not None, '
            '"arguments": sys.argv[1:]}))\n'),
        'source/classic-engine/mtu_engine/__init__.py': 'VERSION = ' + repr(version),
        'backend/document_files/comic_document_files/__init__.py': 'VERSION = ' + repr(version),
    }
    if obsolete:
        result['source/classic-engine/classic_node/obsolete.py'] = 'OLD = True\n'
    return result


def launch(root, *arguments):
    runner = root / 'source/compute-node/run_node.py'
    runner.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(run_node.__file__, runner)
    # Reproduce the import path installed by previous payload python312._pth
    # without copying an interpreter or downloading any dependency.
    code = ('import runpy, sys; sys.path.insert(0, sys.argv.pop(1)); '
            'script = sys.argv.pop(1); sys.argv[0] = script; '
            'runpy.run_path(script, run_name="__main__")')
    return subprocess.run([sys.executable, '-I', '-B', '-c', code,
                           str(root / 'payload/engine'), str(runner), *arguments],
                          check=True, capture_output=True, text=True, timeout=30).stdout


def test_overwrite_uses_new_code_and_removes_deleted_modules_without_touching_payload(tmp_path):
    root = tmp_path / '便携 节点'
    root.mkdir()
    preserved = ('payload/runtime/python.exe', 'payload/runtime/python312._pth',
                 'payload/models/weights.bin', 'data/node.json', 'data/state/journal.db')
    for name in preserved:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'keep existing bytes')
    legacy = root / 'payload/engine/classic_node'
    legacy.mkdir(parents=True)
    (legacy / '__init__.py').write_text('')
    (legacy / '__main__.py').write_text('raise RuntimeError("old code ran")')
    (legacy / 'obsolete.py').write_text('OLD = True')
    before = snapshot(root / name for name in preserved)

    write_seed(root, sources('one', obsolete=True))
    first = json.loads(launch(root, 'check', '--config', str(root / 'data/node.json')))
    assert first['version'] == first['engine'] == first['documents'] == 'one'
    assert first['obsolete'] is True
    write_seed(root, sources('two'), version='two')
    assert (root / 'source/classic-engine/classic_node/obsolete.py').exists()
    second = json.loads(launch(root, 'pending', '--config', str(root / 'data/node.json')))
    assert second['version'] == second['engine'] == second['documents'] == 'two'
    assert second['obsolete'] is False
    assert second['arguments'] == ['pending', '--config', str(root / 'data/node.json')]
    assert not (root / '.setup/app/classic_node/obsolete.py').exists()
    assert snapshot(root / name for name in preserved) == before


def test_unchanged_code_reuses_cache_even_when_release_version_changes(tmp_path, monkeypatch):
    write_seed(tmp_path, sources('same'))
    app = run_node.prepare_app(tmp_path)
    before = snapshot(app.rglob('*'))
    manifest = json.loads((tmp_path / 'portable.json').read_text())
    manifest['version'] = 'launcher-only-update'
    manifest['files']['node.exe'] = 'new launcher hash'
    (tmp_path / 'portable.json').write_text(json.dumps(manifest))
    monkeypatch.setattr(run_node.shutil, 'rmtree', lambda _: pytest.fail('rewrote code cache'))
    assert run_node.prepare_app(tmp_path) == app
    assert snapshot(app.rglob('*')) == before


@pytest.mark.parametrize('damage', ['missing', 'checksum'])
def test_invalid_update_preserves_previous_app_and_can_retry(tmp_path, damage):
    write_seed(tmp_path, sources('one'))
    app = run_node.prepare_app(tmp_path)
    before = snapshot(app.rglob('*'))
    write_seed(tmp_path, sources('two'))
    damaged = tmp_path / 'source/classic-engine/mtu_engine/__init__.py'
    if damage == 'missing':
        damaged.unlink()
    else:
        damaged.write_text('unexpected code')
    with pytest.raises((FileNotFoundError, ValueError)):
        run_node.prepare_app(tmp_path)
    assert snapshot(app.rglob('*')) == before
    write_seed(tmp_path, sources('two'))
    run_node.prepare_app(tmp_path)
    assert (app / 'mtu_engine/__init__.py').read_text() == "VERSION = 'two'"


@pytest.mark.parametrize('name', [
    'source/classic-engine/classic_node/../../escape.py',
    'source/classic-engine/classic_node/..\\escape.py',
    'source/classic-engine/classic_node/file.py:stream',
])
def test_rejects_manifest_path_escape(tmp_path, name):
    write_seed(tmp_path, sources('one'))
    manifest = json.loads((tmp_path / 'portable.json').read_text())
    manifest['files'][name] = '0' * 64
    (tmp_path / 'portable.json').write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match='Invalid portable source path'):
        run_node.prepare_app(tmp_path)
    assert not (tmp_path / '.setup').exists()


def test_rejects_linked_cache_without_touching_target(tmp_path):
    write_seed(tmp_path, sources('one'))
    outside = tmp_path / 'preserved'
    outside.mkdir()
    marker = outside / 'keep.txt'
    marker.write_text('keep')
    try:
        (tmp_path / '.setup').symlink_to(outside, target_is_directory=True)
    except OSError:
        if sys.platform != 'win32':
            raise
        # NTFS junctions need no symlink privilege and exercise the same resolve
        # boundary check on ordinary Windows installations.
        subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J',
                        str(tmp_path / '.setup'), str(outside)],
                       check=True, capture_output=True)
    with pytest.raises(ValueError, match='Linked portable source/cache path'):
        run_node.prepare_app(tmp_path)
    assert marker.read_text() == 'keep'
    assert sorted(path.name for path in outside.iterdir()) == ['keep.txt']


def test_windows_spawn_does_not_reenter_runner(tmp_path):
    files = sources('spawn')
    files['source/classic-engine/classic_node/child.py'] = (
        'def emit(queue):\n'
        '    import mtu_engine\n'
        '    queue.put(mtu_engine.VERSION)\n')
    files['source/classic-engine/classic_node/__main__.py'] = (
        'import multiprocessing\n'
        'from classic_node.child import emit\n'
        'context = multiprocessing.get_context("spawn")\n'
        'queue = context.Queue()\n'
        'child = context.Process(target=emit, args=(queue,))\n'
        'child.start()\n'
        'print(queue.get(timeout=10))\n'
        'child.join(10)\n'
        'assert child.exitcode == 0\n')
    write_seed(tmp_path, files)
    assert launch(tmp_path, 'check').strip() == 'spawn'
