import json
from pathlib import Path

import pytest

from mtu_engine.engine import LANGUAGES
from mtu_engine.fonts import DEFAULT_FONT_IDS, FONT_CHOICES, font_filename, resolve_font_id


def test_pinned_font_choices_match_asset_manifest_and_cover_all_target_languages():
    assets = Path(__file__).resolve().parents[2] / 'compute-node/assets.json'
    fonts = json.loads(assets.read_text(encoding='utf-8'))['fonts']
    choices = {font['id']: (font['name'], tuple(font['languages'])) for font in fonts if 'id' in font}
    assert choices == FONT_CHOICES
    assert len(fonts) == len(FONT_CHOICES)
    assert set().union(*(set(languages) for _, languages in FONT_CHOICES.values())) == set(LANGUAGES)
    assert set(DEFAULT_FONT_IDS) == set(LANGUAGES)
    catalog = json.loads((Path(__file__).resolve().parents[1] / 'mtu_engine/fonts.json').read_text(encoding='utf-8'))
    assert sum(len(font['default_languages']) for font in catalog) == len(LANGUAGES)
    for language in LANGUAGES:
        assert sum(language in languages for _, languages in FONT_CHOICES.values()) >= 5, language
    example = json.loads((Path(__file__).resolve().parents[1] / 'node.example.json').read_text(encoding='utf-8'))
    assert example['engine']['font'] == ['.assets/fonts/' + font['name'] for font in fonts]


@pytest.mark.parametrize('language', LANGUAGES)
def test_unselected_null_and_empty_font_resolve_to_the_language_default(language):
    default = DEFAULT_FONT_IDS[language]
    filename, languages = FONT_CHOICES[default]
    assert language in languages
    assert resolve_font_id(language) == default
    assert font_filename(language) == filename
    for font_id in (None, ''):
        assert resolve_font_id(language, font_id) == default
        assert font_filename(language, font_id) == filename


@pytest.mark.parametrize('font_id', ['../font.ttf', 'unknown', ' ', [], 4])
def test_unknown_font_ids_are_never_interpreted_as_defaults(font_id):
    with pytest.raises(ValueError, match='Unsupported translation font'):
        font_filename('en', font_id)


@pytest.mark.parametrize('font_id', [None, '', 'comic-relief'])
def test_unknown_languages_have_no_implicit_font(font_id):
    with pytest.raises(ValueError, match='Unsupported translation font'):
        font_filename('unknown', font_id)


@pytest.mark.parametrize('font_id', FONT_CHOICES)
def test_only_catalog_languages_can_select_each_font(font_id):
    filename, languages = FONT_CHOICES[font_id]
    for language in LANGUAGES:
        if language in languages:
            assert font_filename(language, font_id) == filename
        else:
            with pytest.raises(ValueError, match='Unsupported translation font'):
                font_filename(language, font_id)
