"""Upload one verified extension ZIP to a separate, immutable R2 release prefix.

Run with the backend dependencies and production R2 environment. No bucket
permissions are changed; output contains public package metadata only.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
sys.path.insert(0, '/app')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--zip', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    args = parser.parse_args()
    from app.storage import get_store
    from botocore.exceptions import ClientError
    catalog = json.loads(args.manifest.read_text(encoding='utf-8'))
    release = next(item for item in catalog['releases'] if item['version'] == catalog['current'])
    data = args.zip.read_bytes()
    assert len(data) == release['bytes']
    assert hashlib.sha256(data).hexdigest() == release['sha256']
    with zipfile.ZipFile(args.zip) as archive:
        assert archive.testzip() is None
        manifest = json.loads(archive.read('manifest.json'))
        assert manifest['version'] == release['version'] and manifest['manifest_version'] == 3
        assert 'https://comics.nodelane.net' in archive.read('background.js').decode()
        assert not any(name.endswith(('.map', '.pem')) or '/.env' in name for name in archive.namelist())
    key = f'releases/extensions/{release["version"]}/{release["sha256"]}/{release["filename"]}'
    store = get_store('r2')
    params = store._params(key)
    try:
        store.client.put_object(**params, Body=data, ContentType='application/zip',
            ContentDisposition=f'attachment; filename="{release["filename"]}"',
            CacheControl='private, no-store', Metadata={'sha256': release['sha256']}, IfNoneMatch='*')
    except ClientError as error:
        if error.response.get('ResponseMetadata', {}).get('HTTPStatusCode') != 412:
            raise
    obj = store.client.get_object(**params)
    try:
        assert hashlib.sha256(obj['Body'].read()).hexdigest() == release['sha256']
        assert obj['ContentType'] == 'application/zip'
        assert obj['ContentDisposition'] == f'attachment; filename="{release["filename"]}"'
    finally:
        obj['Body'].close()
    print(json.dumps({'uploaded_and_verified': True, **release}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # SDK diagnostics may contain signed URLs or private configuration.
        print(json.dumps({'error_type': type(error).__name__}), file=sys.stderr)
        raise SystemExit(1) from None
