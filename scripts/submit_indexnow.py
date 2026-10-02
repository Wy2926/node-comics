"""Notify IndexNow of explicitly selected, recently changed public website URLs.

Default: verify the deployed key and live sitemap, then print a dry-run payload.
Use --submit to send it once. HTTP 200/202 never prove that a URL was indexed.
Protocol: https://www.indexnow.org/documentation
"""
import argparse
import json
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import xml.etree.ElementTree as ET


ORIGIN = 'https://comics.nodelane.net'
# Public ownership verification value, served by the website's static release.
KEY = 'b1518b5f47e4461c9b5e379c3ebbfecb'
KEY_LOCATION = f'{ORIGIN}/{KEY}.txt'
ENDPOINT = 'https://api.indexnow.org/indexnow'
USER_AGENT = f'Mozilla/5.0 (compatible; NodeLaneIndexNow/1.0; +{ORIGIN}/)'


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get_public(opener, url, limit):
    with opener.open(Request(url, headers={'User-Agent': USER_AGENT}), timeout=20) as response:
        if response.status != 200:
            raise ValueError(f'Preflight requires HTTP 200: {url}')
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError(f'Preflight response exceeds size limit: {url}')
        return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('urls', nargs='+', help='Full canonical URLs recently added or updated; no automatic all-site submission')
    parser.add_argument('--submit', action='store_true', help='Send one POST after public-key and sitemap verification')
    args = parser.parse_args()
    urls = list(dict.fromkeys(args.urls))
    for url in urls:
        try:
            parsed = urlsplit(url)
        except ValueError:
            parser.error('Invalid URL')
        if (parsed.scheme != 'https' or parsed.netloc != 'comics.nodelane.net'
                or parsed.query or parsed.fragment or not parsed.path.startswith('/')
                or any(character.isspace() for character in url)):
            parser.error(f'Only canonical HTTPS URLs on {ORIGIN} without query or fragment are allowed')
    if len(urls) > 10_000:
        parser.error('IndexNow permits at most 10,000 URLs per request')

    opener = build_opener(NoRedirects())
    phase = 'preflight'
    try:
        key_text = get_public(opener, KEY_LOCATION, 1024).decode('utf-8')
        if key_text.strip() != KEY:
            raise ValueError('Deployed public key text does not match; no POST sent')
        sitemap = ET.fromstring(get_public(opener, f'{ORIGIN}/sitemap.xml', 1024 * 1024))
        namespace = '{http://www.sitemaps.org/schemas/sitemap/0.9}'
        if sitemap.tag != namespace + 'urlset':
            raise ValueError('Expected a public sitemap URL set; no POST sent')
        public_urls = {item.text for item in sitemap.findall(f'{namespace}url/{namespace}loc')}
        if not set(urls) <= public_urls:
            raise ValueError('Every selected URL must appear exactly in the live public sitemap; no POST sent')
        payload = {'host': 'comics.nodelane.net', 'key': KEY, 'keyLocation': KEY_LOCATION, 'urlList': urls}
        if not args.submit:
            print(json.dumps({'mode': 'dry_run', 'key_verified': True, 'endpoint': ENDPOINT,
                              'payload': payload, 'post_sent': False}, ensure_ascii=False, indent=2))
            return 0

        phase = 'submission'
        request = Request(ENDPOINT, data=json.dumps(payload).encode('utf-8'), method='POST',
                          headers={'User-Agent': USER_AGENT, 'Content-Type': 'application/json; charset=utf-8'})
        with opener.open(request, timeout=30) as response:
            status = response.status
        if status not in (200, 202):
            raise ValueError(f'Unexpected IndexNow HTTP status: {status}')
        print(json.dumps({'mode': 'submit', 'http_status': status, 'url_count': len(urls),
                          'result': 'received' if status == 200 else 'received_key_validation_pending',
                          'indexed': 'not_verified'}, ensure_ascii=False, indent=2))
        return 0
    except HTTPError as error:
        reasons = {400: 'invalid_request', 403: 'invalid_or_unreachable_key',
                   422: 'invalid_url_host_or_key', 429: 'rate_limited'}
        print(json.dumps({'phase': phase, 'http_status': error.code,
                          'target': error.url,
                          'error': reasons.get(error.code, 'http_error') if phase == 'submission' else 'public_preflight_http_error',
                          'retry_after': error.headers.get('Retry-After'),
                          'post_sent': phase == 'submission', 'indexed': 'not_verified'}), file=sys.stderr)
    except (URLError, TimeoutError, OSError) as error:
        print(json.dumps({'phase': phase, 'error': type(error).__name__,
                          'post_outcome': 'unknown' if phase == 'submission' else 'not_sent'}), file=sys.stderr)
    except (ValueError, ET.ParseError) as error:
        print(json.dumps({'phase': phase, 'error': str(error),
                          'post_sent': phase == 'submission'}), file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
