import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://mangaeclipse.com';
export const isOrigin = (url: URL) => url.origin === origin && !url.username && !url.password;
export interface EclipseLocation {slug: string; chapter?: string}
export function eclipseLocation(url: URL): EclipseLocation | null {
  if (!isOrigin(url) || url.hash) return null;
  const match = /^\/manga\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([a-z0-9]+(?:[.-][a-z0-9]+)*))?\/?$/.exec(url.pathname);
  if (!match || match[1].length > 300 || (match[2]?.length ?? 0) > 100) return null;
  if (url.search && (!match[2] || [...url.searchParams].length !== 1 || !['list', 'paged'].includes(url.searchParams.get('style') ?? ''))) return null;
  return {slug: match[1], ...(match[2] ? {chapter: match[2]} : {})};
}
export const catalogKey = (slug: string) => `mangaeclipse:manga:${slug}`;
export const catalogUrl = (slug: string) => `${origin}/manga/${slug}/`;
export const chapterKey = (loc: EclipseLocation) => `${catalogKey(loc.slug)}:${loc.chapter}`;
export const chapterUrl = (loc: EclipseLocation) => `${catalogUrl(loc.slug)}${loc.chapter}/`;

export const definition: SourceDefinition = {
  id: 'mangaeclipse', name: 'Manga Eclipse', installation,
  sites: [{id: 'mangaeclipse', name: 'Manga Eclipse', url: origin + '/', icon, adaptedOn: '2026-10-15',
    pricing: 'unknown', contentTags: ['manhua'], isRaw: false, primaryLanguages: ['en'], search: true}],
  capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!isOrigin(url)) return null;
    const loc = eclipseLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.slug),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc.slug)}};
  },
};
