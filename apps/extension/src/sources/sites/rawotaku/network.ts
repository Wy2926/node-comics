import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, origin} from './definition';
import {byClass, canonical, coverUrl, imageUrl, location, one, readerInfo, region, regions, text} from './html';
import {search} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = location(url);
  if (loc.chapter) throw Error('请使用 RawOtaku 作品详情页链接。');
  const safe = inertHtml(html); canonical(safe, loc);
  const info = byClass(safe, 'div', 'anis-content'), id = catalogKey(loc.slug);
  const title = text(textContent(byClass(info, 'h2', 'manga-name')));
  const section = region(safe, 'section', a => a.id === 'chapters-list');
  const languages = [...section.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)]
    .filter(m => hasClass(attributes(' ' + m[1]), 'lang-item'));
  const lists = regions(section, 'ul', a => !!hasClass(a, 'lang-chapters'));
  if (!languages.length || languages.length > 100 || lists.length !== languages.length) throw Error('RawOtaku 语言目录不完整。');
  const seen = new Set<string>(), remoteIds = new Set<string>(), codes = new Set<string>();
  const entries: SourceCatalogSnapshot['entries'] = [], groups: SourceCatalogSnapshot['groups'] = [];
  for (const language of languages) {
    const attrs = attributes(' ' + language[1]), code = text(attrs['data-code'], 80), label = text(textContent(language[2]));
    const count = /\((\d+)\s*章\)$/.exec(label), total = count ? Number(count[1]) : NaN;
    if (attrs['data-type'] !== 'chap' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code) || codes.has(code) ||
        !Number.isSafeInteger(total) || total > 10000) throw Error('RawOtaku 语言目录声明无效。');
    const contentLanguage = Intl.getCanonicalLocales(code)[0]; codes.add(code);
    const list = one(lists.filter(list => list.attrs.id === code + '-chaps'), '语言章节列表');
    const rows = regions(list.body, 'li', () => true);
    if (rows.length !== total || list.body.replace(/<li\b[^>]*>[\s\S]*?<\/li\s*>/gi, '').trim())
      throw Error('RawOtaku 目录数量不一致。');
    const groupId = 'chapters:' + code, groupEntries: string[] = [];
    // read.next() selects the previous sibling in the source's newest-first list.
    for (const row of rows.reverse()) {
      if (!hasClass(row.attrs, 'chapter-item') || !/^[1-9]\d{0,12}$/.test(row.attrs['data-id'])) throw Error('RawOtaku 章节结构无效。');
      const link = one(tags(row.body, 'a'), '章节地址'), target = location(new URL(text(link.href), origin).href);
      const entryId = chapterKey(target), remoteId = row.attrs['data-id'];
      if (target.slug !== loc.slug || target.language !== code || !target.chapter || target.chapter !== row.attrs['data-number'] ||
          seen.has(entryId) || remoteIds.has(remoteId) || entries.length >= 10000) throw Error('RawOtaku 章节重复或归属错误。');
      seen.add(entryId); remoteIds.add(remoteId); groupEntries.push(entryId);
      entries.push({id: entryId, catalogId: id, remoteId, url: chapterUrl(target),
        title: text(textContent(byClass(row.body, 'span', 'name'))), groupIds: [groupId], rawTypes: [label],
        order: entries.length, related: false, contentLanguage, sequenceId: id + ':' + groupId});
    }
    groups.push({id: groupId, title: label, entryIds: groupEntries, complete: true});
  }
  const image = one(tags(byClass(info, 'div', 'anisc-poster'), 'img'), '作品封面');
  return {id, sourceId: 'rawotaku', url: catalogUrl(loc.slug), title, cover: coverUrl(image['data-src'] || image.src),
    observedAt: Date.now(), complete: true, note: '', groups, entries, defaultEntryId: entries[0]?.id};
}
export function parsePages(body: string, url: string, chapterTitle: string): SourceSnapshot {
  const loc = location(url);
  if (!loc.chapter) throw Error('RawOtaku 章节地址无效。');
  let response: {status?: unknown; html?: unknown};
  try {response = JSON.parse(body);} catch {throw Error('RawOtaku 未返回有效正文，请在源站完成验证后重试。');}
  if (!response || response.status !== 1 || typeof response.html !== 'string') throw Error('RawOtaku 正文暂时不可用。');
  const safe = inertHtml(response.html), list = region(safe, 'div', a => a.id === 'vertical-content');
  const cards = regions(list, 'div', a => !!hasClass(a, 'iv-card'));
  if (!cards.length || cards.length > 1500 || tags(list, 'img').filter(a => hasClass(a, 'image-vertical')).length !== cards.length ||
      /\sdata-auth\s*=/i.test(list)) throw Error('RawOtaku 正文清单不完整或图片协议已变化。');
  let directory: string | undefined;
  const items = cards.map((card, order) => {
    const image = one(tags(card.body, 'img'), '正文图片');
    if (!hasClass(image, 'image-vertical') || image.alt !== String(order)) throw Error('RawOtaku 正文页序不一致。');
    const resource = imageUrl(text(image['data-src'] || image.src, 8192));
    const parent = new URL(resource).pathname.split('/').slice(0, -1).join('/');
    if (directory !== undefined && directory !== parent) throw Error('RawOtaku 正文图片归属不一致。');
    directory = parent;
    return {id: 'page-' + order, order, width: 0, height: 0, resource: {kind: 'http' as const, url: resource}};
  });
  return {url, adapter: 'rawotaku', title: chapterTitle, direction: 'rtl', note: '',
    discoveryComplete: true, knownTotal: items.length, items};
}
async function request(url: string, context: SourceNetworkContext, referer?: string) {
  context.signal?.throwIfAborted();
  const body = await context.request(url, referer ? {referer} : undefined);
  context.signal?.throwIfAborted(); return body;
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter) throw Error('请使用 RawOtaku 作品详情页链接。');
    return parseCatalog(await request(catalogUrl(loc.slug), context), url);
  },
  async pages(url, context) {
    const loc = location(url), source = chapterUrl(loc);
    if (!loc.chapter) throw Error('RawOtaku 章节地址无效。');
    const info = readerInfo(inertHtml(await request(source, context)), loc);
    return parsePages(await request(`${origin}/json/chapter?mode=vertical&id=${info.remoteId}`, context, source), url, info.chapterTitle);
  },
} satisfies SourceNetwork;
