"""Prepare the complete pinned Manga Translator UI layout/rendering modules.

Package imports, input/paint boundaries and two default layout policies change.
Upstream wrapping, fitting, vertical typography and glyph algorithms stay intact.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

REVISION = 'f0307a063214f915f2b1d6e5cd3233f3bf78339f'
REPOSITORY = 'https://github.com/hgmzhn/manga-translator-ui.git'
PROJECT = Path(__file__).resolve().parents[2]
PACKAGE = 'node_comics_typesetter'
LOCK = Path(__file__).resolve().parent / 'third_party/manga-typesetter.json'


def runtime_directory():
    return Path(os.environ.get('TYPESETTER_ROOT', PROJECT / 'engines/manga-typesetter-runtime'))


def prepare(source=None, destination=None):
    source = Path(source or PROJECT / 'engines/manga-typesetter')
    destination = Path(destination or runtime_directory())
    if not source.exists():
        subprocess.run(['git', 'clone', '--filter=blob:none', '--no-checkout', REPOSITORY, str(source)], check=True)
        subprocess.run(['git', '-C', str(source), 'sparse-checkout', 'set', 'manga_translator'], check=True)
        subprocess.run(['git', '-C', str(source), 'checkout', REVISION], check=True)
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != REVISION:
        raise RuntimeError('Unexpected typesetter revision')
    dirty = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain', '--untracked-files=no'], text=True)
    if dirty.strip():
        raise RuntimeError('Typesetter source checkout has local modifications')
    base = source / 'manga_translator'
    paths = [base / value for value in ('config.py', 'custom_api_params.py', 'runtime_paths.py', 'image_formats.py')]
    paths += sorted((base / 'rendering').rglob('*.py'))
    paths += [base / 'utils' / value for value in ('generic.py', 'image_modes.py', 'log.py', 'textblock.py', 'bubble.py')]
    paths += sorted((base / 'utils/panel').rglob('*.py'))
    records = []
    for path in paths:
        raw = path.read_text(encoding='utf-8').encode('utf-8')
        relative = path.relative_to(base)
        content = raw.decode('utf-8').replace('from manga_translator.', f'from {PACKAGE}.')
        if relative.as_posix() == 'rendering/__init__.py':
            # Observe the existing paint boundary without replacing layout.
            before = '    render_alpha: Optional[np.ndarray] = None,\n    ):\n'
            if content.count(before) != 1 or content.count('                img = render(\n') != 1:
                raise RuntimeError('Typesetter paint callback patch no longer matches')
            content = content.replace(before, '    render_alpha: Optional[np.ndarray] = None,\n    render_callback=None,\n    ):\n')
            content = content.replace('                img = render(\n', '                img = (render_callback or render)(\n')
            # Validate native ink before upstream clips/composites onto the page.
            signature = '    paint_part: str | None = None,\n):\n'
            clipping = '    clip_x1 = max(0, dst_x1)\n'
            if content.count(signature) != 1 or content.count(clipping) != 1:
                raise RuntimeError('Typesetter layer callback patch no longer matches')
            content = content.replace(signature, '    paint_part: str | None = None,\n    layer_callback=None,\n):\n')
            content = content.replace(clipping,
                '    if layer_callback is not None:\n        layer_callback(rgba_region[:, :, 3], (dst_x1, dst_y1))\n\n' + clipping)
            # Upstream's legacy English shortcut returns before balloon_fill's
            # fitting pass. Select its complete unified fitter for bounded pages.
            selector = 'def _should_apply_default_english_line_break_method(region: TextBlock, config: Config = None) -> bool:\n'
            if content.count(selector) != 1:
                raise RuntimeError('Typesetter English routing patch no longer matches')
            content = content.replace(selector, selector +
                "    if config and config.render.layout_mode == 'balloon_fill' and config.render.balloon_fill_mask_layout:\n        return False\n")
        if relative.as_posix() == 'rendering/auto_linebreak.py':
            selector = 'def should_force_no_wrap_single_region(region: Any) -> bool:\n'
            if content.count(selector) != 1:
                raise RuntimeError('Typesetter reflow policy patch no longer matches')
            content = content.replace(selector, selector +
                "    if getattr(region, 'allow_reflow', False):\n        return False\n")
        output = destination / PACKAGE / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(content, encoding='utf-8', newline='\n')
        records.append({'path': relative.as_posix(), 'source_sha256': hashlib.sha256(raw).hexdigest(),
                        'prepared_sha256': hashlib.sha256(output.read_bytes()).hexdigest()})
    facades = {'__init__.py': '"""Pinned render-only package; no application startup."""\n',
               'utils/__init__.py': 'from .generic import *\nfrom .textblock import *\nfrom .log import *\n'
               'from .bubble import build_region_reference_mask\n'
               'from typesetter_inputs import get_cached_bubbles_with_mangalens, build_bubble_mask_from_mangalens_result\n'}
    for relative, content in facades.items():
        raw = content.encode('utf-8')
        (destination / PACKAGE / relative).write_bytes(raw)
        records.append({'path': relative, 'source_sha256': None,
                        'prepared_sha256': hashlib.sha256(raw).hexdigest()})
    license_raw = (source / 'LICENSE.txt').read_text(encoding='utf-8').encode('utf-8')
    (destination / 'LICENSE-GPL-3.0.txt').write_bytes(license_raw)
    manifest = {'repository': REPOSITORY, 'revision': REVISION, 'license': 'GPL-3.0',
                'license_sha256': hashlib.sha256(license_raw).hexdigest(), 'files': records,
                'modifications': 'Absolute import namespace; render-only package and utility facades; optional dispatch paint and pre-composite layer callbacks; route bounded English to upstream unified balloon fitter; allow translation reflow even for one source line. Fitting, wrapping and glyph algorithms unchanged.'}
    if LOCK.exists() and json.loads(LOCK.read_text(encoding='utf-8')) != manifest:
        raise RuntimeError('Typesetter source differs from the reviewed checksum manifest')
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source')
    parser.add_argument('--destination')
    args = parser.parse_args()
    result = prepare(args.source, args.destination)
    print(json.dumps({'revision': result['revision'], 'source_files': len(result['files'])}))
