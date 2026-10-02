import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, origin} from './definition';
import {canonical, coverUrl, div, imageUrl, location, one, readerWork, text} from './html';
import {search} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = location(url);
  if (loc.chapter) throw Error('请使用漫画猫作品详情页链接。');
  const safe = inertHtml(html);
  canonical(safe, loc);
  const info = div(safe, 'comic-meta-info');
  const title = text(textContent(one([...info.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)], '作品标题')[1]));
  const list = div(safe, 'chapter-list', true), rows = [...list.matchAll(/<div\b([^>]*)>([\s\S]*?)<\/div\s*>/gi)];
  // The source renders its whole list oldest first; the two sort controls only reorder it locally.
  if (rows.length > 10000 || list.replace(/<div\b[^>]*>[\s\S]*?<\/div\s*>/gi, '').trim() ||
      tags(list, 'div').length !== rows.length) throw Error('漫画猫目录不完整或结构已变化。');
  const id = catalogKey(loc.comic), seen = new Set<string>();
  const entries = rows.map((row, order) => {
    if (!hasClass(attributes(' ' + row[1]), 'chapter-item')) throw Error('漫画猫目录结构已变化。');
    const anchor = one([...row[2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)], '章节链接');
    if (tags(row[2], 'a').length !== 1) throw Error('漫画猫章节链接不完整。');
    const target = location(new URL(text(attributes(' ' + anchor[1]).href), origin).href);
    if (!target.chapter || target.comic !== loc.comic || seen.has(target.chapter)) throw Error('漫画猫章节重复或归属错误。');
    seen.add(target.chapter);
    return {id: chapterKey(target), catalogId: id, remoteId: target.chapter, url: chapterUrl(target),
      title: text(textContent(anchor[2])), groupIds: ['chapters'], rawTypes: [], order, related: false, sequenceId: id};
  });
  const cover = one(tags(div(safe, 'comic-cover-large'), 'img'), '作品封面');
  return {id, sourceId: 'jf00', url: catalogUrl(loc.comic), title, cover: coverUrl(cover.src), observedAt: Date.now(), complete: true,
    note: '', groups: [{id: 'chapters', title: '全部章节', entryIds: entries.map(e => e.id), complete: true}], entries,
    defaultEntryId: entries[0]?.id};
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const loc = location(url);
  if (!loc.chapter) throw Error('漫画猫章节地址无效。');
  const safe = inertHtml(html);
  canonical(safe, loc);
  const work = readerWork(html, loc);
  const declarations = [...html.matchAll(/\breadPic\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)];
  const access = one(declarations, '章节访问声明');
  if (access[1] !== loc.comic || access[2] !== loc.chapter) throw Error('漫画猫章节归属已变化。');
  if (access[3] !== '0' || access[4] !== '0') throw Error('漫画猫章节需要源站登录或付费，当前仅支持公开正文。');
  const list = div(safe, 'comic-content'), images = tags(list, 'img');
  if (!images.length || images.length > 1500 || list.replace(/<img\b[^>]*>/gi, '').trim()) throw Error('漫画猫正文清单不完整。');
  let directory: string | undefined;
  const items = images.map((image, order) => {
    if (!hasClass(image, 'comic-image') || image.alt !== `${work.title} - ${work.chapterTitle} - 第${order + 1}张图`)
      throw Error('漫画猫正文页序不一致。');
    const resource = imageUrl(text(image.src)), parent = resource.slice(0, resource.lastIndexOf('/'));
    if (directory !== undefined && directory !== parent) throw Error('漫画猫正文图片归属不一致。');
    directory = parent;
    return {id: 'page-' + order, order, width: 0, height: 0, resource: {kind: 'http' as const, url: resource}};
  });
  return {url, adapter: 'jf00', title: work.chapterTitle, direction: 'ltr', note: '', discoveryComplete: true, knownTotal: items.length, items};
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
    if (loc.chapter) throw Error('请使用漫画猫作品详情页链接。');
    return parseCatalog(await request(catalogUrl(loc.comic), context), url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw Error('漫画猫章节地址无效。');
    return parsePages(await request(chapterUrl(loc), context), url);
  },
} satisfies SourceNetwork;
