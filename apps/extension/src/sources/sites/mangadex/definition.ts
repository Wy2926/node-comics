import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://mangadex.org';
export const apiOrigin = 'https://api.mangadex.org';
export const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const uuid = new RegExp('^' + uuidPattern + '$', 'i');
export const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
export const catalogUrl = (id: string) => `${origin}/title/${id}`;
export const chapterUrl = (id: string, mangaId?: string) => `${origin}/chapter/${id}${mangaId ? '#nodelane-mangadex=' + mangaId : ''}`;

export function mangaDexLocation(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const title = new RegExp(`^/title/(${uuidPattern})(?:/[^/]+)?/?$`, 'i').exec(url.pathname);
  if (title) return {mangaId: title[1].toLowerCase(), chapterId: undefined};
  const chapter = new RegExp(`^/chapter/(${uuidPattern})(?:/[1-9]\\d*)?/?$`, 'i').exec(url.pathname);
  if (!chapter) return null;
  // Locally supplied parent binding; HTTP chapter metadata must confirm it before page discovery.
  const binding = new RegExp(`^#nodelane-mangadex=(${uuidPattern})$`, 'i').exec(url.hash);
  if (url.hash.startsWith('#nodelane-mangadex') && !binding) return null;
  return {mangaId: binding?.[1].toLowerCase(), chapterId: chapter[1].toLowerCase()};
}

export const definition: SourceDefinition = {
  id: 'mangadex', name: 'MangaDex',
  sites: [{id: 'mangadex', name: 'MangaDex', url: origin + '/', icon, primaryLanguages: ['en', 'es', 'pt-BR', 'fr'] }],
  capabilities: {importable: true, pages: true, inline: false, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720}, installation,
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = mangaDexLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapterId ? `mangadex:chapter:${loc.chapterId}` : `mangadex:${loc.mangaId}`,
      kind: loc.chapterId ? 'reader' : 'catalog', url: url.href,
      ...(loc.mangaId ? {catalog: {key: `mangadex:${loc.mangaId}`, url: catalogUrl(loc.mangaId)}} : {})};
  },
};
