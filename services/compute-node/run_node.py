"""Run current portable-package code with the already installed GPU runtime."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import runpy
import shutil
import sys


SOURCE_PACKAGES = {
    'source/classic-engine/classic_node/': 'classic_node/',
    'source/classic-engine/mtu_engine/': 'mtu_engine/',
    'backend/document_files/comic_document_files/': 'comic_document_files/',
}
FINGERPRINT = '.source-fingerprint'


def checked_path(root, name):
    """Limit source reads and cache replacement to ordinary package paths."""
    relative = PurePosixPath(name)
    if (relative.is_absolute() or '\\' in name or ':' in name
            or any(part in ('', '.', '..') for part in name.split('/'))):
        raise ValueError('Invalid portable source path: ' + name)
    path = root.joinpath(*relative.parts)
    if path.is_symlink() or path.resolve() != path:
        raise ValueError('Linked portable source/cache path: ' + name)
    return path


def prepare_app(root):
    root = Path(root).resolve()
    manifest = json.loads((root / 'portable.json').read_text(encoding='utf-8'))
    sources = {}
    for name, expected in manifest['files'].items():
        for prefix, package in SOURCE_PACKAGES.items():
            if name.startswith(prefix):
                destination = package + name[len(prefix):]
                checked_path(root, name)
                checked_path(root, destination)
                sources[name] = (destination, expected)
                break
    if 'source/classic-engine/classic_node/__main__.py' not in sources:
        raise ValueError('Portable package is missing the node entry point')
    fingerprint = hashlib.sha256(json.dumps(
        sources, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    app = checked_path(root, '.setup/app')
    marker = checked_path(root, '.setup/app/' + FINGERPRINT)
    if marker.is_file() and marker.read_text(encoding='ascii') == fingerprint:
        return app

    stage = checked_path(root, '.setup/app-staging')
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    for name, (destination, expected) in sorted(sources.items()):
        content = checked_path(root, name).read_bytes()
        if hashlib.sha256(content).hexdigest() != expected:
            raise ValueError('Portable source checksum mismatch: ' + name)
        target = stage / destination
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    (stage / FINGERPRINT).write_text(fingerprint, encoding='ascii')
    # Only a fully copied and checked code cache replaces the previous one.
    # Runtime, assets, configuration and recovery data are never modified.
    if app.exists():
        shutil.rmtree(app)
    stage.rename(app)
    return app


def activate_app(root, app):
    # Old .5/.7 runtimes put ../engine in python312._pth. Remove that fallback
    # so an obsolete module cannot be imported after an overwrite upgrade.
    old_engine = Path(root).resolve() / 'payload/engine'
    sys.path[:] = [entry for entry in sys.path
                   if not Path(entry).resolve().is_relative_to(old_engine)
                   and Path(entry).resolve() != app]
    sys.path.insert(0, str(app))


def main():
    root = Path(__file__).resolve().parents[2]
    activate_app(root, prepare_app(root))
    runpy.run_module('classic_node', run_name='__main__')


if __name__ == '__main__':
    # Windows multiprocessing imports this file as __mp_main__; children inherit
    # the selected sys.path and must not launch or replace the node again.
    main()
