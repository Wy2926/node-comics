import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://readcomicsonline.ru';
export interface ComicLocation {slug: string; chapter?: string; page?: number}
export function comicLocation(url: URL): ComicLocation | null {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/comic\/([a-z0-9][a-z0-9_-]{0,511})(?:\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})(?:\/([1-9]\d{0,3}))?)?\/?$/.exec(url.pathname);
  return match ? {slug: match[1], ...(match[2] ? {chapter: match[2]} : {}), ...(match[3] ? {page: Number(match[3])} : {})} : null;
}
export const catalogKey = (slug: string) => 'readcomicsonline:' + slug;
export const catalogUrl = (slug: string) => `${origin}/comic/${slug}`;
export const chapterKey = (loc: ComicLocation) => `${catalogKey(loc.slug)}:${loc.chapter}`;
export const chapterUrl = (loc: ComicLocation) => `${catalogUrl(loc.slug)}/${loc.chapter}`;

export const definition: SourceDefinition = {
  id: 'readcomicsonline', name: 'Read Comics Online', installation,
  sites: [{id: 'readcomicsonline', name: 'Read Comics Online', url: origin + '/', icon,
    primaryLanguages: ['en'], adaptedOn: '2026-10-27', pricing: 'free', isRaw: false, isAdult: false, contentTags: ['western'],
    search: true, searchPageSize: 60}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = comicLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: 'readcomicsonline:' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.slug),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href, catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc.slug)}};
  },
};
