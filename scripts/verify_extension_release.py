"""Verify a release package and its configured permanent public download URL.

No upload credentials or application dependencies are used.
The release catalog contains the full public URL supplied by the operator.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import sys
import zipfile
from urllib.request import Request, urlopen



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--zip', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--browser', required=True, choices=['chrome', 'edge', 'firefox'])
    args = parser.parse_args()
    catalog = json.loads(args.manifest.read_text(encoding='utf-8'))
    version = catalog.get('current_by_browser', {}).get(args.browser, catalog['current'])
    matches = [item for item in catalog['releases'] if item['version'] == version and item['browser'] == args.browser]
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
    url = release.get('download_url', '')
    if url:
        from urllib.parse import urlsplit
        parsed = urlsplit(url)
        assert parsed.scheme == 'https' and parsed.hostname
        assert not (parsed.username or parsed.password or parsed.query or parsed.fragment)
        request = Request(url, headers={'User-Agent': 'Mozilla/5.0 NodeComicsReleaseCheck/1.0'})
        with urlopen(request, timeout=60) as response:
            published = response.read(release['bytes'] + 1)
        assert len(published) == release['bytes']
        assert hashlib.sha256(published).hexdigest() == release['sha256']
    print(json.dumps({'package_verified': True, 'public_download_verified': bool(url), **release}))



if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Diagnostics may contain private paths or configuration.
        print(json.dumps({'error_type': type(error).__name__}), file=sys.stderr)
        raise SystemExit(1) from None
