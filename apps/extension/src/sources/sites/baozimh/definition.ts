import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://cn.baozimh.com';
export const readerOrigin = 'https://cn.twbzmg.com';
const slug = /^[a-z0-9][a-z0-9_-]{0,299}$/;
const slot = /^(?:0|[1-9]\d{0,5})$/;
export interface BaoLocation {comic: string; section?: string; chapter?: string; part: number}
export function baoLocation(url: URL): BaoLocation | null {
  if (url.username || url.password || ![origin, readerOrigin].includes(url.origin)) return null;
  if (url.origin === origin) {
    const comic = /^\/comic\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (comic && slug.test(comic) && comic !== 'sitemap') return {comic, part: 1};
    if (url.pathname !== '/user/page_direct') return null;
    const keys = ['comic_id', 'section_slot', 'chapter_slot'];
    if (keys.some(key => url.searchParams.getAll(key).length !== 1)) return null;
    const [id, section, chapter] = keys.map(key => url.searchParams.get(key)!);
    return slug.test(id) && slot.test(section) && slot.test(chapter) ? {comic: id, section, chapter, part: 1} : null;
  }
  const match = /^\/comic\/chapter\/([^/]+)\/(\d+)_(\d+)(?:_([1-9]\d?))?\.html$/.exec(url.pathname);
  if (!match || !slug.test(match[1]) || !slot.test(match[2]) || !slot.test(match[3]) || match[4] && Number(match[4]) < 2) return null;
  return {comic: match[1], section: match[2], chapter: match[3], part: Number(match[4] ?? 1)};
}
export const catalogKey = (comic: string) => 'baozimh:' + comic;
export const catalogUrl = (comic: string) => origin + '/comic/' + comic;
export const chapterKey = (loc: BaoLocation) => `${catalogKey(loc.comic)}:${loc.section}:${loc.chapter}`;
export const chapterUrl = (loc: BaoLocation, part = 1) => `${readerOrigin}/comic/chapter/${loc.comic}/${loc.section}_${loc.chapter}${part > 1 ? '_' + part : ''}.html`;
export const definition: SourceDefinition = {
  id: 'baozimh', name: '包子漫画', installation,
  sites: [{id: 'baozimh', name: '包子漫画', url: origin + '/', icon, adaptedOn: '2026-09-27', isFree: true, contentTags: ['manhua', 'manga', 'manhwa'], primaryLanguages: ['zh-Hans'],
    search: {requestOrigins: [origin + '/*']}}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.username || url.password || ![origin, readerOrigin].includes(url.origin)) return null;
    const loc = baoLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: 'baozimh:' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter === undefined ? catalogKey(loc.comic) : chapterKey(loc),
      kind: loc.chapter === undefined ? 'catalog' : 'reader', url: url.href,
      catalog: {key: catalogKey(loc.comic), url: catalogUrl(loc.comic)}};
  },
};
