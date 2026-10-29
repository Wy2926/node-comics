import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://www.goodtoon008.com';
const isOrigin = (url: URL) => url.origin === origin && !url.username && !url.password;
export interface MangaLocation {slug: string; chapter?: string}
export function mangaLocation(url: URL): MangaLocation | null {
  if (!isOrigin(url) || url.hash || /%2f|%5c/i.test(url.pathname)) return null;
  let path: string;
  try {path = decodeURIComponent(url.pathname);} catch {return null;}
  // The site's first/latest buttons use the verified 1권 alias; canonical and AJAX URLs omit it.
  const match = /^\/manga\/(gt-[1-9]\d{0,11})(?:\/(?:1권\/)?([a-z0-9]+(?:[._-][a-z0-9]+)*))?\/?$/.exec(path);
  if (!match || (match[2]?.length ?? 0) > 100 ||
      url.search && (!match[2] || [...url.searchParams].length !== 1 || url.searchParams.get('style') !== 'list')) return null;
  return {slug: match[1], ...(match[2] ? {chapter: match[2]} : {})};
}
export const catalogKey = (slug: string) => `goodtoon:manga:${slug}`;
export const catalogUrl = (slug: string) => `${origin}/manga/${slug}/`;
export const chapterKey = (loc: MangaLocation) => `${catalogKey(loc.slug)}:${loc.chapter}`;
export const chapterUrl = (loc: MangaLocation) => `${catalogUrl(loc.slug)}${loc.chapter}/`;
export const definition: SourceDefinition = {
  id: 'goodtoon', name: 'GoodToon', installation,
  sites: [{id: 'goodtoon', name: 'GoodToon', url: origin + '/', icon, adaptedOn: '2026-10-23',
    pricing: 'free', contentTags: ['manhwa', 'webtoon'], isRaw: true, primaryLanguages: ['ko'], search: true, searchPageSize: 63}],
  capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!isOrigin(url)) return null;
    const loc = mangaLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.slug),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href, catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc.slug)}};
  },
};
