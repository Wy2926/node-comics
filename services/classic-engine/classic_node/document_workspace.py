"""Fenced, task-private document files; no intermediate object-storage traffic.

The node's existing Journal owns the process lock. All workspaces in that
process share one spool budget/lock; native parsing remains in the isolated
shared parser. A lease receipt does not delete this task-owned directory.
"""
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
from threading import RLock

from comic_document_files import (DocumentFileError, FileLimits, MAX_IPC_BYTES,
    MAX_PAGES, MAX_SOURCE_BYTES, package_zip, run_file_operation)

from .protocol import MAX_CHECKPOINT_BYTES


MAX_WORKSPACES = 64
MAX_MANIFEST_BYTES = 1024 * 1024
_ROOTS = {}
_ROOTS_LOCK = RLock()
_ACTIONS = {'doc_ocr': 'analysis', 'doc_render': 'output'}
_PNG = b'\x89PNG\r\n\x1a\n'


def _fail(code='DOCUMENT_WORKSPACE_MISMATCH'):
    raise DocumentFileError(code)


def _check(callback):
    if callback:
        callback()


def _identifier(value):
    if (not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', value)
            or value.upper() in {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)),
                                *(f'LPT{i}' for i in range(1, 10))}):
        _fail()
    return value


def _info(path, *, directory=False, missing=False):
    try:
        value = path.lstat()
    except FileNotFoundError:
        if missing:
            return None
        _fail('DOCUMENT_WORKSPACE_MISSING')
    if (stat.S_ISLNK(value.st_mode)
            or getattr(value, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)
            or not (stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode))
            or not directory and value.st_nlink != 1):
        _fail('DOCUMENT_WORKSPACE_UNSAFE')
    return value


def _directory(path, *, create=False):
    # Validate BEFORE resolve/mkdir: resolve alone would hide a symlink/junction.
    path = Path(path).absolute()
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if _info(current, directory=True, missing=True) is None:
            if not create:
                _fail('DOCUMENT_WORKSPACE_MISSING')
            current.mkdir(mode=0o700)
            _info(current, directory=True)
            _fsync_directory(current.parent)
    return path


def _fsync_directory(path):
    if os.name != 'nt':
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _json(value, maximum):
    try:
        data = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                          allow_nan=False).encode()
    except (TypeError, ValueError, RecursionError):
        _fail()
    if len(data) > maximum:
        _fail('DOCUMENT_WORKSPACE_BUDGET')
    return data


def _ref(value, *, maximum, mime=None):
    if (not isinstance(value, dict) or not isinstance(value.get('sha256'), str)
            or re.fullmatch(r'[a-f0-9]{64}', value['sha256']) is None
            or type(value.get('byte_size')) is not int or not 0 < value['byte_size'] <= maximum
            or not isinstance(value.get('mime'), str) or mime is not None and value['mime'] != mime):
        _fail()
    result = {name: value[name] for name in ('sha256', 'byte_size', 'mime')}
    if value['mime'] == 'image/png':
        for name in ('width', 'height'):
            if type(value.get(name)) is not int or value[name] <= 0:
                _fail()
            result[name] = value[name]
    return result


def _same(actual, expected):
    return isinstance(expected, dict) and all(expected.get(name) == value for name, value in actual.items())


def _png_dimensions(prefix, ref, limits):
    if (len(prefix) < 24 or prefix[:8] != _PNG or prefix[8:16] != b'\0\0\0\rIHDR'
            or struct.unpack('>II', prefix[16:24]) != (ref['width'], ref['height'])
            or max(ref['width'], ref['height']) > limits.max_page_dimension
            or ref['width'] * ref['height'] > limits.max_page_pixels):
        _fail('DOCUMENT_INVALID_PAGE')


def _walk(root):
    result, pending, count = {}, [(root, 0)], 0
    while pending:
        directory, depth = pending.pop()
        _info(directory, directory=True)
        with os.scandir(directory) as entries:
            for entry in entries:
                count += 1
                if count > MAX_WORKSPACES * (MAX_PAGES * 6 + 64) or depth > 5:
                    _fail('DOCUMENT_WORKSPACE_BUDGET')
                path = Path(entry.path)
                if entry.is_dir(follow_symlinks=False):
                    _info(path, directory=True)
                    pending.append((path, depth + 1))
                else:
                    result[path] = _info(path).st_size
    return result


