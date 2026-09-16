"""Node Comics adapter around Manga Translator UI's complete Qt typesetter."""
import hashlib
import importlib
import json
import os
import sys

from prepare_typesetter import LOCK, PACKAGE, REVISION, runtime_directory

_renderer = None


def initialize(dictionary_store=None):
    global _renderer
    if _renderer is None:
        root = runtime_directory()
        manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
        if manifest['revision'] != REVISION or manifest != json.loads(LOCK.read_text(encoding='utf-8')):
            raise RuntimeError('Typesetter revision mismatch')
        for row in manifest['files']:
            path = root / PACKAGE / row['path']
            if hashlib.sha256(path.read_bytes()).hexdigest() != row['prepared_sha256']:
                raise RuntimeError('Typesetter source checksum mismatch')
        os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
        os.environ['PIL_MAX_IMAGE_PIXELS'] = '24000000'
        sys.path.insert(0, str(root))
        _renderer = importlib.import_module(PACKAGE + '.rendering')
    if dictionary_store is not None:
        # The upstream facade is the lookup boundary used by all layout paths.
        def select(language):
            return dictionary_store.select('en' if language in {'en_US', 'en-US'} else language)
        _renderer.text_render.select_hyphenator = select
        importlib.import_module(PACKAGE + '.rendering.text_render._fonts').select_hyphenator = select
        importlib.import_module(PACKAGE + '.rendering.auto_linebreak').select_hyphenator = select
    return _renderer


def configuration(minimum, family):
    config = importlib.import_module(PACKAGE + '.config').Config()
    config.render.layout_mode = 'balloon_fill'
    config.render.balloon_fill_mask_layout = True
    config.render.center_text_in_bubble = True
    config.render.font_size_minimum = minimum
    config.render.font_family = family
    config.render.alignment = 'center'
    config.render.semantic_linebreak = False
    config.render.optimize_line_breaks = False
    config.render.remove_linebreak_punctuation = False
    return config
