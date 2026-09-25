import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {sourceCover} from '../../shared/cover';
import {catalogUrl, chapterUrl, guaziLocation, origin} from './definition';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {object, one, structuredData, text} from './html';

function location(url: string) {
  const loc = guaziLocation(new URL(url));
  if (!loc) throw Error('瓜子漫画来源地址无效，请使用作品或章节链接。');
  return loc;
}
function canonical(html: string, url: string) {
  const actual = one(tags(html, 'link').filter(a => a.rel === 'canonical'), '页面身份').href;
  const a = location(actual), b = location(url);
  if (a.chapterId !== b.chapterId || !b.chapterId && a.comicId !== b.comicId) throw Error('瓜子漫画页面归属已变化。');
}
function artwork(value: unknown, base: string) {
  const cover = sourceCover(value, base);
  if (!cover) return;
  const u = new URL(cover.url);
  return (u.hostname === 'img.guazicdn.com' && u.protocol === 'https:' || u.hostname === 'api.guaziapp.com') && !u.port ? cover : undefined;
}
export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = location(url);
  if (!loc.comicId || loc.chapterId) throw Error('请使用瓜子漫画作品详情页链接。');
  const safe = inertHtml(html);
  canonical(safe, url);
  const story = one(structuredData(html).filter(row => row['@type'] === 'ComicStory'), '作品数据');
  const owner = location(text(story.url));
  if (owner.chapterId || owner.comicId !== loc.comicId) throw Error('瓜子漫画目录不属于当前作品。');
  const list = one([...safe.matchAll(/<div\b([^>]*)>([\s\S]*?)<\/div\s*>/gi)]
    .filter(m => hasClass(attributes(' ' + m[1]), 'all-chapter-grid')), '完整目录');
  if (/<div\b/i.test(list[2])) throw Error('瓜子漫画目录结构已变化。');
  const counts = [...textContent(safe).matchAll(/章节总数[：:]\s*(\d+)\s*话/g)];
  const total = Number(one(counts, '章节总数')[1]);
  const links = [...list[2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)];
  if (!Number.isSafeInteger(total) || total > 10000 || links.length !== total || tags(list[2], 'a').length !== total)
    throw Error('瓜子漫画目录未完整获取，请重试。');
  const id = 'guazimanhua:' + loc.comicId, seen = new Set<string>();
  // The server renders newest first; chapter IDs themselves are not monotonic.
  const entries = links.reverse().map((m, order) => {
    const target = location(new URL(text(attributes(' ' + m[1]).href), origin).href);
    if (!target.chapterId || target.comicId && target.comicId !== loc.comicId || seen.has(target.chapterId))
      throw Error('瓜子漫画章节重复或归属错误。');
    seen.add(target.chapterId);
    return {id: 'guazimanhua:chapter:' + target.chapterId, catalogId: id, remoteId: target.chapterId,
      url: chapterUrl(target.chapterId, loc.comicId), title: text(textContent(m[2])), groupIds: ['chapters'],
      rawTypes: [], order, related: false, sequenceId: id};
  });
  return {id, sourceId: 'guazimanhua', url: catalogUrl(loc.comicId), title: text(story.name), cover: artwork(story.image, url),
    observedAt: Date.now(), complete: true, note: '', groups: [{id: 'chapters', title: '全部章节', entryIds: entries.map(e => e.id), complete: true}],
    entries, defaultEntryId: entries[0]?.id};
}
function readerData(html: string, url: string) {
  const loc = location(url);
  if (!loc.chapterId) throw Error('瓜子漫画章节地址无效。');
  const safe = inertHtml(html), data = structuredData(html);
  canonical(safe, url);
  const article = one(data.filter(row => row['@type'] === 'Article'), '章节数据');
  if (location(text(article.url)).chapterId !== loc.chapterId) throw Error('瓜子漫画章节归属已变化。');
  const parent = object(article.isPartOf), owner = location(text(parent.url));
  if (parent['@type'] !== 'ComicStory' || owner.chapterId || !owner.comicId || loc.comicId && loc.comicId !== owner.comicId)
    throw Error('瓜子漫画章节不属于已导入漫画。');
  return {safe, data, article, comicId: owner.comicId};
}
export function parseReaderCatalogUrl(html: string, url: string) {
  return catalogUrl(readerData(html, url).comicId);
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const {safe, data, article} = readerData(html, url);
  const list = one(data.filter(row => row['@type'] === 'ItemList'), '图片列表'), total = list.numberOfItems;
  // The source caps its SEO list at 20 images; the count and reader markup cover the full chapter.
  if (!Number.isSafeInteger(total) || Number(total) < 1 || Number(total) > 1500 || !Array.isArray(list.itemListElement) || list.itemListElement.length !== Math.min(Number(total), 20))
    throw Error('瓜子漫画未提供完整正文，请在源站确认访问权限。');
  const viewer = one([...safe.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section\s*>/gi)]
    .filter(m => hasClass(attributes(' ' + m[1]), 'reader-images')), '正文');
  const images = tags(viewer[2], 'img');
  if (/<section\b/i.test(viewer[2]) || images.length !== total) throw Error('瓜子漫画正文缺页或结构已变化。');
  const preview = list.itemListElement;
  const items = images.map((image, order) => {
    const resource = new URL(text(image.src));
    if (!hasClass(image, 'reading-image') || image.id !== 'page-' + (order + 1) || image['data-page'] !== String(order + 1))
      throw Error('瓜子漫画正文页序或图片清单不一致。');
    if (order < preview.length) {
      const row = object(preview[order]), item = object(row.item);
      if (row['@type'] !== 'ListItem' || row.position !== order + 1 || item['@type'] !== 'ImageObject' || item.url !== resource.href)
        throw Error('瓜子漫画正文页序或图片清单不一致。');
    }
    if (resource.protocol !== 'https:' || resource.hostname !== 'img.guazicdn.com' || resource.port || resource.username || resource.password ||
      !/^\/(?:[a-z\d_-]+\/)+comics\/chapters\//i.test(resource.pathname.replace(/^\/\//, '/')))
      throw Error('瓜子漫画正文图片地址无效。');
    return {id: 'page-' + order, order, width: 0, height: 0, resource: {kind: 'http' as const, url: resource.href}};
  });
  return {url, adapter: 'guazimanhua', title: text(article.headline), direction: 'ltr', note: '',
    discoveryComplete: true, knownTotal: items.length, items};
}
async function request(url: string, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(url);
  context.signal?.throwIfAborted();
  return html;
}
export const network = {
  async catalog(url, context) {
    const loc = location(url);
    if (!loc.comicId || loc.chapterId) throw Error('请使用瓜子漫画作品详情页链接。');
    return parseCatalog(await request(catalogUrl(loc.comicId), context), url);
  },
  async resolveCatalog(url, context) {
    const loc = location(url);
    if (!loc.chapterId) throw Error('瓜子漫画章节地址无效。');
    return parseReaderCatalogUrl(await request(chapterUrl(loc.chapterId), context), url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapterId) throw Error('瓜子漫画章节地址无效。');
    return parsePages(await request(chapterUrl(loc.chapterId), context), url);
  },
} satisfies SourceNetwork;
