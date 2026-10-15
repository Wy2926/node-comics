import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl} from './definition';
import {byClass, byId, decodeBase64, imageUrl, label, location, one, readerInfo, regions, responseLocation, text} from './html';
import {search} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = responseLocation(html, url), safe = inertHtml(html);
  if (!loc.work || loc.chapter) throw Error('请使用 WeLoMa 作品详情页读取目录。');
  const title = label(one(regions(byClass(safe, 'ul', 'manga-info'), 'h3', () => true), '作品标题'));
  const poster = one(tags(byClass(safe, 'div', 'info-cover'), 'img'), '作品封面');
  const list = one(regions(safe, 'ul', a => !!hasClass(a, 'list-chapters') && !!hasClass(a, 'at-series')), '完整目录').body;
  const rows = regions(list, 'a', () => true), seen = new Set<string>(), id = catalogKey(loc.work);
  if (!rows.length || rows.length > 10000 || tags(list, 'li').length !== rows.length ||
      list.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, '').trim()) throw Error('WeLoMa 目录不完整或结构已变化。');
  // The complete static directory is newest first, including fractional releases.
  const entries = rows.reverse().map((row, order) => {
    const target = location(row.attrs.href);
    if (!target.chapter || target.work && target.work !== loc.work || seen.has(target.chapter))
      throw Error('WeLoMa 章节重复或归属错误。');
    seen.add(target.chapter);
    return {id: chapterKey(target.chapter), catalogId: id, remoteId: target.chapter, url: chapterUrl(target.chapter, loc.work),
      title: text(textContent(byClass(row.body, 'div', 'chapter-name'))), order,
      groupIds: ['chapters'], rawTypes: [], related: false, sequenceId: id};
  });
  return {id, sourceId: 'weloma', url: catalogUrl(loc.work), title, cover: {url: imageUrl(poster.src)},
    observedAt: Date.now(), complete: true, note: '', groups: [{id: 'chapters', title: 'Chapters',
      entryIds: entries.map(entry => entry.id), complete: true}], entries, defaultEntryId: entries[0].id};
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const info = readerInfo(html, url), viewer = byId(info.safe, 'div', 'chapter-images'), images = tags(viewer, 'img');
  if (!images.length || images.length > 1500 || images.some(a => !hasClass(a, 'chapter-img')) || /<(?:canvas|iframe|video)\b/i.test(viewer))
    throw Error('WeLoMa 未提供完整图片正文。');
  const items = images.map((img, order) => ({id: 'page-' + order, order, width: 0, height: 0,
    resource: {kind: 'http' as const, url: imageUrl(decodeBase64(img['data-img']))}}));
  return {url, adapter: 'weloma', title: info.title, direction: 'rtl', note: '', discoveryComplete: true, knownTotal: items.length, items};
}
async function request(url: string, context: SourceNetworkContext) {
  context.signal?.throwIfAborted(); const body = await context.request(url);
  context.signal?.throwIfAborted(); return body;
}
export const network = {
  search,
  async resolveCatalog(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw Error('WeLoMa 章节地址无效。');
    return readerInfo(await request(chapterUrl(loc.chapter), context), url).catalogUrl;
  },
  async catalog(url, context) {
    const loc = location(url);
    if (!loc.work || loc.chapter) throw Error('请使用 WeLoMa 作品详情页读取目录。');
    return parseCatalog(await request(catalogUrl(loc.work), context), url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw Error('WeLoMa 章节地址无效。');
    return parsePages(await request(chapterUrl(loc.chapter), context), url);
  },
} satisfies SourceNetwork;
