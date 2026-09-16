"""Dictionary preparation, integrity, aliases and offline renderer behavior."""
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import hyphenation as h
import prepare_dictionaries as prep


class LanguageTests(unittest.TestCase):
    def test_renderer_aliases_and_explicit_regions(self):
        for value in ('en', 'ENG', 'eng', 'en_GB', 'en-gb'):
            self.assertEqual(h.resolve(value), 'en-GB')
        self.assertEqual(h.resolve('en_US'), 'en-US')
        self.assertEqual(h.resolve('deu'), 'de-DE')
        self.assertEqual(h.resolve('pt_BR'), 'pt-BR')
        for value in ('CHS', 'CHT', 'zh-CN', 'zh-Hans', 'zh-Hant', 'JPN', 'KOR'):
            self.assertIsNone(h.resolve(value))

    def test_unknown_language_is_explicit_and_cannot_be_a_path(self):
        for value in ('xx-XX', '../en', '/tmp/en', ''):
            with self.assertRaises(ValueError):
                h.resolve(value)

    def test_space_and_comma_lists(self):
        self.assertEqual(h.language_list(['en,fr', 'de', 'en', '']), ['en', 'fr', 'de'])


class DictionaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.data = {'en/hyph_en_GB.dic': b'UTF-8\nLEFTHYPHENMIN 2\nRIGHTHYPHENMIN 2\nhy1phen\ntrans1la1tion\n',
                     'en/NOTICE.txt': b'Original synthetic test patterns.\n'}
        def record(path):
            raw = self.data[path]
            return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        self.records = [record(path) for path in self.data]
        patcher = patch.dict(h.CATALOG, {'dictionaries': {'en-GB': {'dictionary': self.records[0], 'notices': self.records[1:]}}})
        patcher.start()
        self.addCleanup(patcher.stop)

    def prepare(self):
        with patch.object(prep, 'download', side_effect=lambda record: self.data[record['path']]):
            return prep.prepare(self.directory, ['en'])

    def test_prepare_is_idempotent_and_aliases_share_an_offline_object(self):
        self.assertEqual(self.prepare()['downloaded_resources'], 2)
        with patch.object(prep, 'download', side_effect=AssertionError('unexpected network')), \
             patch('hyphen.Hyphenator.__init__', side_effect=AssertionError('downloading constructor')):
            report = prep.prepare(self.directory, ['ENG', 'en-GB', 'zh-Hans'])
            self.assertEqual(report['downloaded_resources'], 0)
            store = h.DictionaryStore(self.directory, ['en'])
            self.assertIs(store.select('en'), store.select('ENG'))
            self.assertEqual(store.select('en').syllables('hyphen'), ['hy', 'phen'])
            self.assertEqual(store.select('en').syllables('HYPHEN'), ['HY', 'PHEN'])
            self.assertIsNone(store.select('JPN'))

    def test_unprepared_supported_language_never_falls_back_to_download(self):
        self.prepare()
        store = h.DictionaryStore(self.directory, ['en'])
        with self.assertRaisesRegex(RuntimeError, 'not prepared'):
            store.select('de')

    def test_missing_dictionary_fails_before_renderer_installation(self):
        module = SimpleNamespace(select_hyphenator='unchanged')
        with patch.object(prep, 'download', side_effect=AssertionError('unexpected network')):
            with self.assertRaisesRegex(RuntimeError, 'missing or corrupt'):
                h.configure_renderer(module, self.directory, ['en'])
        self.assertEqual(module.select_hyphenator, 'unchanged')

    def test_renderer_uses_the_same_selector_for_layout_and_painting(self):
        self.prepare()
        module = SimpleNamespace()
        store = h.configure_renderer(module, self.directory, ['en'])
        self.assertIs(module.select_hyphenator('ENG'), store.select('en-GB'))
        self.assertFalse(store.describe()['network'])

    def test_corrupt_dictionary_is_rejected_and_explicit_prepare_repairs_it(self):
        self.prepare()
        path = h.resource_path(self.directory, self.records[0])
        path.write_bytes(b'corrupt')
        with self.assertRaisesRegex(RuntimeError, 'missing or corrupt'):
            h.DictionaryStore(self.directory, ['en'])
        with patch.object(prep, 'download', side_effect=AssertionError('unexpected network')):
            with self.assertRaisesRegex(RuntimeError, 'Missing or corrupt'):
                prep.prepare(self.directory, ['en'], verify_only=True)
        self.assertEqual(self.prepare()['downloaded_resources'], 1)

    def test_notices_are_required_and_verified(self):
        self.prepare()
        h.resource_path(self.directory, self.records[1]).write_bytes(b'altered notice')
        with self.assertRaisesRegex(RuntimeError, 'missing or corrupt'):
            h.DictionaryStore(self.directory, ['en'])

    def test_bad_download_never_becomes_an_installed_dictionary(self):
        with patch.object(prep, 'download', return_value=b'unexpected bytes'):
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                prep.prepare(self.directory, ['en'])
        self.assertFalse(h.resource_path(self.directory, self.records[0]).exists())
        self.assertFalse(list(self.directory.rglob('*.download')))

    def test_unsupported_language_is_checked_before_any_download(self):
        with patch.object(prep, 'download') as download:
            with self.assertRaises(ValueError):
                prep.prepare(self.directory, ['en', 'xx'])
        download.assert_not_called()

    def test_cjk_needs_no_resources(self):
        with patch.object(prep, 'download', side_effect=AssertionError('unexpected network')):
            result = prep.prepare(self.directory, ['zh-Hans', 'ja', 'ko'])
        self.assertEqual(result['downloaded_resources'], 0)
        self.assertEqual(result['languages'], [])


if __name__ == '__main__':
    unittest.main()
