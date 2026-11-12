import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://ridibooks.com';
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
export const catalogUrl = (id: string) => `${origin}/books/${id}`;
export const catalogKey = (id: string) => `ridi:series:${id}`;
export const episodeKey = (id: string) => `ridi:episode:${id}`;
export const episodeUrl = (id: string, series?: string) => `${catalogUrl(id)}/view${series ? '#nodelane-ridi=' + series : ''}`;
export function location(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/books\/([1-9]\d{0,19})(\/view)?\/?$/.exec(url.pathname);
  if (!match) return null;
  const binding = /^#nodelane-ridi=([1-9]\d{0,19})$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-ridi') && (!binding || !match[2])) return null;
  return {bookId: match[1], reader: !!match[2], seriesId: match[2] ? binding?.[1] : match[1]};
}
export const definition: SourceDefinition = {
  id: 'ridi', name: 'RIDI / 리디', installation,
  sites: [{id: 'ridi', name: 'RIDI / 리디', url: origin + '/webtoon/recommendation', icon, adaptedOn: '2026-11-12',
    pricing: 'freemium', isRaw: true, primaryLanguages: ['ko'], contentTags: ['manhwa', 'webtoon'], accessTags: ['login-required', 'partial-web']}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = location(url);
    if (!loc) return {sourceId: this.id, kind: 'other', pageKey: this.id + ':' + url.href, url: url.href};
    return {sourceId: this.id, kind: loc.reader ? 'reader' : 'catalog', url: url.href,
      pageKey: loc.reader ? episodeKey(loc.bookId) : catalogKey(loc.bookId),
      ...(loc.seriesId ? {catalog: {key: catalogKey(loc.seriesId), url: catalogUrl(loc.seriesId)}} : {})};
  },
};
