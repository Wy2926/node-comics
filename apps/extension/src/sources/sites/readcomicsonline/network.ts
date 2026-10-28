import type {SourceNetwork} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceEntry, SourceSnapshot} from '../../contracts/source';
import {hasClass, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl} from './definition';
import {checkedHtml, coverUrl, imageUrl, location, one, readerWork, region, regions, sameChapter, text} from './html';
import {search, searchUrl} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = location(url);
  if (loc.chapter) throw Error('请使用 Read Comics Online 作品地址读取目录。');
  const safe = checkedHtml(html, loc), main = region(safe, 'main', () => true);
  const title = text(textContent(region(main, 'h1', () => true)));
  const poster = one(tags(main, 'img').filter(a => a.alt?.replace(/\s+/g, ' ').trim() === title));
  const cover = coverUrl(text(poster.src), loc.slug);
  const section = one(regions(main, 'section', () => true).filter(s =>
    regions(s.body, 'h2', () => true).some(h => textContent(h.body) === 'Chapters'))).body;
  const list = region(section, 'div', a => !!hasClass(a, 'divide-y'));
  if (/<(?:button|nav|form)\b/i.test(section) || tags(section, 'a').length !== tags(list, 'a').length)
    throw Error('Read Comics Online 目录分页结构未支持。');
  const rows = regions(list, 'a', () => true);
  if (!rows.length || rows.length > 10000 || rows.length !== tags(list, 'a').length ||
      list.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, '').trim()) throw Error('Read Comics Online 目录不完整。');
  const id = catalogKey(loc.slug), seen = new Set<string>();
  // The source's Read First / Next Chapter follow this reversed list, including named issues.
  const entries: SourceEntry[] = rows.reverse().map((row, order) => {
    const target = location(text(row.attrs.href));
    if (target.slug !== loc.slug || !target.chapter || target.page || seen.has(target.chapter))
      throw Error('Read Comics Online 章节重复或归属错误。');
    seen.add(target.chapter);
    const label = text(textContent(region(row.body, 'span', a => !!hasClass(a, 'font-medium'))));
    if (!label.startsWith(title + ' #')) throw Error('Read Comics Online 章节标题归属错误。');
    return {id: chapterKey(target), catalogId: id, remoteId: target.chapter, url: chapterUrl(target), title: label,
      groupIds: ['chapters'], rawTypes: [], order, related: false, sequenceId: id};
  });
  const first = one(regions(main, 'a', () => true).filter(a => textContent(a.body) === 'Read First'));
  if (chapterKey(location(text(first.attrs.href))) !== entries[0].id) throw Error('Read Comics Online 目录起点不一致。');
  return {id, sourceId: 'readcomicsonline', url: catalogUrl(loc.slug), title, cover, observedAt: Date.now(), complete: true, note: '',
    entries, groups: [{id: 'chapters', title: 'Chapters', entryIds: entries.map(e => e.id), complete: true}], defaultEntryId: entries[0].id};
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const loc = location(url);
  if (!loc.chapter) throw Error('Read Comics Online 章节地址无效。');
  const safe = region(checkedHtml(html, loc), 'main', () => true);
  if (regions(safe, 'h1', () => true).some(heading => textContent(heading.body) === 'No pages uploaded yet'))
    throw Error('Read Comics Online 此章节尚未上传图片，请稍后回源检查。');
  const work = readerWork(safe, loc);
  const pager = region(safe, 'select', a => a.id === 'page-list'), slots = regions(pager, 'option', () => true);
  const strip = region(safe, 'div', a => a.id === 'reader-all'), images = tags(strip, 'img');
  if (!slots.length || slots.length > 1500 || slots.length !== tags(pager, 'option').length || images.length !== slots.length)
    throw Error('Read Comics Online 正文页数不完整。');
  slots.forEach((slot, order) => {
    const target = location(text(slot.attrs.value));
    if (!sameChapter(target, loc) || target.page !== order + 1 || textContent(slot.body) !== `Page ${order + 1}`)
      throw Error('Read Comics Online 正文页序不一致。');
  });
  const items = images.map((img, order) => {
    if (img.alt?.replace(/\s+/g, ' ').trim() !== `${work.chapterTitle} page ${order + 1}`) throw Error('Read Comics Online 正文页槽不一致。');
    return {id: 'page-' + order, order, width: 0, height: 0, resource: {kind: 'http' as const, url: imageUrl(text(img.src), loc)}};
  });
  return {url, adapter: 'readcomicsonline', title: work.chapterTitle, direction: 'ltr', note: '',
    discoveryComplete: true, knownTotal: items.length, items};
}
export const network = {
  pageTransport: ['catalog', 'pages'], search,
  searchPage: request => searchUrl(request).url,
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter) throw Error('请使用 Read Comics Online 作品地址读取目录。');
    context.signal?.throwIfAborted();
    const html = await context.request(catalogUrl(loc.slug));
    context.signal?.throwIfAborted();
    return parseCatalog(html, url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw Error('Read Comics Online 章节地址无效。');
    context.signal?.throwIfAborted();
    const html = await context.request(chapterUrl(loc));
    context.signal?.throwIfAborted();
    return parsePages(html, url);
  },
} satisfies SourceNetwork;
