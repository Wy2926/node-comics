"""Language defaults and explicit lettering choices frozen by new jobs."""
import json
from pathlib import Path
from typing import Annotated, Literal
from pydantic import BeforeValidator
from sqlalchemy import and_, or_
from .errors import problem


_catalog = json.loads(Path(__file__).with_suffix('.json').read_text(encoding='utf-8'))
FONT_LANGUAGES = {item['id']: tuple(item['languages']) for item in _catalog['fonts']}
DEFAULT_FONTS = _catalog['defaults']
FontId = Literal[tuple(FONT_LANGUAGES)]
RequestedFont = Annotated[FontId | Literal[''] | None, BeforeValidator(lambda value: None if value == '' else value)]


def resolve_font(font_id, language):
    font_id = font_id or DEFAULT_FONTS[language]
    if font_id not in FONT_LANGUAGES or language not in FONT_LANGUAGES[font_id]:
        problem('TRANSLATION_FONT_LANGUAGE_UNSUPPORTED', '所选字体不支持目标语言，请重新选择', 422)
    return font_id


def supports_font(font_id, language, supported):
    """SQL predicate also fences old unselected jobs to their language default."""
    default_languages = [target for target, font in DEFAULT_FONTS.items() if font in supported]
    return or_(and_(font_id.is_not(None), font_id.in_(supported)),
        and_(or_(font_id.is_(None), font_id == ''), language.in_(default_languages)))


def font_catalog():
    return [{'id': font_id, 'languages': list(languages)} for font_id, languages in FONT_LANGUAGES.items()]
