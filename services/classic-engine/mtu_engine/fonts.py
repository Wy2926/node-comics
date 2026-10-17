"""Public font identifiers select pinned bundle files, never caller paths."""
import json
from pathlib import Path

_FONTS = json.loads(Path(__file__).with_name('fonts.json').read_text(encoding='utf-8'))
FONT_CHOICES = {font['id']: (font['file'], tuple(font['languages'])) for font in _FONTS}
DEFAULT_FONT_IDS = {language: font['id'] for font in _FONTS for language in font['default_languages']}


def resolve_font_id(language, font_id=None):
    if font_id is None or font_id == '':
        font_id = DEFAULT_FONT_IDS.get(language)
    choice = FONT_CHOICES.get(font_id) if isinstance(font_id, str) else None
    if choice is None or language not in choice[1]:
        raise ValueError('Unsupported translation font')
    return font_id


def font_filename(language, font_id=None):
    return FONT_CHOICES[resolve_font_id(language, font_id)][0]
