"""Pinned, offline-only renderer dictionaries. Downloads live in prepare_dictionaries.py."""
import hashlib
import json
import os
from pathlib import Path

from hyphen import Hyphenator, hnj
from langcodes import standardize_tag

CATALOG = json.loads(Path(__file__).with_name('hyphenation-catalog.json').read_text(encoding='utf-8'))
ALIASES = {alias: locale for locale, entry in CATALOG['dictionaries'].items() for alias in entry['aliases']}


def default_directory():
    return Path(os.environ.get('ENGINE_DICTIONARY_DIR', str(Path(os.environ.get('MODEL_DIR', '/models')) / 'hyphenation')))


def language_list(values):
    return list(dict.fromkeys(part.strip() for value in values for part in value.split(',') if part.strip()))


def resolve(language):
    language = {'CHS': 'zh-Hans', 'CHT': 'zh-Hant'}.get(language, language)
    try:
        tag = standardize_tag(language.replace('_', '-'))
    except (ValueError, TypeError, AttributeError):
        raise ValueError('Invalid dictionary language') from None
    if tag.split('-')[0] in CATALOG['no_dictionary_languages']:
        return None
    if tag not in ALIASES:
        raise ValueError(f'Unsupported dictionary language: {tag}; run prepare_dictionaries.py --list')
    return ALIASES[tag]


def resources(locale):
    entry = CATALOG['dictionaries'][locale]
    return [entry['dictionary'], *entry['notices']]


def resource_path(directory, record):
    return Path(directory) / CATALOG['version'] / record['path']


def verified(path, record):
    if not path.is_file() or path.stat().st_size != record['bytes']:
        return False
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest() == record['sha256']


class LocalHyphenator(Hyphenator):
    """Keep PyHyphen 4.0.4 word semantics, bypass its downloading constructor."""
    def __init__(self, locale, path):
        self.__hyphenate__ = hnj.hyphenator_(str(path), 2, 2, 2, 2)
        self.apply = self.__hyphenate__.apply
        self.language = locale
        self.dict_path = str(path)


class DictionaryStore:
    def __init__(self, directory, languages):
        self.directory = Path(directory)
        self.instances = {}
        for locale in dict.fromkeys(resolve(value) for value in languages):
            if locale is None:
                continue
            for record in resources(locale):
                if not verified(resource_path(self.directory, record), record):
                    raise RuntimeError(f'Dictionary {locale} missing or corrupt; run prepare_dictionaries.py --languages {locale}')
            path = resource_path(self.directory, CATALOG['dictionaries'][locale]['dictionary'])
            self.instances[locale] = LocalHyphenator(locale, path)

    def select(self, language):
        locale = resolve(language)
        if locale is None:
            return None
        if locale not in self.instances:
            raise RuntimeError(f'Dictionary {locale} was not prepared for this engine')
        return self.instances[locale]

    def describe(self):
        return {'version': CATALOG['version'], 'languages': sorted(self.instances), 'network': False}


def configure_renderer(text_render, directory=None, languages=None):
    values = languages if languages is not None else language_list([os.environ.get('ENGINE_DICTIONARY_LANGUAGES', 'en')])
    store = DictionaryStore(directory if directory is not None else default_directory(), values)
    # Both layout measurement and actual painting use this module-level selector.
    # No change to wrapping, syllable selection, fonts, masks, or pixel composition.
    text_render.select_hyphenator = store.select
    return store
