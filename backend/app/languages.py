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
                   'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id', 'ar'], WrapValidator(supported_language)]
LANGUAGES = {'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', 'en': 'English', 'ja': '日本語', 'ko': '한국어',
             'fr': 'Français', 'es': 'Español', 'pt-BR': 'Português (Brasil)', 'de': 'Deutsch',
             'it': 'Italiano', 'ru': 'Русский', 'pl': 'Polski', 'uk': 'Українська',
             'tr': 'Türkçe', 'vi': 'Tiếng Việt', 'id': 'Bahasa Indonesia', 'ar': 'العربية'}

# Only model instructions use these names; APIs, jobs and rendering keep codes.
LLM_LANGUAGE_NAMES = {
    code: english if LANGUAGES[code] == english else f'{LANGUAGES[code]} ({english})'
    for code, english in {
        'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese', 'en': 'English',
        'ja': 'Japanese', 'ko': 'Korean', 'fr': 'French', 'es': 'Spanish',
        'pt-BR': 'Brazilian Portuguese', 'de': 'German', 'it': 'Italian', 'ru': 'Russian',
        'pl': 'Polish', 'uk': 'Ukrainian', 'tr': 'Turkish', 'vi': 'Vietnamese',
        'id': 'Indonesian', 'ar': 'Arabic',
    }.items()
}