def inventory(state_dir):
    """Bounded startup/sync inventory, including incomplete generation dirs."""
    root = Path(state_dir).absolute() / 'documents'
    if _info(root, directory=True, missing=True) is None:
        return []
    _directory(root)
    values = []
    with os.scandir(root) as jobs:
        for job_count, job in enumerate(jobs, 1):
            if job_count > MAX_WORKSPACES:
                _fail('DOCUMENT_WORKSPACE_BUDGET')
            _identifier(job.name)
            job_path = Path(job.path)
            _info(job_path, directory=True)
            with os.scandir(job_path) as generations:
                for generation in generations:
                    _info(Path(generation.path), directory=True)
                    if (not re.fullmatch(r'[1-9][0-9]{0,9}', generation.name)
                            or int(generation.name) > 2 ** 31 - 1):
                        _fail('DOCUMENT_WORKSPACE_UNSAFE')
                    values.append({'job_id': job.name, 'workspace_generation': int(generation.name)})
                    if len(values) > MAX_WORKSPACES:
                        _fail('DOCUMENT_WORKSPACE_BUDGET')
    return values


class _Spool:
    def __init__(self, root):
        self.root = _directory(root, create=True)
        self.lock = RLock()
        self.sizes = _walk(root)  # Once on startup, not once per page/write.
        self.used = sum(self.sizes.values())

    def record(self, path, size=None):
        self.used -= self.sizes.pop(path, 0)
        if size is not None:
            self.sizes[path] = size
            self.used += size

    def refresh(self, directory):
        for path in tuple(self.sizes):
            if path.is_relative_to(directory):
                self.record(path)
        if directory.exists():
            for path, size in _walk(directory).items():
                self.record(path, size)

    def require(self, size, limit):
        if size < 0 or self.used + size > limit:
            _fail('DOCUMENT_SPOOL_BUDGET')


