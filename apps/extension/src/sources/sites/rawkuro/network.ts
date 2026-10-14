import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl} from './definition';
import {byId, canonicalLocation, coverUrl, imageUrl, location, one, regions, text} from './html';
import {search} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const safe = inertHtml(html), loc = canonicalLocation(safe, url);
  if (loc.chapter) throw Error('请使用 RawKuro / Raw1001 作品详情页链接。');
  const title = text(textContent(one(regions(safe, 'h1', () => true), '作品标题').body));
  const poster = one(regions(safe, 'figure', () => true), '作品封面');
  const cover = one(tags(poster.body, 'img'), '封面图片');
  const list = byId(safe, 'ul', 'myUL'), rows = regions(list, 'li', a => !!hasClass(a, 'chapter'));
  if (!rows.length || rows.length > 10000 || tags(list, 'li').length !== rows.length || tags(list, 'a').length !== rows.length ||
    /(?:pagination|load-more|loadmore|data-page|data-total)/i.test(list)) throw Error('RawKuro 目录不完整或结构已变化。');
  const id = catalogKey(loc), seen = new Set<string>();
  // The complete server list is newest first; the native reader's next link uses the preceding option.
  const entries = rows.reverse().map((row, order) => {
    const link = one(regions(row.body, 'a', () => true), '目录章节'), target = location(text(link.attrs.href), url);
    if (!target.chapter || target.slug !== loc.slug || seen.has(target.chapter)) throw Error('RawKuro 章节重复或作品归属错误。');
    seen.add(target.chapter);
    return {id: chapterKey(target), catalogId: id, remoteId: target.chapter, url: chapterUrl({...target, origin: loc.origin}),
      title: text(textContent(link.body)), order, groupIds: ['chapters'], rawTypes: [], related: false, sequenceId: id};
  });
  return {id, sourceId: 'rawkuro', url: catalogUrl(loc), title, cover: coverUrl(cover['data-src'] || cover.src, url),
    observedAt: Date.now(), complete: true, note: '', groups: [{id: 'chapters', title: '巻一覧', complete: true,
      entryIds: entries.map(entry => entry.id)}], entries, defaultEntryId: entries[0].id};
}
export function readerInfo(html: string, url: string) {
  const safe = inertHtml(html), loc = canonicalLocation(safe, url);
  if (!loc.chapter) throw Error('RawKuro 章节地址无效。');
  const heading = one(regions(safe, 'h1', () => true), '章节标题');
  const owner = location(text(one(tags(heading.body, 'a'), '所属作品').href), url);
  if (owner.chapter || owner.slug !== loc.slug) throw Error('RawKuro 正文作品归属错误。');
  const select = one(regions(byId(safe, 'div', 'top-control'), 'select', a => a.name === 'nPL_list'), '章节选择器');
  const current = one(regions(select.body, 'option', a => {
    try {const target = location(a.value, url); return target.slug === loc.slug && target.chapter === loc.chapter;} catch {return false;}
  }), '当前章节');
  // Parse the literal only, never execute downloaded source scripts or read IDs from comments.
  const scripts = html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi);
  const ids = [...scripts].flatMap(script => [...script[1].matchAll(/^\s*const CHAPTER_ID = ([1-9]\d{0,11});\s*$/gm)].map(match => match[1]));
  return {chapterId: one(ids, '章节编号'), title: text(textContent(current.body))};
}
export function parseImages(body: string, url: string, title: string): SourceSnapshot {
  const loc = location(url);
  if (!loc.chapter) throw Error('RawKuro 章节地址无效。');
  let data: {status?: unknown; html?: unknown};
  try {data = JSON.parse(body);} catch {throw Error('RawKuro 正文接口未返回有效数据。');}
  if (!data || data.status !== true || typeof data.html !== 'string') throw Error('RawKuro 正文尚不可用。');
  const safe = inertHtml(data.html), rows = regions(safe, 'div', a => !!hasClass(a, 'separator'));
  const pages = rows.filter(row => Object.hasOwn(row.attrs, 'data-index')).map(row => {
    if (!/^(?:0|[1-9]\d{0,3})$/.test(row.attrs['data-index'])) throw Error('RawKuro 正文索引无效。');
    const link = one(regions(row.body, 'a', a => !!hasClass(a, 'readImg')), '正文原图');
    const img = one(tags(link.body, 'img'), '正文图片'), original = imageUrl(link.attrs.href, url);
    if (img.referrerpolicy !== 'no-referrer' || imageUrl(img.src, url) !== original && imageUrl(img['data-src'], url) !== original)
      throw Error('RawKuro 正文图片定位或引用策略已变化。');
    return {index: Number(row.attrs['data-index']), url: original};
  }).sort((a, b) => a.index - b.index);
  // The atomic endpoint returns the entire chapter. Unindexed separators are site promotions.
  if (!pages.length || pages.length > 1500 || pages.some((page, order) => page.index !== order) ||
    tags(safe, 'div').filter(a => Object.hasOwn(a, 'data-index')).length !== pages.length)
    throw Error('RawKuro 正文清单缺页或索引重复。');
  const items = pages.map(({index, url}) => ({id: 'page-' + index, order: index, width: 0, height: 0,
    resource: {kind: 'http' as const, url}}));
  return {url, adapter: 'rawkuro', title, direction: 'rtl', note: '', discoveryComplete: true, knownTotal: items.length, items};
}
async function request(url: string, context: SourceNetworkContext, options?: Parameters<SourceNetworkContext['request']>[1]) {
  context.signal?.throwIfAborted(); const body = await context.request(url, options);
  context.signal?.throwIfAborted(); return body;
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter) throw Error('请使用 RawKuro / Raw1001 作品详情页链接。');
    return parseCatalog(await request(catalogUrl(loc), context), url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw Error('RawKuro 章节地址无效。');
    const target = chapterUrl(loc), info = readerInfo(await request(target, context), target);
    const body = await request(`${loc.origin}/ajax/image/list/chap/${info.chapterId}`, context, {referer: target, form: {}});
    return parseImages(body, url, info.title);
  },
} satisfies SourceNetwork;
