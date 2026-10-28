import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://hunlightcomics.com';
const isOrigin = (url: URL) => url.origin === origin && !url.username && !url.password;
export interface MangaLocation {slug: string; chapter?: string}
export function mangaLocation(url: URL): MangaLocation | null {
  if (!isOrigin(url) || url.hash) return null;
  const match = /^\/m\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([a-z0-9]+(?:[._-][a-z0-9]+)*))?\/?$/.exec(url.pathname);
  if (!match || match[1].length > 300 || (match[2]?.length ?? 0) > 100) return null;
  if (url.search && (!match[2] || [...url.searchParams].length !== 1 || !['list', 'paged'].includes(url.searchParams.get('style') ?? ''))) return null;
  return {slug: match[1], ...(match[2] ? {chapter: match[2]} : {})};
}
export const catalogKey = (slug: string) => `hunlightcomics:manga:${slug}`;
export const catalogUrl = (slug: string) => `${origin}/m/${slug}/`;
export const chapterKey = (loc: MangaLocation) => `${catalogKey(loc.slug)}:${loc.chapter}`;
export const chapterUrl = (loc: MangaLocation) => `${catalogUrl(loc.slug)}${loc.chapter}/`;
export const definition: SourceDefinition = {
  id: 'hunlightcomics', name: 'Hunlight Comics', installation,
  sites: [{id: 'hunlightcomics', name: 'Hunlight Comics', url: origin + '/', icon, adaptedOn: '2026-10-23',
    pricing: 'free', contentTags: ['manga'], isRaw: false, isAdult: false, primaryLanguages: ['en'], search: true}],
  capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!isOrigin(url)) return null;
    const loc = mangaLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.slug),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc.slug)}};
  },
};