class DocumentWorkspace:
    inventory = staticmethod(inventory)

    def __init__(self, state_dir, job_id, generation, *, owner_id=None, limits=None,
                 require_sandbox=True, create=False):
        self.job_id = _identifier(job_id)
        if type(generation) is not int or not 1 <= generation <= 2 ** 31 - 1:
            _fail()
        self.generation, self.owner_id = generation, owner_id
        if owner_id is not None:
            _identifier(owner_id)
        self.limits = limits or FileLimits()
        self.require_sandbox = require_sandbox
        root = Path(state_dir).absolute() / 'documents'
        if not create:
            _directory(root)
        with _ROOTS_LOCK:
            self._spool = _ROOTS.setdefault(root, None)
            if self._spool is None:
                self._spool = _ROOTS[root] = _Spool(root)
        self.path = root / self.job_id / str(generation)
        with self._spool.lock:
            if (create and _info(self.path, directory=True, missing=True) is None
                    and len(inventory(state_dir)) >= MAX_WORKSPACES):
                _fail('DOCUMENT_WORKSPACE_BUDGET')
            _directory(self.path, create=create)
            if _info(self.path / 'manifest.json', missing=True) is None:
                if create:
                    self._save({'version': 1, 'job_id': job_id, 'workspace_generation': generation,
                        'owner_id': owner_id, 'prepared': False, 'pages': []})
                # A crash before the first manifest is still discoverable and
                # terminal-authorized cleanup can remove that exact generation.
                # Any input/prepare/checkpoint read continues to fail MISSING.
            else:
                self._load()

    def _file(self, relative):
        path = self.path / relative
        if not path.is_relative_to(self.path) or '..' in path.parts:
            _fail('DOCUMENT_WORKSPACE_UNSAFE')
        _directory(path.parent)
        _info(path, missing=True)
        return path

    def _load(self):
        data = self._read('manifest.json', maximum=MAX_MANIFEST_BYTES)
        try:
            value = json.loads(data)
        except (ValueError, UnicodeError):
            _fail()
        if (not isinstance(value, dict) or value.get('version') != 1
                or value.get('job_id') != self.job_id or value.get('workspace_generation') != self.generation
                or value.get('owner_id') != self.owner_id or not isinstance(value.get('pages'), list)
                or type(value.get('prepared')) is not bool or value['prepared'] and not value['pages']
                or len(value['pages']) > MAX_PAGES
                or any(not isinstance(page, dict) for page in value['pages'])
                or [page.get('page_index') for page in value['pages']] != list(range(1, len(value['pages']) + 1))):
            _fail()
        return value

    def _save(self, manifest):
        self._atomic('manifest.json', _json(manifest, MAX_MANIFEST_BYTES))

    def _atomic(self, relative, data):
        path = self._file(relative)
        temporary = self._file(relative + '.part')
        self._unlink(temporary)
        self._spool.require(len(data), self.limits.max_spool_bytes)
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                 | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            self._spool.record(path, len(data))
            _fsync_directory(path.parent)
        finally:
            self._unlink(temporary)

    def _unlink(self, path):
        if _info(path, missing=True) is not None:
            path.unlink()
        self._spool.record(path)

    def _verify(self, relative, ref, *, collect=False, check=None):
        path = self._file(relative)
        if _info(path).st_size != ref['byte_size']:
            _fail()
        digest, data, prefix, size = hashlib.sha256(), bytearray() if collect else None, b'', 0
        with path.open('rb') as stream:
            while chunk := stream.read(1024 * 1024):
                _check(check)
                size += len(chunk)
                if size > ref['byte_size']:
                    _fail()
                digest.update(chunk)
                if not prefix:
                    prefix = chunk[:24]
                if collect:
                    data.extend(chunk)
                    if len(data) > ref['byte_size']:
                        _fail()
        if size != ref['byte_size'] or digest.hexdigest() != ref['sha256']:
            _fail()
        if ref['mime'] == 'image/png':
            _png_dimensions(prefix, ref, self.limits)
        return bytes(data) if collect else path

    def _read(self, relative, *, maximum, ref=None):
        if ref is not None:
            return self._verify(relative, ref, collect=True)
        path = self._file(relative)
        if not 0 < _info(path).st_size <= maximum:
            _fail('DOCUMENT_WORKSPACE_BUDGET')
        with path.open('rb') as stream:
            data = stream.read(maximum + 1)
        if len(data) > maximum:
            _fail('DOCUMENT_WORKSPACE_BUDGET')
        return data

    def _page(self, manifest, index):
        if (not manifest.get('prepared') or type(index) is not int
                or not 1 <= index <= len(manifest['pages'])):
            _fail('DOCUMENT_WORKSPACE_MISSING')
        return manifest['pages'][index - 1]

    def prepare(self, source_ref, source_type, download_callback, check=None, require_sandbox=None):
        """Download once, then atomically publish the complete normalized manifest.

        download_callback(ref, target_path, check) must bound the streamed bytes
        to ref.byte_size. It receives a new private path, never an existing file.
        """
        ref = _ref(source_ref, maximum=MAX_SOURCE_BYTES)
        kind = {'application/pdf': 'pdf', 'application/zip': 'zip', 'cbz': 'zip'}.get(source_type, source_type)
        if kind not in {'pdf', 'zip'} or ref['mime'] != {'pdf': 'application/pdf', 'zip': 'application/zip'}[kind]:
            _fail('DOCUMENT_FORMAT_MISMATCH')
        sandbox = self.require_sandbox if require_sandbox is None else require_sandbox
        with self._spool.lock:
            _check(check)
            manifest = self._load()
            if manifest.get('source') not in (None, ref) or manifest.get('source_type') not in (None, kind):
                _fail()
            if manifest.get('prepared'):
                for row in manifest['pages']:
                    saved = _ref(row['input_ref'], maximum=self.limits.max_page_bytes, mime='image/png')
                    self._verify(f"pages/{row['page_index']:04}.png", saved, check=check)
                return [{**row['input_ref'], 'page_index': row['page_index'], 'source_name': row['source_name']}
                        for row in manifest['pages']]
            source = self._file('source.bin')
            try:
                if not source.exists():
                    temporary = self._file('source.bin.part')
                    self._unlink(temporary)
                    self._spool.require(ref['byte_size'], self.limits.max_spool_bytes)
                    download_callback(source_ref, temporary, check or (lambda: None))
                    self._verify('source.bin.part', ref, check=check)
                    with temporary.open('r+b') as stream:
                        os.fsync(stream.fileno())
                    os.replace(temporary, source)
                    _fsync_directory(self.path)
                    self._spool.record(source, ref['byte_size'])
                else:
                    self._verify('source.bin', ref, check=check)
                manifest.update(source=ref, source_type=kind)
                self._save(manifest)
                pages_dir = self.path / 'pages'
                if pages_dir.exists():
                    self._remove(pages_dir)
                _directory(pages_dir, create=True)
                # Budget source + all already retained workspaces + parser IPC
                # and the next atomic manifest, not merely this page/job.
                available = self.limits.max_spool_bytes - self._spool.used - MAX_IPC_BYTES - MAX_MANIFEST_BYTES
                self._spool.require(MAX_IPC_BYTES + MAX_MANIFEST_BYTES, self.limits.max_spool_bytes)
                limits = replace(self.limits, max_spool_bytes=ref['byte_size'] + available)
                rows = run_file_operation('normalize', source, kind, pages_dir, limits=limits,
                    check_cancelled=check, require_sandbox=sandbox)
                if not 1 <= len(rows) <= MAX_PAGES:
                    _fail('DOCUMENT_INCOMPLETE_PAGES')
                pages = []
                for index, row in enumerate(rows, 1):
                    if row.get('page_index') != index:
                        _fail('DOCUMENT_INCOMPLETE_PAGES')
                    page_ref = _ref(row, maximum=self.limits.max_page_bytes, mime='image/png')
                    path = self._verify(f'pages/{index:04}.png', page_ref, check=check)
                    with path.open('r+b') as stream:
                        os.fsync(stream.fileno())
                    pages.append({'page_index': index, 'source_name': row['source_name'], 'input_ref': page_ref})
                _fsync_directory(pages_dir)
                self._spool.refresh(self.path)
                manifest.update(prepared=True, pages=pages)
                self._save(manifest)
                return [{**row['input_ref'], 'page_index': row['page_index'], 'source_name': row['source_name']}
                        for row in pages]
            finally:
                self._spool.refresh(self.path)

    def input(self, page_index, ref=None):
        with self._spool.lock:
            row = self._page(self._load(), page_index)
            saved = _ref(row['input_ref'], maximum=self.limits.max_page_bytes, mime='image/png')
            if ref is not None and not _same(saved, ref):
                _fail()
            return self._verify(f'pages/{page_index:04}.png', saved, collect=True)

    def save_analysis(self, page_index, analysis):
        data = _json(analysis, MAX_CHECKPOINT_BYTES)
        with self._spool.lock:
            manifest = self._load()
            row = self._page(manifest, page_index)
            self._analysis_identity(analysis, row)
            # Bind the small central text payload without rereading a multi-MB
            # masks checkpoint immediately after writing it.
            row['segments_hash'] = hashlib.sha256(_json(analysis.get('segments'), MAX_CHECKPOINT_BYTES)).hexdigest()
            return self._save_page(manifest, row, 'analysis', data,
                {'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data), 'mime': 'application/json'})

    def _analysis_identity(self, analysis, row):
        if (not isinstance(analysis, dict) or analysis.get('input_hash') != row['input_ref']['sha256']
                or analysis.get('width') != row['input_ref']['width']
                or analysis.get('height') != row['input_ref']['height']):
            _fail()

    def analysis(self, page_index, ref=None):
        with self._spool.lock:
            row = self._page(self._load(), page_index)
            if not row.get('analysis_ref'):
                _fail('DOCUMENT_WORKSPACE_MISSING')
            saved = _ref(row['analysis_ref'], maximum=MAX_CHECKPOINT_BYTES, mime='application/json')
            if ref is not None and not _same(saved, ref):
                _fail()
            try:
                value = json.loads(self._read(f'analysis/{page_index:04}.json', maximum=MAX_CHECKPOINT_BYTES, ref=saved))
            except (ValueError, UnicodeError):
                _fail()
            self._analysis_identity(value, row)
            return value

    def _save_page(self, manifest, row, kind, data, ref):
        if row.get(kind + '_ref') not in (None, ref):
            _fail()
        _directory(self.path / kind, create=True)
        extension = 'json' if kind == 'analysis' else 'png'
        relative = f"{kind}/{row['page_index']:04}.{extension}"
        if row.get(kind + '_ref'):
            self._verify(relative, ref)
            return ref
        self._atomic(relative, data)
        row[kind + '_ref'] = ref
        self._save(manifest)
        return ref

    def save_output(self, page_index, data, ref):
        ref = _ref(ref, maximum=self.limits.max_page_bytes, mime='image/png')
        # Fresh bytes/metadata come together from the shared full-PNG encoder.
        # Reuse its digest; recovered files are verified before reuse/packaging.
        if len(data) != ref['byte_size']:
            _fail()
        _png_dimensions(data[:24], ref, self.limits)
        with self._spool.lock:
            manifest = self._load()
            row = self._page(manifest, page_index)
            if any(ref[name] != row['input_ref'][name] for name in ('width', 'height')):
                _fail()
            return self._save_page(manifest, row, 'output', data, ref)

    def checkpoint(self, page_index, action):
        return self._checkpoint(page_index, action, verify_files=True)

    def _checkpoint(self, page_index, action, *, verify_files):
        if action not in _ACTIONS:
            _fail()
        with self._spool.lock:
            row = self._page(self._load(), page_index)
            ref = (row.get('checkpoints') or {}).get(action)
            if ref is None:
                return None
            saved = _ref(ref, maximum=MAX_CHECKPOINT_BYTES, mime='application/json')
            try:
                value = json.loads(self._read(f'{_ACTIONS[action]}/{page_index:04}.complete.json',
                    maximum=MAX_CHECKPOINT_BYTES, ref=saved))
            except (ValueError, UnicodeError):
                _fail()
            self._validate_checkpoint(row, action, value, verify_files=verify_files)
            return value

    def _validate_checkpoint(self, row, action, body, *, verify_files):
        # Only completion payloads belong here, never tokens, URLs or leases.
        if not isinstance(body, dict) or set(body) - {'analysis_ref', 'output_ref', 'text', 'no_text', 'quality_flags'}:
            _fail()
        if action == 'doc_ocr':
            if (not body.get('analysis_ref') or not isinstance(body.get('text'), dict)
                    or body.get('output_ref') is not None
                    or body['text'].get('page_index') != row['page_index']
                    or body['text'].get('analysis_hash') != body['analysis_ref'].get('sha256')
                    or not isinstance(body['text'].get('segments'), list)
                    or bool(body.get('no_text')) != (not body['text']['segments'])):
                _fail()
            if hashlib.sha256(_json(body['text']['segments'], MAX_CHECKPOINT_BYTES)).hexdigest() != row.get('segments_hash'):
                _fail()
            artifacts = {'analysis': body['analysis_ref']}
        else:
            if (not body.get('output_ref') or body.get('analysis_ref') is not None
                    or body.get('text') is not None or body.get('no_text')):
                _fail()
            artifacts = {'output': body['output_ref']}
        if type(body.get('no_text', False)) is not bool:
            _fail()
        for kind, ref in artifacts.items():
            saved = row.get(kind + '_ref')
            if kind == 'output' and not saved and _same(row['input_ref'], ref):
                saved = row['input_ref']
                relative = f"pages/{row['page_index']:04}.png"
            else:
                relative = f"{kind}/{row['page_index']:04}.{'json' if kind == 'analysis' else 'png'}"
            if saved is None or not _same(saved, ref):
                _fail()
            saved = _ref(saved, maximum=MAX_CHECKPOINT_BYTES if kind == 'analysis' else self.limits.max_page_bytes,
                mime='application/json' if kind == 'analysis' else 'image/png')
            if not verify_files:
                continue
            if kind == 'analysis':
                try:
                    value = json.loads(self._verify(relative, saved, collect=True))
                except (ValueError, UnicodeError):
                    _fail()
                if value.get('segments') != body['text']['segments']:
                    _fail()
            else:
                self._verify(relative, saved)

    def save_checkpoint(self, page_index, action, body):
        if action not in _ACTIONS:
            _fail()
        data = _json(body, MAX_CHECKPOINT_BYTES)
        with self._spool.lock:
            manifest = self._load()
            row = self._page(manifest, page_index)
            self._validate_checkpoint(row, action, body, verify_files=False)
            _directory(self.path / _ACTIONS[action], create=True)
            relative = f'{_ACTIONS[action]}/{page_index:04}.complete.json'
            ref = {'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data), 'mime': 'application/json'}
            previous = row.setdefault('checkpoints', {}).get(action)
            if previous is not None:
                if previous != ref:
                    _fail()
                self._verify(relative, ref)
                return
            self._atomic(relative, data)
            row['checkpoints'][action] = ref
            self._save(manifest)

    def package(self, pages=None, check=None):
        with self._spool.lock:
            _check(check)
            manifest = self._load()
            if not manifest.get('prepared') or not manifest['pages']:
                _fail('DOCUMENT_WORKSPACE_MISSING')
            pages = pages if pages is not None else [{'page_index': row['page_index'],
                'output_ref': row.get('output_ref')} for row in manifest['pages']]
            if [page.get('page_index') for page in pages] != list(range(1, len(manifest['pages']) + 1)):
                _fail('DOCUMENT_INCOMPLETE_PAGES')
            refs = [{'page_index': page['page_index'], 'output_ref': _ref(page.get('output_ref'),
                maximum=self.limits.max_page_bytes, mime='image/png')} for page in pages]
            pages_hash = hashlib.sha256(_json(refs, MAX_MANIFEST_BYTES)).hexdigest()
            if manifest.get('result'):
                if manifest.get('result_pages_hash') != pages_hash:
                    _fail()
                ref = _ref(manifest['result'], maximum=self.limits.max_output_bytes, mime='application/zip')
                path = self._file('result.zip')
                if _info(path).st_size != ref['byte_size']:
                    _fail()
                # upload_file verifies the recovered ZIP on its open fd before
                # PUT. Do not reread every PNG and the same ZIP here as well.
                return path, ref
            entries = []
            for page, row in zip(refs, manifest['pages'], strict=True):
                ref = page['output_ref']
                folder = 'output' if row.get('output_ref') == ref else 'pages' if row['input_ref'] == ref else None
                if folder is None:
                    _fail()
                completed = self._checkpoint(row['page_index'], 'doc_ocr' if folder == 'pages' else 'doc_render',
                                             verify_files=False)
                if completed is None or folder == 'pages' and not completed.get('no_text'):
                    _fail('DOCUMENT_INCOMPLETE_PAGES')
                path = self._file(f"{folder}/{row['page_index']:04}.png")
                if _info(path).st_size != ref['byte_size']:
                    _fail()
                entries.append({**ref, 'page_index': row['page_index'], 'path': path})
            temporary, destination = self._file('result.zip.part'), self._file('result.zip')
            self._unlink(temporary)
            self._unlink(destination)  # An uncommitted complete/partial ZIP is not a result.
            available = self.limits.max_spool_bytes - self._spool.used - MAX_MANIFEST_BYTES
            self._spool.require(MAX_MANIFEST_BYTES, self.limits.max_spool_bytes)
            try:
                output = package_zip(entries, temporary, store=None,
                    limits=replace(self.limits, max_spool_bytes=available), check_cancelled=check)
                ref = _ref(output, maximum=self.limits.max_output_bytes, mime='application/zip')
                with temporary.open('r+b') as stream:
                    os.fsync(stream.fileno())
                os.replace(temporary, destination)
                _fsync_directory(self.path)
                self._spool.record(destination, ref['byte_size'])
                manifest.update(result=ref, result_pages_hash=pages_hash)
                self._save(manifest)
                return destination, ref
            finally:
                self._spool.refresh(self.path)

    def _remove(self, directory):
        if directory == self._spool.root or not directory.is_relative_to(self.path):
            _fail('DOCUMENT_WORKSPACE_UNSAFE')
        _directory(directory)
        files = _walk(directory)  # Validate every entry before deleting anything.
        for path in files:
            self._unlink(path)
        for current, directories, _ in os.walk(directory, topdown=False, followlinks=False):
            for name in directories:
                path = Path(current) / name
                _info(path, directory=True)
                path.rmdir()
        directory.rmdir()
        _fsync_directory(directory.parent)

    def cleanup(self):
        """Caller must have the center's terminal-generation cleanup authority."""
        with self._spool.lock:
            if _info(self.path, directory=True, missing=True) is None:
                return
            if _info(self.path / 'manifest.json', missing=True) is not None:
                self._load()  # Exact owner/job/generation, never another workspace.
            self._remove(self.path)
            try:
                self.path.parent.rmdir()  # Only if no other generation remains.
            except OSError:
                pass
