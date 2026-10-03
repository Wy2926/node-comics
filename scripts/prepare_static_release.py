"""Prepare immutable website/admin files and an OpenResty include, without activating it.

Only public build output is accepted. Hashed assets are retained across releases so
already-open pages and rollback never lose their chunks. No cleanup is implicit.
"""
import argparse
import base64
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import re
import shutil
from urllib.parse import urlsplit

from switch_release import atomic_write, release_lock

ALLOWED = {'.html', '.css', '.js', '.webp', '.png', '.jpg', '.svg', '.ico', '.xml', '.txt', '.woff2'}


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.parts, self.hashes, self.collect = [], [], False

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.collect, self.parts = not dict(attrs).get('src'), []

    def handle_data(self, data):
        if self.collect:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.collect:
            digest = base64.b64encode(hashlib.sha256(''.join(self.parts).encode()).digest()).decode()
            self.hashes.append("'sha256-" + digest + "'")
            self.collect = False


def headers(release, *, private=False, immutable=False, csp=None):
    cache = 'private, no-store' if private else ('public, max-age=31536000, immutable' if immutable
                                               else 'public, max-age=0, must-revalidate')
    values = {'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
              'Strict-Transport-Security': 'max-age=31536000', 'X-Static-Release': release}
    if private:
        values['X-Robots-Tag'] = 'noindex, nofollow'
    if csp:
        values['Content-Security-Policy'] = csp
    return '\n'.join(f'    add_header {key} "{value}"' + ('' if immutable and key == 'Cache-Control' else ' always') + ';'
                     for key, value in values.items())


def block(uri, body):
    return f'location = {uri} {{\n    if ($request_method !~ "^(GET|HEAD)$") {{ return 405; }}\n{body}\n}}\n'


