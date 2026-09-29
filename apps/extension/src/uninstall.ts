import {resolveLocale, validUiLanguage} from './i18n/locales';

const settingsKey = 'nc-reader-settings';
const readerLanguage = (settings: unknown) => settings && typeof settings === 'object' && 'uiLanguage' in settings ? settings.uiLanguage : undefined;

export function uninstallFeedbackUrl(preference: unknown, languages: readonly string[]): string {
  const locale = resolveLocale(validUiLanguage(preference) ? preference : 'auto', languages);
  const prefix = locale === 'zh-CN' ? '' : locale === 'zh-TW' ? '/zh-tw' : `/${['en', 'ja', 'ko'].includes(locale) ? locale : 'en'}`;
  // No account, installation identifier, reading history or credentials in this URL.
  return `https://comics.nodelane.net${prefix}/uninstall/`;
}

export function registerUninstallFeedback() {
  if (typeof chrome.runtime.setUninstallURL !== 'function') return;
  let pending = Promise.resolve();
  const update = () => {
    pending = pending.then(async () => {
      const saved = await chrome.storage.local.get(settingsKey);
      await chrome.runtime.setUninstallURL(uninstallFeedbackUrl(readerLanguage(saved[settingsKey]), navigator.languages));
    }).catch(() => { /* Do not interrupt the background if the browser rejects the URL. */ });
  };
  update(); // Runs on installation, update and each background restart.
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[settingsKey];
    if (area === 'local' && change && readerLanguage(change.newValue) !== readerLanguage(change.oldValue)) update();
  });
}
