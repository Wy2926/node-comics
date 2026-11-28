import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://cn.baozimh.com';
const slug = /^[a-z0-9][a-z0-9_-]{0,299}$/;
const slot = /^(?:0|[1-9]\d{0,5})$/;
function editionOf(url: URL) {
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = /^(?:(cn|tw|www)\.)?(?:baozimh|twbzmg)\.com$/.exec(url.host);
  // 裸域跳到 www；地区只决定访问哪一对站点，不参与作品和章节标识。
  return host && (host[1] ?? 'www');
}
export interface BaoLocation {edition: string; comic: string; section?: string; chapter?: string; part: number}
export function baoLocation(url: URL): BaoLocation | null {
  const edition = editionOf(url);
  if (!edition) return null;
  if (url.hostname.endsWith('baozimh.com')) {
    const comic = /^\/comic\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (comic && slug.test(comic) && comic !== 'sitemap') return {edition, comic, part: 1};
    if (url.pathname === '/user/page_direct') {
      const keys = ['comic_id', 'section_slot', 'chapter_slot'];
      if (keys.some(key => url.searchParams.getAll(key).length !== 1)) return null;
      const [id, section, chapter] = keys.map(key => url.searchParams.get(key)!);
      return slug.test(id) && slot.test(section) && slot.test(chapter) ? {edition, comic: id, section, chapter, part: 1} : null;
    }
  }
  const match = /^\/comic\/chapter\/([^/]+)\/(\d+)_(\d+)(?:_([1-9]\d?))?\.html$/.exec(url.pathname);
  if (!match || !slug.test(match[1]) || !slot.test(match[2]) || !slot.test(match[3]) || match[4] && Number(match[4]) < 2) return null;
  return {edition, comic: match[1], section: match[2], chapter: match[3], part: Number(match[4] ?? 1)};
}
export const catalogKey = (comic: string) => 'baozimh:' + comic;
export const catalogUrl = (loc: BaoLocation) => `https://${loc.edition}.baozimh.com/comic/${loc.comic}`;
export const chapterKey = (loc: BaoLocation) => `${catalogKey(loc.comic)}:${loc.section}:${loc.chapter}`;
export const chapterUrl = (loc: BaoLocation, part = 1) => `https://${loc.edition}.twbzmg.com/comic/chapter/${loc.comic}/${loc.section}_${loc.chapter}${part > 1 ? '_' + part : ''}.html`;
export function matchesBaoPage(raw: string | null | undefined, expected: string) {
  if (!raw || !URL.canParse(raw)) return false;
  const url = new URL(raw);
  // 规范地址、目录按钮和续页可指向不同别名，但路径必须完全一致，也不能夹带参数。
  return !!baoLocation(url) && url.href === url.origin + new URL(expected).pathname;
}
export const definition: SourceDefinition = {
  id: 'baozimh', name: '包子漫画', installation,
  sites: [{id: 'baozimh', name: '包子漫画', url: origin + '/', icon, adaptedOn: '2026-09-27', pricing: 'free', isRaw: false, contentTags: ['manhua', 'manga', 'manhwa', 'webtoon'], primaryLanguages: ['zh-Hans', 'zh-Hant'],
    search: true}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!editionOf(url)) return null;
    const loc = baoLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: 'baozimh:' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter === undefined ? catalogKey(loc.comic) : chapterKey(loc),
      kind: loc.chapter === undefined ? 'catalog' : 'reader', url: url.href,
      catalog: {key: catalogKey(loc.comic), url: catalogUrl(loc)}};
  },
};
