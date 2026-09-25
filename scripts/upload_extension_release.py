"""Upload one verified extension ZIP or AMO-signed XPI to immutable R2 storage.

Run with the backend dependencies and production R2 environment. No bucket
permissions are changed; output contains public package metadata only.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import sys
import zipfile
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
sys.path.insert(0, '/app')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--zip', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--browser', required=True, choices=['chrome', 'edge', 'firefox'])
    args = parser.parse_args()
    from app.storage import get_store
    from botocore.exceptions import ClientError
    catalog = json.loads(args.manifest.read_text(encoding='utf-8'))
    matches = [item for item in catalog['releases'] if item['version'] == catalog['current'] and item['browser'] == args.browser]
    assert len(matches) == 1
    release = matches[0]
    suffix = 'xpi' if args.browser == 'firefox' else 'zip'
    content_type = 'application/x-xpinstall' if args.browser == 'firefox' else 'application/zip'
    assert release.get('content_type', 'application/zip') == content_type
    assert release['filename'] == f'node-comics-{release["version"]}-{args.browser}.{suffix}'
    assert release['path'] == '/downloads/' + release['filename']
    data = args.zip.read_bytes()
    assert len(data) == release['bytes']
    assert hashlib.sha256(data).hexdigest() == release['sha256']
    with zipfile.ZipFile(args.zip) as archive:
        assert archive.testzip() is None
        manifest = json.loads(archive.read('manifest.json'))
        assert manifest['version'] == release['version'] and manifest['manifest_version'] == 3
        if args.browser == 'firefox':
            assert manifest['browser_specific_settings']['gecko']['id'] == 'comics@nodelane.net'
            assert {'META-INF/mozilla.rsa', 'META-INF/mozilla.sf', 'META-INF/manifest.mf'} <= set(archive.namelist())
            # Signature filenames alone cannot establish authenticity; require the exact public AMO hash.
            with urlopen('https://addons.mozilla.org/api/v5/addons/addon/nodelane-comics/', timeout=30) as response:
                addon = json.load(response)
            published = addon['current_version']
            assert addon['guid'] == 'comics@nodelane.net' and published['version'] == release['version']
            assert published['file']['status'] == 'public'
            assert published['file']['hash'] == 'sha256:' + release['sha256']
            assert published['file']['size'] == release['bytes']
        else:
            # Chromium downloads preserve the fixed identity; store-submission ZIPs do not.
            assert isinstance(manifest.get('key'), str) and manifest['key']
            identity = ''.join(chr(97 + int(c, 16)) for c in hashlib.sha256(base64.b64decode(manifest['key'], validate=True)).hexdigest()[:32])
            assert identity == {'chrome': 'aiajdjliifeeaogpalejpggkiccjbneo', 'edge': 'haelhcdomcfllhpfjdpbejccbjcdeaig'}[args.browser]
            assert 'browser_specific_settings' not in manifest
        assert 'https://comics.nodelane.net' in archive.read('background.js').decode()
        assert not any(name.endswith(('.map', '.pem')) or '/.env' in name for name in archive.namelist())
    key = f'releases/extensions/{release["version"]}/{release["sha256"]}/{release["filename"]}'
    store = get_store('r2')
    params = store._params(key)
    try:
        store.client.put_object(**params, Body=data, ContentType=content_type,
            ContentDisposition=f'attachment; filename="{release["filename"]}"',
            CacheControl='private, no-store', Metadata={'sha256': release['sha256']}, IfNoneMatch='*')
    except ClientError as error:
        if error.response.get('ResponseMetadata', {}).get('HTTPStatusCode') != 412:
            raise
    obj = store.client.get_object(**params)
    try:
        assert hashlib.sha256(obj['Body'].read()).hexdigest() == release['sha256']
        assert obj['ContentType'] == content_type
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
