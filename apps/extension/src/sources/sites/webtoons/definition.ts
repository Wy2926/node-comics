import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://www.webtoons.com';
export const languages = {en: 'en', 'zh-hant': 'zh-Hant', th: 'th', id: 'id', es: 'es', fr: 'fr', de: 'de'} as const;
export function location(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/(en|zh-hant|th|id|es|fr|de)\/([^/]+)\/([^/]+)\/(?:(list)|([^/]+)\/viewer)$/.exec(url.pathname);
  const title = url.searchParams.get('title_no'), episode = url.searchParams.get('episode_no');
  const valid = (value: string | null): value is string => !!value && /^[1-9]\d{0,9}$/.test(value);
  if (!match || !valid(title) || url.searchParams.getAll('title_no').length !== 1 ||
    (match[4] ? episode !== null : !valid(episode) || url.searchParams.getAll('episode_no').length !== 1)) return null;
  const language = match[1] as keyof typeof languages, section = match[2] === 'canvas' ? 'canvas' : 'originals';
  const key = `webtoons:${language}:${section}:${title}`;
  return {language, section, title, episode: episode ?? undefined, key,
    catalogUrl: `${origin}/${language}/${match[2]}/${match[3]}/list?title_no=${title}`};
}
export const definition: SourceDefinition = {
  id: 'webtoons', name: 'WEBTOON', installation,
  sites: Object.entries(languages).map(([locale, language]) => ({id: 'webtoons-' + locale,
    name: 'WEBTOON · ' + ({en: 'English', 'zh-hant': '繁體中文', th: 'ภาษาไทย', id: 'Indonesia', es: 'Español', fr: 'Français', de: 'Deutsch'}[locale]),
    url: `${origin}/${locale}/`, icon, adaptedOn: '2026-09-27', accessTags: ['login-required', 'partial-web', 'paid-content'], contentTags: ['webtoon'], primaryLanguages: [language], search: {requestOrigins: [origin + '/*']}})),
  capabilities: {importable: true, catalog: true, pages: true, completePageList: true, inline: true},
  catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = location(url);
    return loc ? {sourceId: this.id, kind: loc.episode ? 'reader' : 'catalog', url: url.href,
      pageKey: loc.key + (loc.episode ? ':episode:' + loc.episode : ''), catalog: {key: loc.key, url: loc.catalogUrl}}
      : {sourceId: this.id, kind: 'other', url: url.href, pageKey: 'webtoons:' + url.href};
  },
};
