"""Target lettering capabilities; independent of OCR source languages."""
from pathlib import Path
import hashlib
import os
import tempfile
import unicodedata
import urllib.request

LANG = {'zh-Hans': 'CHS', 'zh-Hant': 'CHT', 'ja': 'JPN', 'en': 'ENG', 'ko': 'KOR',
        'fr': 'FRA', 'es': 'ESP', 'pt-BR': 'PTB', 'de': 'DEU', 'it': 'ITA',
        'ru': 'RUS', 'pl': 'POL', 'uk': 'UKR', 'tr': 'TRK', 'vi': 'VIN', 'id': 'IND'}
CJK = {'zh-Hans', 'zh-Hant', 'ja', 'ko'}
FONT_REVISION = 'ffebf8c1ee449e544955a7e813c54f9b73848eac'
FONT_SHA = 'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5'
FONT_RESOURCES = (
    ('NotoSans-Regular.ttf', 'hinted/ttf/NotoSans/NotoSans-Regular.ttf', 569208, FONT_SHA),
    ('NotoSans-OFL.txt', 'LICENSE', 4377, '0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb'),
)


def font_directory():
    return Path(os.environ.get('MODEL_DIR', '/models')) / 'fonts' / ('noto-' + FONT_REVISION[:12])


def prepare_fonts(languages):
    """Prepare pinned font and its license before readiness/config publication."""
    if not set(languages) <= LANG.keys():
        raise ValueError('Unsupported lettering language')
    if not set(languages) - CJK - {'en'}:
        return
    directory = font_directory()
    for filename, source, size, checksum in FONT_RESOURCES:
        path = directory / filename
        if path.is_file() and path.stat().st_size == size and hashlib.sha256(path.read_bytes()).hexdigest() == checksum:
            continue
        url = f'https://raw.githubusercontent.com/notofonts/noto-fonts/{FONT_REVISION}/{source}'
        with urllib.request.urlopen(url, timeout=30) as response:
            raw = response.read(size + 1)
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != checksum:
            raise RuntimeError('Font resource checksum mismatch: ' + filename)
        directory.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=directory, suffix='.download', delete=False) as target:
                temporary = Path(target.name)
                target.write(raw)
            temporary.replace(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def font_for(language, cjk_font):
    # Preserve existing English/CJK output; extended alphabets use full Noto Sans.
    return cjk_font if language in CJK or language == 'en' else str(font_directory() / 'NotoSans-Regular.ttf')


def normalized_text(text):
    # Keep canonical composition identical across Qt font measurement and painting.
    return unicodedata.normalize('NFC', text)
