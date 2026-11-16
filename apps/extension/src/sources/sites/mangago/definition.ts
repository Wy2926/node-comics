import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://www.mangago.me';
export interface MangagoLocation {work: string; chapter?: string; page?: number; numbered?: boolean}
export function mangagoLocation(url: URL): MangagoLocation | null {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/read-manga\/([a-z0-9][a-z0-9_-]{0,199})(?:\/(.*?))?\/?$/.exec(url.pathname);
  if (!match) return null;
  const work = match[1], route = (match[2] ?? '').replace(/\/$/, '');
  if (!route) return {work};
  const chapter = /^([a-z][a-z0-9]{0,15}\/(?:[a-z]+(?:_v-\d+(?:\.\d+)?-chapter|_chapter)-\d+(?:\.\d+)?|v(?:\d+|TBD)\/c\d+(?:\.\d+)?|[a-z0-9_-]+\/\d+(?:\.\d+)?))(?:\/(pg-)?([1-9]\d{0,3}))?$/.exec(route);
  if (!chapter || Number(chapter[3] ?? 1) > 1500) return null;
  return {work, chapter: chapter[1], page: Number(chapter[3] ?? 1),
    numbered: /\/d_chapter-/.test(chapter[1]) || /\/[a-z0-9_-]+\/\d/.test(chapter[1])};
}
export const catalogKey = (work: string) => 'mangago:' + work;
export const catalogUrl = (work: string) => `${origin}/read-manga/${work}/`;
export const chapterKey = (loc: MangagoLocation) => `${catalogKey(loc.work)}:chapter:${loc.chapter}`;
export const chapterUrl = (loc: MangagoLocation) => `${catalogUrl(loc.work)}${loc.chapter}/${loc.numbered ? '' : 'pg-1/'}`;
export const definition: SourceDefinition = {
  id: 'mangago', name: 'Mangago', installation,
  sites: [{id: 'mangago', name: 'Mangago', url: origin + '/', icon, adaptedOn: '2026-11-15',
    pricing: 'free', isRaw: false, contentTags: ['manga', 'manhwa', 'manhua'], primaryLanguages: ['en'], search: true}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = mangagoLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: 'mangago:' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.work),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href, catalog: {key: catalogKey(loc.work), url: catalogUrl(loc.work)}};
  },
};
