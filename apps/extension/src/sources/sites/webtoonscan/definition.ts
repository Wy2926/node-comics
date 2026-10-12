import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://webtoonscan.com';
export const isOrigin = (url: URL) => url.origin === origin && !url.username && !url.password;
export interface WebtoonLocation {slug: string; chapter?: string}
export function webtoonLocation(url: URL): WebtoonLocation | null {
  if (!isOrigin(url) || url.hash) return null;
  const match = /^\/manhwa\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([a-z0-9]+(?:[.-][a-z0-9]+)*))?\/?$/.exec(url.pathname);
  if (!match || match[1].length > 300 || (match[2]?.length ?? 0) > 100) return null;
  if (url.search && (!match[2] || [...url.searchParams].length !== 1 || !['list', 'paged'].includes(url.searchParams.get('style') ?? ''))) return null;
  return {slug: match[1], ...(match[2] ? {chapter: match[2]} : {})};
}
export const catalogKey = (slug: string) => `webtoonscan:manhwa:${slug}`;
export const catalogUrl = (slug: string) => `${origin}/manhwa/${slug}/`;
export const chapterKey = (loc: WebtoonLocation) => `${catalogKey(loc.slug)}:${loc.chapter}`;
export const chapterUrl = (loc: WebtoonLocation) => `${catalogUrl(loc.slug)}${loc.chapter}/`;
export const definition: SourceDefinition = {
  id: 'webtoonscan', name: 'WebtoonScan', installation,
  sites: [{id: 'webtoonscan', name: 'WebtoonScan', url: origin + '/', icon, adaptedOn: '2026-10-12',
    pricing: 'free', contentTags: ['manhwa', 'webtoon'], isRaw: false, primaryLanguages: ['en', 'ko'], search: true}],
  capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!isOrigin(url)) return null;
    const loc = webtoonLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.slug),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc.slug)}};
  },
};
