import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl} from './definition';
import {byClass, canonical, cover, imageUrl, location, one, regions, text} from './html';
import {parseSearch, searchUrl} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = location(url), safe = inertHtml(html);
  if (loc.chapter) throw Error('请使用 WebtoonScan 作品详情页读取目录。');
  canonical(safe, loc);
  const title = text(textContent(one(regions(safe, 'h1', () => true), '作品标题').body));
  const artwork = cover(byClass(safe, 'div', 'summary_image'), loc.slug);
  const box = byClass(safe, 'div', 'listing-chapters_wrap');
  const list = one(regions(box, 'ul', a => !!hasClass(a, 'main') && !!hasClass(a, 'no-volumn')), '完整目录').body;
  const rows = regions(list, 'li', a => !!hasClass(a, 'wp-manga-chapter'));
  if (!rows.length || rows.length > 10000 || tags(list, 'a').length !== rows.length || tags(box, 'ul').length !== 1)
    throw Error('WebtoonScan 目录不完整或分组结构已变化。');
  const id = catalogKey(loc.slug), seen = new Map<string, string>();
  // Static list includes Show more rows. Native Previous/Next follows the reverse order.
  const entries = rows.reverse().flatMap(row => {
    const link = one(regions(row.body, 'a', () => true), '章节链接'), target = location(link.attrs.href);
    const label = text(textContent(link.body));
    if (!target.chapter || target.slug !== loc.slug || seen.has(target.chapter) && seen.get(target.chapter) !== label)
      throw Error('WebtoonScan 章节重复或归属错误。');
    // Some source lists repeat the exact same chapter URL and label (e.g. Solo Bug Player 79).
    if (seen.has(target.chapter)) return [];
    const order = seen.size; seen.set(target.chapter, label);
    return [{id: chapterKey(target), catalogId: id, remoteId: target.chapter, url: chapterUrl(target),
      title: label, order, groupIds: ['chapters'], rawTypes: [], related: false, sequenceId: id}];
  });
  return {id, sourceId: 'webtoonscan', url: catalogUrl(loc.slug), title, cover: artwork, complete: true,
    observedAt: Date.now(), note: '', groups: [{id: 'chapters', title: 'Chapters', entryIds: entries.map(e => e.id), complete: true}],
    entries, defaultEntryId: entries[0].id};
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const loc = location(url), safe = inertHtml(html);
  if (!loc.chapter) throw Error('WebtoonScan 章节地址无效。');
  canonical(safe, loc);
  const title = text(textContent(one(regions(safe, 'h1', a => a.id === 'chapter-heading'), '章节标题').body));
  const menus = regions(safe, 'select', a => !!hasClass(a, 'single-chapter-select'));
  if (!menus.length) throw Error('WebtoonScan 章节导航缺失。');
  for (const menu of menus) {
    const selected = one(tags(menu.body, 'option').filter(a => a.selected !== undefined), '当前章节');
    if (selected.value !== loc.chapter || chapterKey(location(selected['data-redirect'])) !== chapterKey(loc))
      throw Error('WebtoonScan 当前章节归属错误。');
  }
  const viewer = byClass(safe, 'div', 'reading-content');
  const current = one(tags(viewer, 'input').filter(a => a.id === 'wp-manga-current-chap'), '正文标识');
  const rows = regions(viewer, 'div', a => !!hasClass(a, 'page-break'));
  if (current.value !== loc.chapter || !/^[1-9]\d*$/.test(current['data-id'] ?? '') || !rows.length || rows.length > 1500 ||
      tags(viewer, 'img').length !== rows.length || /<(?:iframe|video|canvas|select)\b/i.test(viewer))
    throw Error('WebtoonScan 未提供完整图片正文。');
  const items = rows.map((row, order) => {
    const image = one(tags(row.body, 'img'), '正文图片');
    if (!hasClass(image, 'wp-manga-chapter-img') || image.id !== `image-${order}`) throw Error('WebtoonScan 正文缺页或页序错误。');
    return {id: image.id, order, width: 0, height: 0, resource: {kind: 'http' as const, url: imageUrl(image['data-src'] || image.src)}};
  });
  return {url, adapter: 'webtoonscan', title, direction: 'ltr', note: '', discoveryComplete: true, knownTotal: items.length, items};
}
async function request(url: string, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(url);
  context.signal?.throwIfAborted();
  return html;
}
export const network = {
  pageTransport: ['catalog', 'pages'],
  async search(input, context) {
    return parseSearch(await request(searchUrl(input), context), input);
  },
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter) throw Error('请使用 WebtoonScan 作品详情页读取目录。');
    return parseCatalog(await request(catalogUrl(loc.slug), context), url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw Error('WebtoonScan 章节地址无效。');
    // Explicit list style avoids a saved paged-style preference returning a single page.
    return parsePages(await request(chapterUrl(loc) + '?style=list', context), url);
  },
} satisfies SourceNetwork;
