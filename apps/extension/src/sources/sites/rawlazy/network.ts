import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {boundChapterLocation, catalogKey, catalogUrl, chapterKey, chapterUrl, origin} from './definition';
import {byClass, catalogIdentity, coverUrl, imageUrl, location, one, readerInfo, regions, text} from './html';
import {search} from './search';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const safe = inertHtml(html), slug = catalogIdentity(safe, url), id = catalogKey(slug);
  const title = text(textContent(byClass(safe, 'h1', 'font-bold')));
  const list = byClass(safe, 'div', 'chapters-list'), rows = regions(list, 'a', () => true);
  if (!rows.length || rows.length > 10000 || !regions(safe, 'div', a => !!hasClass(a, 'chapter-list-lb'))
    .some(label => textContent(label.body) === '章リスト') ||
    list.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, '').trim() || /(?:loadmore|pagination|data-page|data-total)/i.test(safe))
    throw Error('RawLazy 目录不完整或读取协议已变化。');
  const seen = new Set<string>(), entries: SourceCatalogSnapshot['entries'] = [];
  // The native previous/next links follow the reverse of the newest-first directory.
  for (const row of rows.reverse()) {
    const target = boundChapterLocation(new URL(text(row.attrs.href), origin), slug);
    if (!target?.chapterSlug || target.catalogSlug && target.catalogSlug !== slug) throw Error('RawLazy 章节地址或归属无效。');
    const entryId = chapterKey(target.chapterSlug);
    if (seen.has(entryId)) throw Error('RawLazy 目录包含重复章节。');
    seen.add(entryId);
    entries.push({id: entryId, catalogId: id, remoteId: target.chapterSlug, url: chapterUrl(target.chapterSlug, slug),
      title: text(textContent(byClass(row.body, 'span', 'font-bold'))), order: entries.length,
      groupIds: ['chapters'], rawTypes: [], related: false, sequenceId: id});
  }
  const cover = one(tags(safe, 'img').filter(a => a.alt === 'Cover Image'), '作品封面');
  return {id, sourceId: 'rawlazy', url: catalogUrl(slug), title, cover: coverUrl(cover['data-src'] || cover.src),
    observedAt: Date.now(), complete: true, note: '', groups: [{id: 'chapters', title: '章リスト',
      entryIds: entries.map(e => e.id), complete: true}], entries, defaultEntryId: entries[0]?.id};
}
export function parseImageBatch(body: string, previousIndex: number) {
  let data: {mes?: unknown; going?: unknown; img_index?: unknown; next_timeout?: unknown};
  try {data = JSON.parse(body);} catch {throw Error('RawLazy 未返回有效正文，请在源站完成验证后重试。');}
  if (!Number.isSafeInteger(previousIndex) || previousIndex < 0 || previousIndex >= 1500 ||
    !data || typeof data.mes !== 'string' || data.mes.length > 512 * 1024 ||
    data.going !== 0 && data.going !== 1 || !Number.isSafeInteger(data.img_index) ||
    !Number.isSafeInteger(data.next_timeout) || (data.next_timeout as number) < 0 || (data.next_timeout as number) > 15000)
    throw Error('RawLazy 正文读取响应无效。');
  const markup = data.mes, images = tags(markup, 'img'), index = data.img_index as number;
  if (!images.length || images.length > 10 || index !== previousIndex + images.length || index > 1500 ||
    markup.replace(/<img\b[^>]*>/gi, '').trim() || images.some(a => a['data-preload'] !== 'yes'))
    throw Error('RawLazy 正文清单缺失或页序已变化。');
  return {html: markup, urls: images.map(a => imageUrl(text(a.src, 8192))), index,
    going: data.going === 1, delay: data.next_timeout as number};
}
async function request(url: string, context: SourceNetworkContext, options?: Parameters<SourceNetworkContext['request']>[1]) {
  context.signal?.throwIfAborted();
  const body = await context.request(url, options);
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
  async resolveCatalog(url, context) {
    const loc = location(url);
    if (!loc.chapterSlug) throw Error('RawLazy 章节地址无效。');
    return readerInfo(await request(chapterUrl(loc.chapterSlug), context), url).catalogUrl;
  },
  async catalog(url, context) {
    const loc = location(url);
    if (!loc.catalogSlug || loc.chapterSlug) throw Error('请使用 RawLazy 作品详情页链接。');
    return parseCatalog(await request(catalogUrl(loc.catalogSlug), context), url);
  },
  async pages(url, context): Promise<SourceSnapshot> {
    const loc = location(url);
    if (!loc.chapterSlug) throw Error('RawLazy 章节地址无效。');
    const source = chapterUrl(loc.chapterSlug), info = readerInfo(await request(source, context), url);
    const items: SourceSnapshot['items'] = [];
    let index = 0, content = '';
    for (let batch = 0; batch < 150; batch++) {
      const result = parseImageBatch(await request(origin + '/wp-admin/admin-ajax.php', context,
        {referer: source, form: {action: 'z_do_ajax', _action: 'decode_images', p: info.postId,
          img_index: String(index), content, nonce: info.nonce}}), index);
      for (const resource of result.urls) {
        const order = items.length;
        items.push({id: 'page-' + order, order, width: 0, height: 0, resource: {kind: 'http', url: resource}});
      }
      index = result.index;
      if (!result.going) return {url, adapter: 'rawlazy', title: info.chapterTitle, direction: 'rtl',
        discoveryComplete: true, knownTotal: items.length, note: '', items};
      content += result.html;
      if (content.length > 512 * 1024) throw Error('RawLazy 正文清单超过读取限额。');
      await wait(result.delay, context.signal);
    }
    throw Error('RawLazy 正文清单未结束。');
  },
} satisfies SourceNetwork;
