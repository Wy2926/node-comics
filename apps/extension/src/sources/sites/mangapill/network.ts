import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceEntry, SourceGroup, SourceSnapshot} from '../../contracts/source';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, origin, type MangapillLocation} from './definition';
import {coverUrl, imageUrl, location, one, readerWork, region, regions, text} from './html';
import {resolveQuickCatalog, search} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = location(url);
  if (loc.chapter || !loc.slug) throw Error('请使用 MangaPill 源站提供的完整作品链接读取目录。');
  const safe = inertHtml(html), title = text(textContent(region(safe, 'h1', () => true)));
  const coverImage = one(tags(safe, 'img').filter(image => image.alt === title), '作品封面');
  const cover = coverUrl(coverImage['data-src'] || coverImage.src, loc.work);
  if (!cover) throw Error('MangaPill 作品封面归属错误。');
  const section = region(safe, 'div', a => a.id === 'chapters');
  const list = region(section, 'div', (_a, raw) => /\sdata-filter-list(?:\s|=|>)/i.test(raw));
  const rows = [...list.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)];
  if (rows.length > 10000 || tags(list, 'a').length !== rows.length ||
      list.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, '').trim()) throw Error('MangaPill 目录结构不完整。');
  const id = catalogKey(loc.work), seen = new Set<string>(), groups = new Map<string, SourceGroup>();
  // Source Previous/Next navigation follows the reverse of its newest-first static list, including group boundaries.
  const entries: SourceEntry[] = rows.reverse().map((row, order) => {
    const attrs = attributes(' ' + row[1]), target = location(new URL(text(attrs.href), origin).href);
    const label = text(textContent(row[2]));
    if (target.work !== loc.work || !target.chapter || seen.has(target.chapter))
      throw Error('MangaPill 章节重复或归属错误。');
    seen.add(target.chapter);
    const rawGroup = /^(Group [1-9]\d*) Chapter\b/.exec(label)?.[1];
    const groupId = rawGroup ? 'group-' + rawGroup.slice('Group '.length) : 'chapters';
    const group = groups.get(groupId) ?? {id: groupId, title: rawGroup ?? 'Chapters', entryIds: [], complete: true};
    groups.set(groupId, group);
    const entryId = chapterKey(target); group.entryIds.push(entryId);
    return {id: entryId, catalogId: id, remoteId: `${target.work}-${target.chapter}`, url: chapterUrl(target, loc.slug), title: label,
      groupIds: [groupId], rawTypes: rawGroup ? [rawGroup] : [], order, related: false, sequenceId: id};
  });
  return {id, sourceId: 'mangapill', url: catalogUrl(loc.work, loc.slug), title, cover, observedAt: Date.now(), complete: true,
    note: '', groups: [...groups.values()], entries, defaultEntryId: entries[0]?.id};
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const loc = location(url);
  if (!loc.chapter) throw Error('MangaPill 章节地址无效。');
  const safe = inertHtml(html), work = readerWork(safe, loc), rows = regions(safe, 'chapter-page', () => true);
  if (!rows.length || rows.length > 1500 || tags(safe, 'chapter-page').length !== rows.length ||
      tags(safe, 'img').filter(image => hasClass(image, 'js-page')).length !== rows.length)
    throw Error('MangaPill 正文清单不完整。');
  const items = rows.map((row, order) => {
    const summary = textContent(region(row.body, 'div', (_a, raw) => /\sdata-summary(?:\s|=|>)/i.test(raw)));
    if (summary !== `page ${order + 1}/${rows.length}`) throw Error('MangaPill 正文页序或总数不一致。');
    const image = one(tags(row.body, 'img').filter(image => hasClass(image, 'js-page')), '正文图片');
    if (image.alt !== `${work.chapterTitle} Page ${order + 1}`) throw Error('MangaPill 正文图片页序不一致。');
    const width = Number(image.width), height = Number(image.height);
    if (!/^[1-9]\d{0,5}$/.test(image.width ?? '') || !/^[1-9]\d{0,5}$/.test(image.height ?? ''))
      throw Error('MangaPill 正文图片尺寸无效。');
    return {id: 'page-' + order, order, width, height,
      resource: {kind: 'http' as const, url: imageUrl(text(image['data-src']), loc)}};
  });
  return {url, adapter: 'mangapill', title: work.chapterTitle, direction: 'ltr', note: '',
    discoveryComplete: true, knownTotal: items.length, items};
}
async function request(url: string, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(url);
  context.signal?.throwIfAborted();
  return html;
}
function chapterRequestUrl(loc: MangapillLocation) {
  if (!loc.chapter || !loc.slug) throw Error('请使用 MangaPill 源站提供的完整章节链接。');
  // The local catalog binding is never sent to the source.
  return chapterUrl({work: loc.work, chapter: loc.chapter, slug: loc.slug});
}
export const network = {
  search,
  async resolveCatalog(url, context) {
    const loc = location(url), html = await request(chapterRequestUrl(loc), context), work = readerWork(html, loc);
    const quick = new URL('/quick-search', origin); quick.searchParams.set('q', work.title);
    const resolved = resolveQuickCatalog(await request(quick.href, context), loc.work);
    if (loc.catalogSlug && location(resolved).slug !== loc.catalogSlug) throw Error('MangaPill 章节目录绑定错误。');
    return resolved;
  },
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter || !loc.slug) throw Error('请使用 MangaPill 源站提供的完整作品链接读取目录。');
    return parseCatalog(await request(catalogUrl(loc.work, loc.slug), context), url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw Error('MangaPill 章节地址无效。');
    return parsePages(await request(chapterRequestUrl(loc), context), url);
  },
} satisfies SourceNetwork;
