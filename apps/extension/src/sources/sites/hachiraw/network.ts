import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, origin} from './definition';
import {coverUrl, imageUrl, location, one, regions, text} from './html';
import {search, searchUrl} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = location(url);
  if (loc.chapter) throw Error('请使用 Hachiraw 作品详情页读取目录。');
  const safe = inertHtml(html), title = text(textContent(one(regions(safe, 'h1', () => true), '作品标题').body));
  const cover = coverUrl(one(tags(safe, 'img').filter(a => hasClass(a, 'bottom-5')), '作品封面').src, loc.slug);
  const info = one(regions(safe, 'div', a => !!hasClass(a, 'BoxBody')).filter(row => tags(row.body, 'a').some(a => hasClass(a, 'ChapterLink'))), '作品信息').body;
  const box = one(regions(info, 'div', a => !!hasClass(a, 'col-12')).filter(row => tags(row.body, 'a').some(a => hasClass(a, 'ChapterLink'))), '完整目录').body;
  const rows = regions(box, 'a', a => !!hasClass(a, 'ChapterLink'));
  if (!rows.length || rows.length > 10000 || tags(box, 'a').length !== rows.length)
    throw Error('Hachiraw 目录不完整或结构已变化。');
  const id = catalogKey(loc.slug), seen = new Set<string>();
  // All chapters, including CSS-hidden rows, are in the response; native Previous/Next is oldest first.
  const entries = rows.reverse().map((row, order) => {
    const target = location(text(row.attrs.href));
    if (!target.chapter || target.slug !== loc.slug || seen.has(target.chapter)) throw Error('Hachiraw 章节重复或作品归属错误。');
    seen.add(target.chapter);
    const labels = regions(row.body, 'span', a => !!hasClass(a, 'ng-binding') && !hasClass(a, 'float-right') && !hasClass(a, 'badge'));
    const label = text(textContent(one(labels, '章节标题').body));
    return {id: chapterKey(target), catalogId: id, remoteId: target.chapter, url: chapterUrl(target), title: label,
      groupIds: ['chapters'], rawTypes: [], order, related: false, sequenceId: id};
  });
  return {id, sourceId: 'hachiraw', url: catalogUrl(loc.slug), title, cover, observedAt: Date.now(), complete: true,
    note: '', groups: [{id: 'chapters', title: 'Chapters', entryIds: entries.map(e => e.id), complete: true}], entries,
    defaultEntryId: entries[0].id};
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const loc = location(url);
  if (!loc.chapter) throw Error('Hachiraw 章节地址无效。');
  const safe = inertHtml(html), modal = one(regions(safe, 'div', a => a.id === 'ChapterModal'), '章节选择器').body;
  const current = one(regions(modal, 'a', a => !!hasClass(a, 'btn-success')), '当前章节');
  if (chapterKey(location(text(current.attrs.href))) !== chapterKey(loc)) throw Error('Hachiraw 当前章节归属错误。');
  const title = text(textContent(current.body)), navs = regions(safe, 'div', a => !!hasClass(a, 'DesktopNav'));
  if (!navs.length) throw Error('Hachiraw 阅读导航缺失。');
  const totals: number[] = [];
  for (const nav of navs) {
    const owner = location(text(one(tags(nav.body, 'a'), '所属作品').href));
    if (owner.chapter || owner.slug !== loc.slug) throw Error('Hachiraw 正文作品归属错误。');
    const buttons = regions(nav.body, 'button', () => true).map(row => textContent(row.body));
    const count = one(buttons.filter(label => /^Page [1-9]\d*$/.test(label)), '正文总数');
    totals.push(Number(count.slice(5)));
    if (!buttons.includes(title)) throw Error('Hachiraw 章节标题不一致。');
  }
  const gallery = one(regions(safe, 'div', a => a.id === 'TopPage' && !!hasClass(a, 'ImageGallery')), '正文列表').body;
  // This source inserts its own promotional image between pages, outside the declared page count.
  const images = tags(gallery, 'img').map(image => {
    if (!hasClass(image, 'lazy')) throw Error('Hachiraw 正文图片结构已变化。');
    return imageUrl(image['data-original']);
  }).filter(url => url !== origin + '/01.png');
  if (!images.length || images.length > 1500 || totals.some(total => total !== images.length)) throw Error('Hachiraw 正文清单不完整。');
  const items = images.map((url, order) => ({id: 'page-' + order, order, width: 0, height: 0,
    resource: {kind: 'http' as const, url}}));
  return {url, adapter: 'hachiraw', title, direction: 'rtl', note: '', discoveryComplete: true, knownTotal: items.length, items};
}
async function request(url: string, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const html = await context.request(url);
  context.signal?.throwIfAborted();
  return html;
}
export const network = {
  pageTransport: ['catalog', 'pages'], search,
  searchPage: searchUrl,
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter) throw Error('请使用 Hachiraw 作品详情页读取目录。');
    return parseCatalog(await request(catalogUrl(loc.slug), context), url);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw Error('Hachiraw 章节地址无效。');
    return parsePages(await request(chapterUrl(loc), context), url);
  },
} satisfies SourceNetwork;
