"""Pinned upstream assets; downloads belong to preparation, never page execution."""
import hashlib
import json
from pathlib import Path
import sys

LOCK = json.loads(Path(__file__).with_name('upstream.lock.json').read_text(encoding='utf-8'))


def file_hash(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(models):
    root = Path(models).resolve().parent
    manifest = json.loads((root / 'mtu-assets.json').read_text(encoding='utf-8'))
    if manifest['upstream'] != LOCK['source']['revision'] or manifest['lock_sha256'] != file_hash(Path(__file__).with_name('upstream.lock.json')):
        raise ValueError('MTU assets do not match the pinned source and models; run tools.prepare_mtu')
    if manifest.get('comic_translate') != LOCK['comic_translate']['revision']:
        raise ValueError('Comic Translate assets do not match the pinned source; run tools.prepare_mtu')
    for name, expected in manifest['files'].items():
        path = (root / name).resolve()
        if not path.is_relative_to(root) or file_hash(path) != expected:
            raise ValueError(f'MTU asset checksum mismatch: {name}')
    return manifest


def activate(models):
    """Import the verified upstream bundle, including checksum-pinned source edits."""
    root = Path(models).resolve().parent / 'upstream'
    for package, directory in (('manga_translator', root), ('ballontranslator', root),
                               ('modules', root / 'comic_translate'), ('imkit', root / 'comic_translate')):
        existing = sys.modules.get(package)
        if existing is not None and Path(existing.__file__).resolve().parent != directory / package:
            raise RuntimeError(f'A different {package} source is already loaded in this process')
        if str(directory) not in sys.path:
            sys.path.insert(0, str(directory))
    return root
