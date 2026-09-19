"""Local implementation settings; central configuration never sets GPU threads."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def origin(value, allow_http=False):
    parsed = urlsplit(value)
    if (parsed.scheme not in (('https', 'http') if allow_http else ('https',)) or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
        raise ValueError('Expected an HTTPS origin without path, credentials or query')
    return value.rstrip('/')


def load(path):
    path = Path(path).resolve()
    value = json.loads(path.read_text(encoding='utf-8-sig'))
    if value.get('protocol_version') != 2:
        raise ValueError('protocol_version must be 2')
    if value.get('allow_http', False):
        raise ValueError('Production nodes require HTTPS')
    value['control_url'] = origin(value['control_url'])
    value['r2_origin'] = origin(value['r2_origin'])
    if value.get('control_ca'):
        value['control_ca'] = str((path.parent / value['control_ca']).resolve())
        if not Path(value['control_ca']).is_file():
            raise ValueError('control_ca must name an existing PEM trust bundle')
    value['node_token'] = os.environ.get('NODE_TOKEN') or value.get('node_token')
    if not value['node_token'] or not value['node_id'] or not value['resource_id']:
        raise ValueError('Node identity and credential are required')
    defaults = {'models': 'models', 'gpu': 0, 'ocr_workers': 8, 'threads': 2, 'tile': 768,
                'font': [], 'png_compression': 1, 'detect_size': 1280, 'ocr_language': 'ja', 'direction': 'auto'}
    if set(value.get('engine', {})) - set(defaults):
        raise ValueError('Unknown local engine option')
    value['engine'] = defaults | value.get('engine', {})
    value.setdefault('local_pages', 2)
    value.setdefault('max_leases', 8)
    value.setdefault('download_workers', 4)
    value.setdefault('delivery_workers', 4)
    value.setdefault('resident_bytes', 1024 * 1024 * 1024)
    value.setdefault('journal_bytes', 512 * 1024 * 1024)
    value.setdefault('languages', ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko'])
    value['state_dir'] = str((path.parent / value.get('state_dir', 'state')).resolve())
    value['engine']['models'] = str((path.parent / value['engine']['models']).resolve())
    value['engine']['font'] = [str((path.parent / font).resolve()) for font in value['engine']['font']]
    if not 1 <= value['local_pages'] <= value['max_leases'] <= 32:
        raise ValueError('Require 1 <= local_pages <= max_leases <= 32')
    if value['journal_bytes'] < value['max_leases'] * 64 * 1024 * 1024:
        raise ValueError('Reserve at least 64 MiB of journal space per accepted page')
    if not all(type(value[k]) is int and 1 <= value[k] <= 16 for k in ('download_workers', 'delivery_workers')):
        raise ValueError('Network worker counts must be between 1 and 16')
    if type(value['resident_bytes']) is not int or value['resident_bytes'] < 512 * 1024 * 1024:
        raise ValueError('Reserve at least 512 MiB for page buffers')
    if min(value['engine']['threads'], value['engine']['ocr_workers']) < 1:
        raise ValueError('Thread counts must be positive')
    if value['engine']['tile'] < 256 or value['engine']['tile'] % 128:
        raise ValueError('tile must be a multiple of 128 and at least 256')
    return value
