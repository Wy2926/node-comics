"""Product target languages, separate from OCR source-model coverage."""
from typing import Annotated, Literal
from pydantic import WrapValidator, ValidationError
from pydantic_core import PydanticCustomError


def supported_language(value, handler):
    try:
        return handler(value)
    except ValidationError:
        raise PydanticCustomError('language_unsupported', '此目标语言尚未开放') from None

Language = Annotated[Literal['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko', 'fr', 'es', 'pt-BR',
                   'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id'], WrapValidator(supported_language)]
LANGUAGES = {'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', 'en': 'English', 'ja': '日本語', 'ko': '한국어',
             'fr': 'Français', 'es': 'Español', 'pt-BR': 'Português (Brasil)', 'de': 'Deutsch',
             'it': 'Italiano', 'ru': 'Русский', 'pl': 'Polski', 'uk': 'Українська',
             'tr': 'Türkçe', 'vi': 'Tiếng Việt', 'id': 'Bahasa Indonesia'}
REDRAW_LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko']
