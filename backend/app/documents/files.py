"""Backend settings adapter for the shared, isolated document parser."""
import comic_document_files as _files
from comic_document_files import DocumentFileError, MAX_IPC_BYTES, shutil, subprocess

from .config import get_document_settings


class FileLimits(_files.FileLimits):
    @classmethod
    def configured(cls):
        config = get_document_settings()
        return cls(**{name: getattr(config, name) for name in cls.__dataclass_fields__})


def scan_source(path, source_type, *, limits=None):
    return _files.scan_source(path, source_type, limits=limits or FileLimits.configured())


def normalize_pages(path, source_type, directory, *, manifest=None, limits=None, check_cancelled=None):
    return _files.normalize_pages(path, source_type, directory, manifest=manifest,
        limits=limits or FileLimits.configured(), check_cancelled=check_cancelled)


def package_zip(pages, destination, *, store=None, limits=None, check_cancelled=None):
    return _files.package_zip(pages, destination, store=store,
        limits=limits or FileLimits.configured(), check_cancelled=check_cancelled)


def check_parser_sandbox():
    config = get_document_settings()
    return _files.check_parser_sandbox(config.spool_path, require_sandbox=config.parser_require_sandbox)


def run_file_operation(action, source, source_type, directory=None, manifest=None, *, limits=None,
                       timeout=None, check_cancelled=None, require_sandbox=None):
    config = get_document_settings()
    return _files.run_file_operation(action, source, source_type, directory, manifest,
        limits=limits or FileLimits.configured(),
        timeout=config.prepare_timeout_seconds if timeout is None else timeout,
        require_sandbox=config.parser_require_sandbox if require_sandbox is None else require_sandbox,
        check_cancelled=check_cancelled)
