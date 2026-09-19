"""Shared recognition, reading-order and typesetting language aliases."""
import re

ALIASES = {
    'ja': ('ja', 'jp', 'jpn', 'japanese', '日语', '日文', '日本語'),
    'ko': ('ko', 'kor', 'korean', '韩语', '韩文', '한국어'),
    'en': ('en', 'eng', 'english', '英语', '英文'),
    'zh': ('zh', 'zho', 'chi', 'chinese', 'simplified chinese', 'traditional chinese', '中文', '简体中文', '繁體中文'),
    'latin': ('latin',),
}


def language_code(value):
    value = value.strip().lower().replace('_', '-')
    for code, aliases in ALIASES.items():
        if value in aliases or value.split('-')[0] == code:
            return code
    for code, aliases in ALIASES.items():
        if any(re.match(re.escape(alias) + r'\b', value) for alias in aliases if len(alias) > 3):
            return code
    return None


def join_lines(texts, language):
    texts = [text.strip() for text in texts if text.strip()]
    if language in ('en', 'ko', 'latin'):
        return ' '.join(texts)
    result = ''
    for text in texts:
        if result and result[-1].isascii() and result[-1].isalnum() and text[0].isascii() and text[0].isalnum():
            result += ' '
        result += text
    return result
