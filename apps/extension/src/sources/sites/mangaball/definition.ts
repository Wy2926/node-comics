import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://mangaball.com';
export const apiOrigin = 'https://api.mangaball.com';
export const api = apiOrigin + '/api/v1';
export const catalogUrl = (id: string) => `${origin}/title-detail/${id}`;
export const chapterUrl = (id: string, titleId?: string) => `${origin}/chapter-detail/${id}${titleId ? '#nodelane-mangaball=' + titleId : ''}`;
export const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{24}$/.test(value);
export function mangaBallLocation(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const title = /^\/title-detail\/([a-f\d]{24})(?:-[a-z\d][a-z\d-]*)?\/?$/.exec(url.pathname);
  if (title) return {titleId: title[1], chapterId: undefined};
  const chapter = /^\/chapter-detail\/([a-f\d]{24})\/?$/.exec(url.pathname);
  if (!chapter || url.searchParams.getAll('chapter').length > 1 || url.searchParams.has('chapter') && !/^\d+(?:\.\d+)?$/.test(url.searchParams.get('chapter')!)) return null;
  const binding = /^#nodelane-mangaball=([a-f\d]{24})$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-mangaball') && !binding) return null;
  return {titleId: binding?.[1], chapterId: chapter[1]};
}
export const definition: SourceDefinition = {
  id: 'mangaball', name: 'MangaBall', installation, embeddedEntry: 'floating',
  sites: [{id: 'mangaball', name: 'MangaBall', url: origin + '/', icon, adaptedOn: '2026-10-02', isFree: true, contentTags: ['manga', 'manhwa'], primaryLanguages: ['en', 'vi', 'es', 'id'],
    search: {requestOrigins: [apiOrigin + '/*']}}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = mangaBallLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapterId ? `mangaball:chapter:${loc.chapterId}` : `mangaball:${loc.titleId}`,
      kind: loc.chapterId ? 'reader' : 'catalog', url: url.href,
      ...(loc.titleId ? {catalog: {key: 'mangaball:' + loc.titleId, url: catalogUrl(loc.titleId)}} : {})};
  },
};
