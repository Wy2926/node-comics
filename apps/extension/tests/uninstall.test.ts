import {afterEach, expect, it, vi} from 'vitest';
import {registerUninstallFeedback, uninstallFeedbackUrl} from '../src/uninstall';
import {uiLanguages} from '../src/i18n/locales';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['zh-CN', ['en'], '/uninstall/'], ['zh-TW', ['en'], '/zh-tw/uninstall/'],
  ['ja', ['en'], '/ja/uninstall/'], ['ko', ['en'], '/ko/uninstall/'],
  ['en', ['zh-CN'], '/en/uninstall/'],
  ['auto', ['zh-HK'], '/zh-tw/uninstall/'], ['auto', ['zh'], '/uninstall/'],
  ['auto', ['fr', 'zh-CN'], '/en/uninstall/'], ['auto', ['ar'], '/en/uninstall/'],
  ['fr', ['zh'], '/en/uninstall/'], ['invalid', ['en-US'], '/en/uninstall/'],
])('uses the supported website language without private URL parameters: %s', (preference, languages, path) => {
  expect(uninstallFeedbackUrl(preference, languages as string[])).toBe('https://comics.nodelane.net' + path);
});

it.each(uiLanguages.filter(language => !['zh-CN', 'zh-TW', 'en', 'ja', 'ko'].includes(language.id)))('falls back to English for unsupported website language $id, regardless of browser language', language => {
  expect(uninstallFeedbackUrl(language.id, ['zh-CN', 'ja'])).toBe('https://comics.nodelane.net/en/uninstall/');
});

it('registers on background start and updates after language changes, recovering from rejection', async () => {
  let settings = {uiLanguage: 'en'};
  let onChanged: (changes: Record<string, unknown>, area: string) => void = () => {};
  const setUninstallURL = vi.fn().mockRejectedValueOnce(Error('Temporary failure')).mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {languages: ['en']});
  vi.stubGlobal('chrome', {
    runtime: {setUninstallURL}, storage: {
      local: {get: async () => ({'nc-reader-settings': settings})},
      onChanged: {addListener: (listener: typeof onChanged) => {onChanged = listener;}},
    },
  });
  registerUninstallFeedback();
  await vi.waitFor(() => expect(setUninstallURL).toHaveBeenCalledOnce());
  settings = {uiLanguage: 'ja'};
  onChanged({'nc-reader-settings': {newValue: settings}}, 'local');
  await vi.waitFor(() => expect(setUninstallURL).toHaveBeenLastCalledWith('https://comics.nodelane.net/ja/uninstall/'));
  settings = {uiLanguage: 'fr'};
  onChanged({'nc-reader-settings': {oldValue: {uiLanguage: 'ja'}, newValue: settings}}, 'local');
  await vi.waitFor(() => expect(setUninstallURL).toHaveBeenLastCalledWith('https://comics.nodelane.net/en/uninstall/'));
  onChanged({'nc-reader-settings': {oldValue: {...settings, textScale: 1}, newValue: {...settings, textScale: 1.25}}}, 'local');
  onChanged({'nc-reader-settings': {}}, 'session');
  // Let any mistakenly queued update reach the browser mock before asserting.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(setUninstallURL).toHaveBeenCalledTimes(3);
});
