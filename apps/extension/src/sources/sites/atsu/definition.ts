import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://atsu.moe';
export const cdnOrigin = 'https://cdn.atsu.moe';
export const identifier = '[A-Za-z0-9_-]{1,64}';
export const catalogUrl = (id: string) => `${origin}/manga/${id}`;
export const chapterUrl = (mangaId: string, chapterId: string) => `${origin}/read/${mangaId}/${chapterId}`;
export const chapterKey = (mangaId: string, chapterId: string) => `atsu:${mangaId}:chapter:${chapterId}`;
export function atsuLocation(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const manga = new RegExp(`^/manga/(${identifier})/?$`).exec(url.pathname);
  if (manga) return {mangaId: manga[1], chapterId: undefined};
  const chapter = new RegExp(`^/read/(${identifier})/(${identifier})/?$`).exec(url.pathname);
  return chapter ? {mangaId: chapter[1], chapterId: chapter[2]} : null;
}
export const definition: SourceDefinition = {
  id: 'atsu', name: 'Atsumaru', installation,
  sites: [{id: 'atsu', name: 'Atsumaru', url: origin + '/', icon, primaryLanguages: ['en'],
    search: {requestOrigins: [origin + '/*']}}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720}, embeddedEntry: 'floating',
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = atsuLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapterId ? chapterKey(loc.mangaId, loc.chapterId) : `atsu:${loc.mangaId}`,
      kind: loc.chapterId ? 'reader' : 'catalog', url: url.href, catalog: {key: `atsu:${loc.mangaId}`, url: catalogUrl(loc.mangaId)}};
  },
};
