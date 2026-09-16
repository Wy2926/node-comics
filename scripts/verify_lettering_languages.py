"""Offline lettering acceptance on synthetic speech bubbles (no OCR, LLM or R2).

Run with classic-engine's Python; see docs/LANGUAGE_SUPPORT.md.
"""
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'services/classic-engine'), str(ROOT / 'engines/mit-native')]
os.environ.setdefault('MODEL_DIR', str(ROOT / 'engines/mit-models'))
os.environ.setdefault('ENGINE_FONT', str(ROOT / 'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc'))
os.environ['PYTHONIOENCODING'] = 'utf-8'

import numpy as np
from PIL import Image, ImageDraw
import server
from hyphenation import DictionaryStore, default_directory
from prepare_dictionaries import prepare
from render_languages import LANG, prepare_fonts, font_for

SAMPLES = {
    'zh-Hans': '别担心，我们一定能找到回家的路！',
    'zh-Hant': '別擔心，我們一定能找到回家的路！',
    'ja': '大丈夫、きっと帰り道が見つかるよ！',
    'en': 'Do not worry! Together we will find our way home.',
    'ko': '걱정하지 마! 함께 집으로 가는 길을 찾을 거야.',
    'fr': 'N’aie pas peur ! Ensemble, nous retrouverons le chemin. Ÿ É œ',
    'es': '¡No tengas miedo! Juntos encontraremos el camino. ¿Sí?',
    'pt-BR': 'Não tenha medo! Juntos encontraremos o caminho de volta. Ação!',
    'de': 'Keine Angst! Gemeinsam finden wir den Weg zurück. Ä Ö Ü ß ẞ',
    'it': 'Non avere paura! Insieme ritroveremo la strada. È già qui!',
    'ru': 'Не бойся! Вместе мы найдём дорогу домой. Ёжик!',
    'pl': 'Nie bój się! Razem znajdziemy drogę do domu. Zażółć gęślą jaźń.',
    'uk': 'Не бійся! Разом ми знайдемо дорогу додому. Ґ Є І Ї ґ є і ї',
    'tr': 'Korkma! Birlikte eve dönüş yolunu bulacağız. Ç Ğ İ Ö Ş Ü ı',
    'vi': 'Đừng lo! Chúng ta sẽ tìm được đường về nhà. Ắ Ằ Ẳ Ẵ Ặ Ế Ề Ể Ễ Ệ Ứ Ừ Ử Ữ Ự',
    'id': 'Jangan takut! Bersama kita akan menemukan jalan pulang ke rumah.',
}


async def main():
    destination = ROOT / 'artifacts/lettering-languages'
    destination.mkdir(parents=True, exist_ok=True)
    prepare_fonts(list(LANG))
    prepare(default_directory(), list(LANG))
    from typesetter import initialize
    initialize(DictionaryStore(default_directory(), list(LANG)))
    image = np.full((520, 600, 3), 245, np.uint8)
    image[35:485, 120:480] = 255
    mask = np.zeros((520, 600), np.uint8)
    mask[35:485, 120:480] = 255
    analysis = {'segments': [{'id': 'b001'}], 'mask': server.png(mask),
                'regions': [{'lines': [[[135, y], [465, y], [465, y + 30], [135, y + 30]] for y in (140, 185, 230, 275)],
                             'texts': ['We will find our way home.'] * 4, 'font_size': 24, 'fg_colors': [0, 0, 0],
                             'bg_colors': [255, 255, 255]}]}
    results = []
    outputs = {}
    sheet = Image.new('RGB', (1200, 1120), 'white')
    draw = ImageDraw.Draw(sheet)
    with patch('urllib.request.urlopen', side_effect=AssertionError('Render must stay offline')), \
         patch('requests.get', side_effect=AssertionError('Render must stay offline')):
        for index, (language, text) in enumerate(SAMPLES.items()):
            result = await server.render_page(image, analysis, {'b001': text}, {'font_minimum': 10}, language, image.copy())
            pixels = server.decode(result['image'])
            outputs[language] = result['image']
            glyphs = server.decode(result['glyph_mask'], 'L') > 0
            assert glyphs.any(), language
            ys, xs = np.where(glyphs)
            (destination / f'{language}.png').write_bytes(base64.b64decode(result['image']))
            print(language, [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())], flush=True)
            assert xs.min() > 0 and xs.max() < 599 and ys.min() > 0 and ys.max() < 519, language
            np.testing.assert_array_equal(pixels[~glyphs], image[~glyphs])
            (destination / f'{language}.png').write_bytes(base64.b64decode(result['image']))
            tile = Image.fromarray(pixels).resize((300, 260))
            x, y = index % 4 * 300, index // 4 * 280
            sheet.paste(tile, (x, y + 20))
            draw.text((x + 10, y + 3), language, fill='black')
            results.append({'language': language, 'font': Path(font_for(language, server.FONT)).name,
                            'glyph_pixels': int(glyphs.sum()), 'seconds': round(result['timings']['render'], 3),
                            'bounds': [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]})
        # Canonical composition must render the same Vietnamese accents.
        import unicodedata
        composed = await server.render_page(image, analysis, {'b001': SAMPLES['vi']}, {'font_minimum': 10}, 'vi', image.copy())
        decomposed = await server.render_page(image, analysis, {'b001': unicodedata.normalize('NFD', SAMPLES['vi'])}, {'font_minimum': 10}, 'vi', image.copy())
        assert composed['image'] == decomposed['image']
        # A language must render identically after switching between CJK and Latin fonts.
        for language in ('en', 'fr', 'ja', 'uk'):
            repeated = await server.render_page(image, analysis, {'b001': SAMPLES[language]}, {'font_minimum': 10}, language, image.copy())
            assert repeated['image'] == outputs[language], language
        cramped = {**analysis, 'regions': [{'lines': [[[135, 190], [465, 190], [465, 300], [135, 300]]],
                   'texts': ['short'], 'font_size': 30, 'fg_colors': [0, 0, 0], 'bg_colors': [255, 255, 255]}]}
        fitted = await server.render_page(image, cramped, {'b001': SAMPLES['zh-Hans']}, {'font_minimum': 10}, 'zh-Hans', image.copy())
        assert fitted['layout_fitted_regions'] == 1
        glyphs = server.decode(fitted['glyph_mask'], 'L')
        assert not (glyphs[0].any() or glyphs[-1].any() or glyphs[:, 0].any() or glyphs[:, -1].any())
    sheet.save(destination / 'overview.png')
    report = {'kind': 'synthetic-lettering-only', 'network_during_render': False, 'nfc_nfd_equal': True,
              'font_switch_stable': True, 'overflow_fitted_without_clipping': True, 'languages': results}
    (destination / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    asyncio.run(main())
