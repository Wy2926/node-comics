import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl} from './definition';
import {byClass, canonical, chapterNumber, coverUrl, imageSource, imageUrl, location, one, pageNumber, readerInfo, regions, text} from './html';
import {search} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = location(url), safe = inertHtml(html);
  if (loc.chapter) throw Error('请使用 MangaDNA 作品详情页链接。');
  canonical(safe, loc);
  const title = text(textContent(one(regions(byClass(safe, 'div', 'post-title'), 'h1', () => true), '作品标题').body));
  const panel = one(regions(safe, 'div', a => a.id === 'chapterlist' && !!hasClass(a, 'panel-manga-chapter')), '完整目录');
  const list = byClass(panel.body, 'ul', 'row-content-chapter');
  const rows = regions(list, 'li', () => true), seen = new Map<string, string>(), id = catalogKey(loc.slug);
  if (!rows.length || rows.length > 10000 || tags(list, 'a').length !== rows.length) throw Error('MangaDNA 目录未完整获取。');
  // The full server list is newest first, including rows hidden by Show more.
  const entries = rows.reverse().flatMap(row => {
    const link = one(regions(row.body, 'a', a => !!hasClass(a, 'chapter-name')), '章节链接');
    const target = location(text(link.attrs.href));
    const label = text(textContent(link.body));
    if (target.slug !== loc.slug || !target.chapter || seen.has(target.chapter) && seen.get(target.chapter) !== label)
      throw Error('MangaDNA 章节重复或归属错误。');
    if (seen.has(target.chapter)) return [];
    const order = seen.size;
    seen.set(target.chapter, label);
    return [{id: chapterKey(target), catalogId: id, remoteId: target.chapter, url: chapterUrl(target),
      title: label, groupIds: ['chapters'], rawTypes: [], order, related: false, sequenceId: id}];
  });
  const cover = one(tags(byClass(safe, 'div', 'summary_image'), 'img'), '作品封面');
  return {id, sourceId: 'mangadna', url: catalogUrl(loc.slug), title, cover: coverUrl(cover['data-src'] || cover.src),
    observedAt: Date.now(), complete: true, note: '',
    groups: [{id: 'chapters', title: 'Latest Manga Releases', entryIds: entries.map(e => e.id), complete: true}],
    entries, defaultEntryId: entries[0].id};
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const loc = location(url), safe = inertHtml(html), info = readerInfo(safe, loc);
  const viewer = byClass(safe, 'div', 'read-content'), images = tags(viewer, 'img');
  if (!images.length || images.length > 1500 || /<(?:iframe|canvas|picture|source)\b/i.test(viewer))
    throw Error('MangaDNA 未提供完整正文。');
  let directory = '', previous = 0;
  const chapter = chapterNumber(info.label);
  const items = images.map(image => {
    const raw = text(image['data-src'] || image.src, 8192), source = imageSource(raw), resource = source.href;
    const currentDirectory = source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1);
    const number = pageNumber(image.alt, info.chapterTitle);
    if (!number || number <= previous || !hasClass(image, 'loading') ||
        image.src && image.src !== raw && imageUrl(image.src) !== resource || directory && currentDirectory !== directory ||
        chapter && currentDirectory.split('/').at(-2) !== chapter)
      throw Error('MangaDNA 正文缺页、页序或图片归属不一致。');
    directory = currentDirectory;
    previous = number;
    const order = previous - 1;
    return {id: 'page-' + order, order, width: 0, height: 0, resource: {kind: 'http' as const, url: resource}};
  });
  const complete = previous === items.length;
  return {url, adapter: 'mangadna', title: info.chapterTitle, direction: 'ltr',
    note: complete ? '' : 'MangaDNA 源站正文缺页；已保留原页序，可阅读已提供的页面。',
    discoveryComplete: complete, knownTotal: previous, items};
}
async function request(url: string, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(url);
  context.signal?.throwIfAborted();
  return html;
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter) throw Error('请使用 MangaDNA 作品详情页链接。');
    return parseCatalog(await request(catalogUrl(loc.slug), context), url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw Error('MangaDNA 章节地址无效。');
    return parsePages(await request(chapterUrl(loc), context), url);
  },
} satisfies SourceNetwork;
