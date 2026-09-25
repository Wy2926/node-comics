"""Standard-library helpers for isolated Windows builds."""
import csv
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import time
import urllib.request
import zipfile


def sha256(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def event(stage, **values):
    print(json.dumps({'stage': stage, **values}), flush=True)


def download(url, checksum, target):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        event('download', file=target.name)
        temporary = target.with_name(target.name + '.partial')
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={'User-Agent': 'NodeComics-Build/1'})
                with urllib.request.urlopen(request, timeout=120) as response, temporary.open('wb') as output:
                    shutil.copyfileobj(response, output, 1024 * 1024)
                break
            except OSError:
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        if sha256(temporary) != checksum:
            raise ValueError(f'Download checksum mismatch: {target.name}')
        temporary.replace(target)
    if sha256(target) != checksum:
        raise ValueError(f'Cached input checksum mismatch: {target.name}')
    return target


def safe_extract_zip(archive, destination):
    destination = Path(destination).resolve()
    with zipfile.ZipFile(archive) as package:
        for info in package.infolist():
            path = (destination / info.filename).resolve()
            if not path.is_relative_to(destination) or (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Unsafe archive entry')
        package.extractall(destination)


def copy_sources(source, target):
    shutil.copytree(source, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.env*', '*.log', '*.sqlite*'))
    # Git autocrlf must not change engine identity.
    for path in Path(target).rglob('*'):
        if path.is_file() and path.suffix in ('.py', '.go', '.json', '.toml', '.md', '.txt', '.lock'):
            path.write_bytes(path.read_bytes().replace(b'\r\n', b'\n'))


def build_environment(work, go_root=None):
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(('UV_', 'PIP_', 'PYTHON', 'GO')) and key.upper() not in ('NODE_TOKEN', 'VIRTUAL_ENV')}
    env.update(UV_CACHE_DIR=str(work / 'uv-cache'), UV_PYTHON_DOWNLOADS='never', UV_LINK_MODE='copy',
               UV_NO_CONFIG='1', PYTHONHASHSEED='0', PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1',
               GOTOOLCHAIN='local', GOCACHE=str(work / 'go-cache'), GOMODCACHE=str(work / 'go-modules'),
               GOPATH=str(work / 'go-path'), CGO_ENABLED='0', GOWORK='off', GOENV='off')
    if go_root:
        env['GOROOT'] = str(go_root)
    return env


def run(args, *, cwd, env, capture=False):
    result = subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True,
                            stdout=subprocess.PIPE if capture else None, encoding='utf-8')
    return result.stdout.strip() if capture else None


def remove_unused_launchers(site):
    """Remove build-path-dependent console scripts; node executes modules directly."""
    directory = site / 'bin'
    if directory.exists():
        if directory.resolve().parent != site.resolve() or directory.is_symlink():
            raise ValueError('Unexpected runtime console script directory')
        shutil.rmtree(directory)
    for record in site.glob('*.dist-info/RECORD'):
        with record.open(encoding='utf-8', newline='') as stream:
            rows = list(csv.reader(stream))
        retained = []
        for row in rows:
            path = (site / row[0]).resolve()
            if path.is_relative_to(site.resolve()) and path.exists():
                retained.append(row)
        with record.open('w', encoding='utf-8', newline='') as stream:
            csv.writer(stream, lineterminator='\n').writerows(sorted(retained))


def archive_release(destination):
    destination = Path(destination).resolve()
    manifest = json.loads((destination / 'release.json').read_text(encoding='utf-8'))
    archive = destination.parent / (destination.name + '.zip')
    temporary = archive.with_suffix('.zip.partial')
    if archive.exists() or temporary.exists():
        raise ValueError('Archive already exists')
    with temporary.open('xb') as raw:
        with zipfile.ZipFile(raw, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as package:
            for name in sorted([*manifest['files'], 'release.json']):
                relative = PurePosixPath(name)
                source = (destination / name).resolve()
                if (relative.is_absolute() or '..' in relative.parts or relative.parts[0].lower() == 'data'
                        or not source.is_relative_to(destination)):
                    raise ValueError('Invalid distribution entry')
                if name != 'release.json' and sha256(source) != manifest['files'][name]:
                    raise ValueError('Release changed since manifest creation')
                info = zipfile.ZipInfo(destination.name + '/' + name, (2024, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info._compresslevel = 1
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                with source.open('rb') as src, package.open(info, 'w', force_zip64=True) as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
    temporary.rename(archive)
    checksum = sha256(archive)
    archive.with_suffix('.zip.sha256').write_text(checksum + '  ' + archive.name + '\n', encoding='ascii')
    event('archive_complete', archive=str(archive), bytes=archive.stat().st_size, sha256=checksum)
    return archive
