"""Local implementation settings; central configuration never sets GPU threads."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from .resources import resolve_cpu_resources


def origin(value, allow_http=False):
    parsed = urlsplit(value)
    if (parsed.scheme not in (('https', 'http') if allow_http else ('https',)) or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
        raise ValueError('Expected an HTTPS origin without path, credentials or query')
    return value.rstrip('/')


def load(path):
    path = Path(path).resolve()
    value = json.loads(path.read_text(encoding='utf-8-sig'))
    if value.get('protocol_version') != 3:
        raise ValueError('protocol_version must be 3')
    if value.get('allow_http', False):
        raise ValueError('Production nodes require HTTPS')
    value['control_url'] = origin(value['control_url'])
    if value.get('control_ca'):
        value['control_ca'] = str((path.parent / value['control_ca']).resolve())
        if not Path(value['control_ca']).is_file():
            raise ValueError('control_ca must name an existing PEM trust bundle')
    value['node_token'] = os.environ.get('NODE_TOKEN') or value.get('node_token')
    if not value['node_token'] or not value['node_id'] or not value['resource_id']:
        raise ValueError('Node identity and credential are required')
    defaults = {'models': '.assets/models', 'gpu': 0, 'threads': 'auto',
                'font': [], 'detect_size': 1280, 'inpainting_size': 512, 'keep_lang': None}
    if set(value.get('engine', {})) - set(defaults):
        raise ValueError('Unknown local engine option')
    value['engine'] = defaults | value.get('engine', {})
    value.setdefault('local_pages', 2)
    value.setdefault('render_workers', 'auto')
    value.setdefault('max_leases', 8)
    value.setdefault('download_workers', 4)
    value.setdefault('delivery_workers', 4)
    value.setdefault('resident_bytes', 1024 * 1024 * 1024)
    value['state_dir'] = str((path.parent / value.get('state_dir', 'state')).resolve())
    value['engine']['models'] = str((path.parent / value['engine']['models']).resolve())
    value['engine']['font'] = [str((path.parent / font).resolve()) for font in value['engine']['font']]
    if (not all(type(value[k]) is int for k in ('local_pages', 'max_leases'))
            or not 1 <= value['local_pages'] <= value['max_leases'] <= 32):
        raise ValueError('Require 1 <= local_pages <= max_leases <= 32')
    if value['render_workers'] != 'auto' and (type(value['render_workers']) is not int
                                            or not 1 <= value['render_workers'] <= value['max_leases']):
        raise ValueError('render_workers must be auto or between 1 and max_leases')
    if not all(type(value[k]) is int and 1 <= value[k] <= 16 for k in ('download_workers', 'delivery_workers')):
        raise ValueError('Network worker counts must be between 1 and 16')
    if type(value['resident_bytes']) is not int or value['resident_bytes'] < 512 * 1024 * 1024:
        raise ValueError('Reserve at least 512 MiB for page buffers')
    if value['engine']['threads'] != 'auto' and (type(value['engine']['threads']) is not int or value['engine']['threads'] < 1):
        raise ValueError('engine.threads must be auto or a positive integer')
    if type(value['engine']['gpu']) is not int or value['engine']['gpu'] < 0:
        raise ValueError('gpu must be an NVIDIA CUDA device index')
    if type(value['engine']['inpainting_size']) is not int or value['engine']['inpainting_size'] not in (512, 768, 1024):
        raise ValueError('inpainting_size must be 512, 768 or 1024')
    if type(value['engine']['detect_size']) is not int or not 512 <= value['engine']['detect_size'] <= 2048:
        raise ValueError('detect_size must be between 512 and 2048')
    if value['engine']['keep_lang'] is not None:
        from langcodes import tag_is_valid
        language = value['engine']['keep_lang']
        if not isinstance(language, str) or len(language) != 2 or not language.islower() or not tag_is_valid(language):
            raise ValueError('keep_lang must be an ISO 639-1 source language code or null')
    resources = resolve_cpu_resources(analysis_threads=value['engine']['threads'], render_workers=value['render_workers'],
                                      local_pages=value['local_pages'], max_leases=value['max_leases'])
    value['engine']['threads'] = resources['analysis_threads']
    value['render_workers'] = resources['render_workers']
    value['_render_threads'] = resources['render_threads']
    value['_cpu_resources'] = resources
    return value
