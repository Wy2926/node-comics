"""Whole typesetter acceptance: reflow, language direction and protected pixels."""
import asyncio
from contextlib import redirect_stdout, redirect_stderr
import logging
import os
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import pytest

from hyphenation import DictionaryStore
from lettering import LetteringError, changed_pixels, letter_page, text_preserved
from speech_bubbles import find_bubble
from typesetter import initialize

ROOT = Path(__file__).resolve().parents[2]
FONT = ROOT / 'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc'
TEXTS = {
    'en': 'We can still find our way home. Stay together and follow the light beyond the mountains!',
    'ja': '大丈夫、みんなで力を合わせれば、きっと帰り道が見つかるよ。あの山の向こうに光が見える！',
    'zh-Hans': '别担心，我们一定能找到回家的路！只要大家团结起来，沿着山那边的光走，就能找到出口。',
    'zh-Hant': '別擔心，我們一定能找到回家的路！只要大家團結起來，沿著山那邊的光走，就能找到出口。',
}


@pytest.fixture(scope='module', autouse=True)
def typesetter():
    logging.disable(logging.CRITICAL)
    initialize(DictionaryStore(ROOT / 'engines/mit-models/hyphenation', list(TEXTS)))


def sample():
    image = np.full((480, 420, 3), 150, np.uint8)
    cv2.ellipse(image, (210, 240), (145, 180), 0, 0, 360, (255, 255, 255), -1)
    cv2.ellipse(image, (210, 240), (145, 180), 0, 0, 360, (0, 0, 0), 4)
    mask = np.zeros(image.shape[:2], np.uint8)
    row = {'lines': [[[185, 145], [235, 145], [235, 325], [185, 325]]],
           'texts': ['source'], 'font_size': 24, 'fg_color': [0, 0, 0], 'bg_color': [255, 255, 255]}
    analysis = {'segments': [{'id': 'b001'}], 'regions': [row]}
    return image, mask, analysis


def run(image, mask, analysis, texts, language, minimum=10):
    details = []
    with patch('urllib.request.urlopen', side_effect=AssertionError('No network while lettering')), \
         patch('requests.get', side_effect=AssertionError('No network while lettering')), \
         open(os.devnull, 'w') as sink, redirect_stdout(sink), redirect_stderr(sink):
        result = asyncio.run(letter_page(image, analysis, texts, {'font_minimum': minimum},
                                        language, image.copy(), mask, str(FONT), details))
    return result, details


@pytest.mark.parametrize('language', list(TEXTS))
def test_single_source_column_reflows_complete_translation_in_bubble(language):
    image, mask, analysis = sample()
    (output, glyphs, _, bubbles), details = run(image, mask, analysis, {'b001': TEXTS[language]}, language)
    bubble = find_bubble(image, initialize().TextBlock(**analysis['regions'][0]), [])
    assert bubbles == 1 and bubble.contains(glyphs > 0)
    assert details[0]['direction'] == ('h' if language == 'en' else 'v')
    assert details[0]['lines'] > 1 and details[0]['font_size'] >= 10
    np.testing.assert_array_equal(output[glyphs == 0], image[glyphs == 0])


def test_protected_text_is_excluded_before_fit():
    image, mask, analysis = sample()
    analysis['unrecognized_regions'] = [[[240, 120], [280, 120], [280, 165], [240, 165]]]
    image[120:166, 240:281] = (100, 70, 20)
    (output, glyphs, _, _), _ = run(image, mask, analysis, {'b001': TEXTS['en']}, 'en')
    assert not glyphs[120:166, 240:281].any()
    np.testing.assert_array_equal(output[120:166, 240:281], image[120:166, 240:281])


def test_shared_bubble_keeps_both_text_blocks_without_overlap():
    image, mask, analysis = sample()
    row = analysis['regions'][0]
    row['lines'] = [[[145, 155], [180, 155], [180, 310], [145, 310]]]
    other = dict(row, lines=[[[240, 155], [275, 155], [275, 310], [240, 310]]])
    analysis['regions'].append(other)
    analysis['segments'].append({'id': 'b002'})
    (output, glyphs, _, bubbles), details = run(image, mask, analysis,
        {'b001': 'みんなで帰り道を探そう。', 'b002': 'あの山の向こうに光が見える！'}, 'ja')
    assert bubbles == 2 and len(details) == 2
    assert glyphs[:, :210].any() and glyphs[:, 210:].any()
    np.testing.assert_array_equal(output[glyphs == 0], image[glyphs == 0])


def test_unfit_text_fails_without_drawing_on_input():
    image, mask, analysis = sample()
    original = image.copy()
    with pytest.raises(LetteringError):
        run(image, mask, analysis, {'b001': TEXTS['ja'] * 12}, 'ja', minimum=24)
    np.testing.assert_array_equal(image, original)


def test_missing_glyph_and_empty_translation_are_not_delivered():
    image, mask, analysis = sample()
    for text, code in [('missing ' + chr(0x10ffff), 'FONT_MISSING'), ('', 'NO_GLYPHS')]:
        with pytest.raises(LetteringError, match=code):
            run(image, mask, analysis, {'b001': text}, 'en')


def test_translation_content_check_preserves_original_hyphens_and_detects_omissions():
    assert text_preserved('well-known storytelling', 'well-[BR]known story-[BR]telling')
    assert not text_preserved('well-known storytelling', 'well[BR]known storytelling')
    assert not text_preserved('full sentence', 'full[BR]sent')


@pytest.mark.parametrize('point,protected,code', [((0, 5), False, 'BOUNDARY'), ((5, 5), True, 'OVERLAP')])
def test_specific_failure_reasons(point, protected, code):
    before = np.zeros((20, 20, 3), np.uint8)
    after = before.copy()
    after[point] = 255
    with pytest.raises(LetteringError, match=code):
        changed_pixels(before, after, np.full((20, 20), protected))
