"""Render an online Vast template from a published source commit."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.request import HTTPRedirectHandler, build_opener

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
BOOTSTRAP_PATH = 'services/compute-node/linux/vast_bootstrap.py'
TEMPLATE_PATH = 'services/compute-node/linux/vast-template.json'
RAW_ORIGIN = 'https://raw.githubusercontent.com'
PLACEHOLDERS = ('REPLACE_WITH_BOOTSTRAP_SHA256', 'REPLACE_WITH_VERSIONED_BOOTSTRAP_URL',
                'REPLACE_WITH_SOURCE_COMMIT')


class PinnedHostRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        if not newurl.startswith(RAW_ORIGIN + '/'):
            raise ValueError('Bootstrap redirects must remain on the HTTPS GitHub raw host')
        return super().redirect_request(request, response, code, message, headers, newurl)


def git_blob(revision, path):
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Use a full published Git commit SHA')
    try:
        return subprocess.check_output(['git', '-C', str(REPOSITORY_ROOT), 'show',
            f'{revision}:{path}'], stderr=subprocess.PIPE)
    except (OSError, subprocess.CalledProcessError):
        raise ValueError('The selected commit must contain the deployment files in this Git repository') from None


def published_bootstrap(revision):
    content = git_blob(revision, BOOTSTRAP_PATH)
    url = f'{RAW_ORIGIN}/Wy2926/node-comics/{revision}/{BOOTSTRAP_PATH}'
    try:
        with build_opener(PinnedHostRedirects()).open(url, timeout=30) as response:
            # One extra byte detects oversized responses without an unbounded download.
            remote = response.read(len(content) + 1)
    except OSError:
        raise ValueError('The published bootstrap is unavailable; publish the commit and retry') from None
    if remote != content:
        raise ValueError('Published bootstrap does not match the selected Git commit blob')
    return url, hashlib.sha256(content).hexdigest()


def render(revision):
    result = json.loads(git_blob(revision, TEMPLATE_PATH))
    if (not isinstance(result, dict) or not isinstance(result.get('onstart'), str)
            or not all(key in result['onstart'] for key in PLACEHOLDERS)):
        raise ValueError('Selected commit has an unsupported template; use the pinned online source protocol')
    url, checksum = published_bootstrap(revision)
    replacements = {
        'REPLACE_WITH_BOOTSTRAP_SHA256': checksum,
        'REPLACE_WITH_VERSIONED_BOOTSTRAP_URL': url,
        'REPLACE_WITH_SOURCE_COMMIT': revision,
    }
    for key, value in replacements.items():
        result['onstart'] = result['onstart'].replace(key, value)
    result['name'] = 'Node Comics CUDA - ' + revision[:12]
    result['desc'] = 'Pinned source commit; public bootstrap bytes verified at template generation.'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = render(args.revision)
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(json.dumps({'template': str(args.output), 'published': False, 'remote_bootstrap_verified': True}))


if __name__ == '__main__':
    main()
