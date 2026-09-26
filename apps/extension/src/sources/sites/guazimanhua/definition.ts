import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://www.guazimanhua.com';
const validId = (id: string | null): id is string => !!id && /^[1-9]\d{0,9}$/.test(id);
export function guaziLocation(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const id = url.searchParams.get('id');
  if (!validId(id) || url.searchParams.getAll('id').length !== 1) return null;
  if (url.pathname === '/comic.php') return {comicId: id, chapterId: undefined};
  if (url.pathname !== '/chapter.php') return null;
  // The fragment is a local catalog binding, never sent to the source server.
  const binding = /^#nodelane-guazimanhua=([1-9]\d{0,9})$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-guazimanhua') && !binding) return null;
  return {comicId: binding?.[1], chapterId: id};
}
export const catalogUrl = (id: string) => `${origin}/comic.php?id=${id}`;
export const chapterUrl = (id: string, comicId?: string) => `${origin}/chapter.php?id=${id}${comicId ? '#nodelane-guazimanhua=' + comicId : ''}`;
export const definition: SourceDefinition = {
  id: 'guazimanhua', name: '瓜子漫画',
  sites: [{id: 'guazimanhua', name: '瓜子漫画', url: origin + '/', icon, primaryLanguages: ['zh-Hans'],
    search: {requestOrigins: [origin + '/*']} }],
  capabilities: {importable: true, pages: true, inline: false, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720}, installation,
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = guaziLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapterId ? `guazimanhua:chapter:${loc.chapterId}` : `guazimanhua:${loc.comicId}`,
      kind: loc.chapterId ? 'reader' : 'catalog', url: url.href,
      ...(loc.comicId ? {catalog: {key: `guazimanhua:${loc.comicId}`, url: catalogUrl(loc.comicId)}} : {})};
  },
};
