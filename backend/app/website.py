"""Public static website, mounted after every API and private console route."""
import base64
from functools import lru_cache
import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles
from starlette.responses import FileResponse, RedirectResponse, Response
from .config import settings
from .storage import get_store, StorageError

ROOT = Path(__file__).parent / 'website_dist'
RELEASES = json.loads((Path(__file__).parent.parent / 'extension-release.json').read_text(encoding='utf-8'))['releases']


class _Scripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.collect = False
        self.parts = []
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.collect = not dict(attrs).get('src')
            self.parts = []

    def handle_data(self, data):
        if self.collect:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.collect:
            self.scripts.append(''.join(self.parts))
            self.collect = False


@lru_cache(maxsize=256)
def script_hashes(path: str, modified: int):
    parser = _Scripts()
    parser.feed(Path(path).read_text(encoding='utf-8'))
    return ' '.join("'sha256-" + base64.b64encode(hashlib.sha256(script.encode()).digest()).decode() + "'" for script in parser.scripts)


class WebsiteFiles(StaticFiles):
    def __init__(self, directory=ROOT):
        super().__init__(directory=directory, html=True, check_dir=False)

    async def check_config(self):
        # An unbuilt local checkout keeps the API usable and returns a real 404.
        return

    async def get_response(self, path, scope):
        normalized = path.replace('\\', '/').lstrip('/')
        segments = normalized.split('/')
        if segments[0] == 'downloads':
            release = next((item for item in RELEASES if item['path'] == '/' + normalized), None)
            if release is None:
                raise HTTPException(404)
            headers = {'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
                       'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow'}
            scope.setdefault('state', {})['public_website'] = True
            if scope['method'] == 'HEAD':
                return Response(headers={**headers, 'Content-Type': 'application/zip',
                    'Content-Length': str(release['bytes']),
                    'Content-Disposition': f'attachment; filename="{release["filename"]}"'})
            if scope['method'] != 'GET':
                return Response(status_code=405, headers={**headers, 'Allow': 'GET, HEAD'})
            key = f'releases/extensions/{release["version"]}/{release["sha256"]}/{release["filename"]}'
            try:
                url = get_store('r2').download_url(key, 600)
                if not url:
                    raise StorageError()
            except StorageError:
                return Response('Download temporarily unavailable. Please try again later.', status_code=503,
                                headers={**headers, 'Retry-After': '60'}, media_type='text/plain')
            return RedirectResponse(url, status_code=302, headers=headers)
        # Removed API/payment routes must not fall through to static-site routing.
        if segments[0] in {'v1', 'internal', 'webhooks', 'billing'}:
            raise HTTPException(404)
        if any(segment.startswith('.') and segment != '.' for segment in segments):
            raise HTTPException(404)
        suffix = Path(path).suffix.lower()
        if suffix and suffix not in {'.html', '.css', '.js', '.webp', '.png', '.jpg', '.svg', '.ico', '.xml', '.txt', '.woff2'}:
            raise HTTPException(404)
        if normalized.endswith('index.html'):
            target = '/' + normalized[:-len('index.html')]
            query = scope.get('query_string', b'').decode('latin-1')
            return RedirectResponse(target + ('?' + query if query else ''), status_code=308)
        response = await super().get_response(path, scope)
        if response.status_code == 404 and segments[0] in {'zh-tw', 'en', 'ja', 'ko'}:
            localized, info = self.lookup_path(segments[0] + '/404/index.html')
            if info:
                response = FileResponse(localized, status_code=404, stat_result=info)
        if response.status_code == 307:
            response.status_code = 308
        if normalized == '404.html' or '404' in segments:
            response.status_code = 404
        scope.setdefault('state', {})['public_website'] = True
        private_page = any(segment in {'account', 'auth', 'payment'} for segment in segments)
        response.headers['Cache-Control'] = ('private, no-store' if private_page or response.status_code >= 400 else
            'public, max-age=31536000, immutable' if normalized.startswith('_astro/') else 'public, max-age=0, must-revalidate')
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        if private_page or response.status_code >= 400:
            response.headers['X-Robots-Tag'] = 'noindex, nofollow'
        if 'text/html' in response.headers.get('content-type', ''):
            file = Path(response.path)
            hashes = script_hashes(str(file), file.stat().st_mtime_ns)
            identity = urlsplit(settings().oidc_token_endpoint)
            identity_origin = f'{identity.scheme}://{identity.netloc}' if identity.scheme in {'https', 'http'} and identity.netloc else ''
            response.headers['Content-Security-Policy'] = (
                f"default-src 'self'; script-src 'self' {hashes}; style-src 'self' 'unsafe-inline'; "
                f"img-src 'self' data:; font-src 'self'; connect-src 'self' {identity_origin}; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; frame-src 'none'")
        return response