def prepare(kind, source, destination, release, nginx_root, *, admin_path='', oidc_origin='', manifest=None):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', release):
        raise ValueError('Invalid release ID')
    if not re.fullmatch(r'/[A-Za-z0-9_/-]+', nginx_root) or '..' in PurePosixPath(nginx_root).parts:
        raise ValueError('nginx-root must be an absolute safe container-visible path')
    if oidc_origin and not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]+)?', oidc_origin):
        raise ValueError('OIDC origin must be a bare HTTPS origin')
    reserved = {'admin', 'v1', 'internal', 'health', 'docs', 'redoc', 'api', 'openapi', 'account', 'auth',
                'features', 'pricing', 'download', 'downloads', 'guides', 'faq', 'help', 'about', 'changelog',
                'privacy', 'terms', 'refund', 'zh-tw', 'en', 'ja', 'ko', 'fr', 'es', 'pt-br', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id', 'webhooks', 'billing', 'payment',
                'uninstall', 'drive-connect', 'translate'}
    if kind == 'admin' and (not re.fullmatch(r'/[A-Za-z0-9][A-Za-z0-9_-]{1,79}/', admin_path)
                            or admin_path.strip('/').lower() in reserved):
        raise ValueError('Explicit non-reserved private /name/ entry required')
    source, destination = source.resolve(), destination.resolve()
    target = destination / 'releases' / kind / release
    if target.exists():
        raise ValueError('Release already exists; immutable releases cannot be overwritten')
    if not (source / 'index.html').is_file():
        raise ValueError('Missing build index.html')
    files = []
    for path in sorted(source.rglob('*')):
        relative = path.relative_to(source).as_posix()
        if path.is_symlink():
            raise ValueError('Symlinks are not public build assets')
        if path.is_file():
            if any(part.startswith('.') for part in path.relative_to(source).parts) or path.suffix not in ALLOWED:
                raise ValueError('Unexpected non-public build file')
            if not re.fullmatch(r'[A-Za-z0-9_./-]+', relative):
                raise ValueError('Unsupported public asset path')
            if kind == 'website' and relative.split('/')[0] in {'v1', 'internal', 'webhooks', 'billing', 'health', 'admin', 'drive-connect'}:
                raise ValueError('Static build collides with a reserved route')
            files.append((path, relative))
    # Do not advertise release readiness until all files and its config exist.
    destination.mkdir(parents=True, exist_ok=True)
    with release_lock(destination):
        if target.exists():
            raise ValueError('Concurrent release preparation')
        target.mkdir(parents=True)
        public = f'{nginx_root}/releases/{kind}/{release}/site'
        configs = [f'# {kind} release {release}\n']
        for path, relative in files:
            copied = target / 'site' / relative
            copied.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, copied)
            asset_prefix = '_astro/' if kind == 'website' else 'assets/'
            if relative.startswith(asset_prefix):
                pooled = destination / 'assets' / kind / relative
                pooled.parent.mkdir(parents=True, exist_ok=True)
                content = path.read_bytes()
                if pooled.exists() and pooled.read_bytes() != content:
                    raise ValueError('Hashed asset collision; refusing to overwrite old resources')
                if not pooled.exists():
                    atomic_write(pooled, content)
        common = headers(release)
        if kind == 'admin':
            csp = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
                   f"connect-src 'self' {oidc_origin}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
            configs.append(block(admin_path.rstrip('/'), f'    return 307 {admin_path}$is_args$args;\n' + headers(release, private=True)))
            configs.append(block(admin_path, f'    root {public};\n    try_files /index.html =404;\n' + headers(release, private=True, csp=csp)))
            configs.append(f'location ^~ {admin_path}assets/ {{\n'
                           '    error_page 404 = @admin_asset_missing;\n'
                           f'    if ($uri !~ "^{admin_path}assets/[A-Za-z0-9_][A-Za-z0-9_.-]*\\.(js|css)$") {{ return 404; }}\n' +
                           f'    alias {nginx_root}/assets/admin/assets/;\n' + headers(release, immutable=True, csp=csp) + '\n}\n')
            configs.append('location @admin_asset_missing {\n    return 404;\n' + headers(release, private=True) + '\n}\n')
            configs.append(f'location {admin_path} {{ return 404; }}\n')
        else:
            for path, relative in files:
                if relative.startswith('_astro/') or relative == 'design-tokens.css':
                    continue  # Design tokens keep the existing shared Picker location.
                uri = '/' + relative
                if path.suffix != '.html':
                    configs.append(block(uri, f'    alias {public}/{relative};\n' + common))
                    continue
                segments = relative.split('/')
                private = any(item in {'account', 'auth', 'payment', 'uninstall', 'translate', '404'} for item in segments) or relative == '404.html'
                parser = Scripts()
                parser.feed(path.read_text(encoding='utf-8'))
                challenge = ' https://challenges.cloudflare.com' if 'translate' in segments else ''
                blobs = ' blob:' if 'translate' in segments else ''
                frames = challenge.strip() or "'none'"
                csp = (f"default-src 'self'; script-src 'self'{challenge} " + ' '.join(parser.hashes) +
                       f"; style-src 'self' 'unsafe-inline'; img-src 'self' data:{blobs}; font-src 'self'; worker-src 'self'; " +
                       f"connect-src 'self' {oidc_origin}{challenge}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; frame-src {frames}")
                response_headers = headers(release, private=private, csp=csp)
                canonical = uri[:-10] if relative.endswith('index.html') else uri
                if relative == '404.html' or '404' in segments:
                    error_uri = '/__static_errors/' + relative
                    configs.append(block(error_uri, f'    internal;\n    alias {public}/{relative};\n' + response_headers))
                    configs.append(block(canonical, f'    error_page 404 {error_uri};\n    return 404;\n' + response_headers))
                else:
                    configs.append(block(canonical, f'    root {public};\n    try_files /{relative} =404;\n' + response_headers))
                if canonical != uri:
                    configs.append(block(uri, f'    return 308 {canonical}$is_args$args;\n' + common))
                    if canonical != '/':
                        configs.append(block(canonical.rstrip('/'), f'    return 308 {canonical}$is_args$args;\n' + common))
            configs.append(f'location ^~ /_astro/ {{\n'
                           '    error_page 404 = @website_asset_missing;\n'
                           '    if ($uri !~ "^/_astro/[A-Za-z0-9_][A-Za-z0-9_.-]*\\.(js|css|woff2|webp|png|jpg|svg)$") { return 404; }\n'
                           f'    alias {nginx_root}/assets/website/_astro/;\n' + headers(release, immutable=True) + '\n}\n')
            configs.append('location @website_asset_missing {\n    return 404;\n' + headers(release, private=True) + '\n}\n')
            for locale in sorted(path.parent.parent.name for path in source.glob('*/404/index.html')):
                error = locale + '/404/index.html'
                if (source / error).is_file():
                    configs.append(f'location /{locale}/ {{ error_page 404 /__static_errors/{error}; return 404; }}\n')
            configs.append('location / { error_page 404 /__static_errors/404.html; return 404; }\n')
            if manifest:
                for row in json.loads(manifest.read_text(encoding='utf-8'))['releases']:
                    path, url = row['path'], row.get('download_url', '')
                    if not re.fullmatch(r'/downloads/[A-Za-z0-9_.-]+', path):
                        raise ValueError('Invalid download path')
                    parsed = urlsplit(url)
                    valid = (parsed.scheme == 'https' and parsed.hostname and not parsed.username and
                             not parsed.password and not parsed.query and not parsed.fragment and
                             re.fullmatch(r'https://[A-Za-z0-9._~:/%+-]+', url))
                    response = f'    return 308 {url};' if valid else '    add_header Retry-After 60 always;\n    return 503;'
                    configs.append(block(path, response + '\n' + headers(release, private=True)))
        atomic_write(target / 'release.inc', ''.join(configs).encode())
    return target / 'release.inc'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['website', 'admin'])
    parser.add_argument('--source', type=Path, required=True, help='Exported site directory')
    parser.add_argument('--destination', type=Path, required=True, help='Host static root')
    parser.add_argument('--nginx-root', default='/www/node-comics', help='Same directory as seen inside OpenResty')
    parser.add_argument('--release', required=True)
    parser.add_argument('--admin-path', default='')
    parser.add_argument('--oidc-origin', default='')
    parser.add_argument('--manifest', type=Path)
    args = parser.parse_args()
    path = prepare(args.kind, args.source, args.destination, args.release, args.nginx_root,
                   admin_path=args.admin_path, oidc_origin=args.oidc_origin, manifest=args.manifest)
    print('Prepared independent static release:', path)


if __name__ == '__main__':
    main()
