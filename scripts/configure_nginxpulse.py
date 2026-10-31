"""Render the edge proxy from the same private env file used by Docker Compose."""
import argparse
from pathlib import Path
import re
from urllib.parse import urlsplit


def read_settings(path):
    # Only literal, unquoted KEY=value entries: no shell execution/interpolation.
    values = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            key, separator, value = line.partition('=')
            if not separator or key in values:
                raise ValueError('Invalid or duplicate environment key')
            values[key] = value
    origin = values.get('NGINXPULSE_ORIGIN', '')
    if not re.fullmatch(r'https://[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?', origin):
        raise ValueError('NGINXPULSE_ORIGIN must be an HTTPS origin without a path')
    parsed = urlsplit(origin)
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError('Invalid origin port')
    base = values.get('NGINXPULSE_BASE_PATH', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', base) or base.lower() in {
        'api', 'v1', 'internal', 'health', 'auth', 'account', 'payment', 'webhooks',
        'billing', 'drive-connect', 'docs', 'redoc', 'assets', '_astro',
    }:
        raise ValueError('NGINXPULSE_BASE_PATH must be a non-reserved single path segment')
    port = values.get('NGINXPULSE_PORT', '18090')
    if not port.isascii() or not port.isdigit() or not 1024 <= int(port) <= 65535:
        raise ValueError('NGINXPULSE_PORT must be between 1024 and 65535')
    return {'NGINXPULSE_ORIGIN': origin, 'NGINXPULSE_BASE_PATH': base, 'NGINXPULSE_PORT': port}


def render(settings, templates):
    rendered = {}
    for name in ('nginx.http.conf', 'nginx.dashboard.inc'):
        text = (Path(templates) / (name + '.template')).read_text(encoding='utf-8')
        for key, value in settings.items():
            text = text.replace('@' + key + '@', value)
        if re.search(r'@NGINXPULSE_[A-Z_]+@', text):
            raise ValueError('Unresolved proxy template variable')
        rendered[name] = text
    return rendered


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='Staging directory; inspect before installing')
    args = parser.parse_args()
    settings = read_settings(args.env_file)
    templates = Path(__file__).resolve().parents[1] / 'deploy' / 'nginxpulse'
    result = render(settings, templates)
    args.output.mkdir(parents=True, exist_ok=True)
    for name, content in result.items():
        (args.output / name).write_text(content, encoding='utf-8', newline='\n')
    print(settings['NGINXPULSE_ORIGIN'] + '/' + settings['NGINXPULSE_BASE_PATH'] + '/')
