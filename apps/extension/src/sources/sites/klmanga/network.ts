import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, klLocation, origin} from './definition';
import {byClass, canonicalLocation, coverUrl, imageUrl, location, one, readerInfo, regions, text} from './html';
import {search} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const safe = inertHtml(html), loc = canonicalLocation(safe, url);
  if (loc.chapter) throw Error('请使用 KLManga 作品详情页链接。');
  const main = byClass(safe, 'div', 'z-single-mg'), id = catalogKey(loc.slug);
  const title = text(textContent(byClass(main, 'h1', 'name'))), list = byClass(main, 'div', 'chapter-box');
  const rows = regions(list, 'h4', () => true);
  if (!rows.length || rows.length > 10000 || !regions(main, 'p', () => true).some(p => textContent(p.body) === 'Chapters') ||
    list.replace(/<h4\b[^>]*>[\s\S]*?<\/h4\s*>/gi, '').trim() || /(?:loadmore|load-more|pagination|data-page|data-total)/i.test(list))
    throw Error('KLManga 目录不完整或读取协议已变化。');
  const seen = new Map<string, string>(), entries: SourceCatalogSnapshot['entries'] = [];
  const chapters: Array<{target: {slug: string; chapter: string}; title: string}> = [];
  for (const row of rows) {
    const link = one(regions(row.body, 'a', () => true), '目录章节');
    const target = klLocation(new URL(text(link.attrs.href), origin));
    if (!target?.chapter || target.slug !== loc.slug) throw Error('KLManga 章节地址或归属无效。');
    const entryId = chapterKey(target), label = one(regions(link.body, 'span', a => !a.class), '章节标题');
    const entryTitle = text(textContent(label.body));
    if (seen.has(entryId)) {
      if (seen.get(entryId) !== entryTitle) throw Error('KLManga 重复章节标题冲突。');
      continue;
    }
    seen.set(entryId, entryTitle); chapters.push({target: {slug: target.slug, chapter: target.chapter}, title: entryTitle});
  }
  // Native chapter selection/previous links follow the reverse of the newest-first list.
  for (const {target, title: entryTitle} of chapters.reverse()) {
    const entryId = chapterKey(target);
    entries.push({id: entryId, catalogId: id, remoteId: target.chapter, url: chapterUrl(target),
      title: entryTitle, order: entries.length, groupIds: ['chapters'], rawTypes: [], related: false, sequenceId: id});
  }
  const cover = one(tags(byClass(main, 'div', 'main-thumb'), 'img'), '作品封面');
  return {id, sourceId: 'klmanga', url: catalogUrl(loc.slug), title, cover: coverUrl(cover['data-src'] || cover.src),
    observedAt: Date.now(), complete: true, note: '', groups: [{id: 'chapters', title: 'Chapters',
      entryIds: entries.map(entry => entry.id), complete: true}], entries, defaultEntryId: entries[0].id};
}
export function parseImageBatch(body: string, previousIndex: number) {
  let data: {mes?: unknown; going?: unknown; img_index?: unknown; next_timeout?: unknown};
  try {data = JSON.parse(body);} catch {throw Error('KLManga 未返回有效正文，请在源站完成验证后重试。');}
  if (!Number.isSafeInteger(previousIndex) || previousIndex < 0 || previousIndex >= 1500 ||
    !data || typeof data.mes !== 'string' || data.mes.length > 512 * 1024 ||
    data.going !== 0 && data.going !== 1 || !Number.isSafeInteger(data.img_index) ||
    !Number.isSafeInteger(data.next_timeout) || (data.next_timeout as number) < 0 || (data.next_timeout as number) > 15000)
    throw Error('KLManga 正文读取响应无效。');
  const markup = data.mes, images = tags(markup, 'img'), index = data.img_index as number;
  const failures = [
    !images.length && '本批没有图片',
    images.length > 10 && '本批图片数超过 10',
    index !== previousIndex + images.length && '返回索引与图片数不一致',
    index > 1500 && '返回索引超过 1500',
    !!markup.replace(/<img\b[^>]*>/gi, '').trim() && '响应包含图片以外的标记',
  ].filter(Boolean);
  if (failures.length) throw Error(`KLManga 正文清单缺失或页序已变化（起始索引 ${previousIndex}，本批 ${images.length} 图，返回索引 ${index}；${failures.join('、')}）。`);
  return {html: markup, urls: images.map(a => imageUrl(text(a.src, 8192))), index,
    going: data.going === 1, delay: data.next_timeout as number};
}
async function request(url: string, context: SourceNetworkContext, options?: Parameters<SourceNetworkContext['request']>[1]) {
  context.signal?.throwIfAborted(); const body = await context.request(url, options);
  context.signal?.throwIfAborted(); return body;
}
async function wait(delay: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => {signal?.removeEventListener('abort', abort); resolve();};
    const timer = setTimeout(done, delay);
    const abort = () => {clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? Error('读取已取消。'));};
    signal?.addEventListener('abort', abort, {once: true});
  });
  signal?.throwIfAborted();
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter) throw Error('请使用 KLManga 作品详情页链接。');
    return parseCatalog(await request(catalogUrl(loc.slug), context), url);
  },
  async pages(url, context): Promise<SourceSnapshot> {
    const loc = location(url);
    if (!loc.chapter) throw Error('KLManga 章节地址无效。');
    const source = chapterUrl(loc), info = readerInfo(await request(source, context), url);
    const items: SourceSnapshot['items'] = [];
    let index = 0, content = '';
    for (let batch = 0; batch < 150; batch++) {
      const result = parseImageBatch(await request(origin + '/wp-admin/admin-ajax.php', context,
        {referer: source, form: {action: 'z_do_ajax', _action: 'decode_images', reading_chapter: info.chapterId,
          img_index: String(index), content}}), index);
      for (const resource of result.urls) {
        const order = items.length;
        items.push({id: 'page-' + order, order, width: 0, height: 0, resource: {kind: 'http', url: resource}});
      }
      index = result.index;
      if (!result.going) return {url, adapter: 'klmanga', title: info.chapterTitle, direction: 'rtl',
        discoveryComplete: true, knownTotal: items.length, note: '', items};
      content += result.html;
      if (content.length > 512 * 1024) throw Error('KLManga 正文清单超过读取限额。');
      await wait(result.delay, context.signal);
    }
    throw Error('KLManga 正文清单未结束。');
  },
} satisfies SourceNetwork;
