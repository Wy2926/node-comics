import {locales, basePath, localPath, type Locale} from '../i18n/locales';

export const preferenceCookie = 'nc-site-locale';

export function browserLocale(languages: readonly string[]): Locale | undefined {
  for (const value of languages) {
    const language = value.toLowerCase().replaceAll('_', '-');
    const parts = language.split('-');
    if (parts[0] === 'zh') {
      if (parts.includes('hans')) return 'zh-CN';
      if (parts.includes('hant')) return 'zh-TW';
      return parts.some(part => ['tw','hk','mo'].includes(part)) ? 'zh-TW' : 'zh-CN';
    }
    if (parts[0] === 'pt') return 'pt-BR';
    const match = locales.find(locale => locale === parts[0]);
    if (match) return match;
  }
}

export function manualLocale(cookie: string): Locale | undefined {
  const value = cookie.split(';').map(item => item.trim()).find(item => item.startsWith(preferenceCookie + '='))?.slice(preferenceCookie.length + 1);
  return locales.find(locale => locale === value);
}

export function languageSuggestion(path: string, current: Locale, languages: readonly string[], cookie = '', dismissed?: string): Locale | undefined {
  const route = basePath(path);
  if (/^\/(?:translate|account|auth|payment|uninstall|404)(?:\/|$)/.test(route) || manualLocale(cookie)) return;
  const target = browserLocale(languages);
  return target && target !== current && dismissed !== target ? target : undefined;
}

export function languageTarget(url: URL, locale: Locale) {
  return localPath(url.pathname, locale) + url.search + url.hash;
}
