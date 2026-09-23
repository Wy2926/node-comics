import type {SourceNetwork} from '../../contracts/network';
import type {DiscoveredPage} from '../../contracts/source';
import {parseCatalog} from './catalog';
import {catalogUrl, chapterUrl, dm5Location} from './definition';
import {assignment, attribute, positive, scripts, text} from './parsing';
import {imageUrls} from './protocol';

export const network: SourceNetwork = {
  async catalog(url, context) {
    const loc = dm5Location(new URL(url));
    if (!loc?.slug || loc.chapterId) throw Error('请使用 DM5 漫画详情页链接。');
    context.signal?.throwIfAborted();
    const html = await context.request(catalogUrl(loc.slug));
    context.signal?.throwIfAborted();
    return parseCatalog(html, url);
  },
  async pages(url, context) {
    const loc = dm5Location(new URL(url));
    if (!loc?.chapterId) throw Error('DM5 章节地址无效。');
    context.signal?.throwIfAborted();
    const canonical = chapterUrl(loc.chapterId), html = await context.request(canonical), data = scripts(html);
    if (String(assignment(data, 'DM5_CID')) !== loc.chapterId || assignment(data, 'DM5_CURL') !== new URL(canonical).pathname) throw Error('DM5 章节归属已变化。');
    if (assignment(data, 'DM5_ISNEED') !== 'False') throw Error('DM5 此章节需要源站登录或购买，暂不能导入。');
    const comicId = positive(assignment(data, 'DM5_MID')), total = positive(assignment(data, 'DM5_IMAGE_COUNT'), 1500);
    const backlinks = [...html.matchAll(/<a\b([^>]*)>/gi)].filter(m => (attribute(m[1], 'class') ?? '').split(/\s+/).includes('back'));
    const parent = backlinks.length === 1 && dm5Location(new URL(attribute(backlinks[0][1], 'href') ?? '', canonical));
    if (!parent || !parent.slug || parent.chapterId || loc.slug && parent.slug !== loc.slug) throw Error('DM5 章节不属于已导入漫画。');
    const date = text(assignment(data, 'DM5_VIEWSIGN_DT')), sign = text(assignment(data, 'DM5_VIEWSIGN'));
    const keyTags = [...html.matchAll(/<input\b([^>]*)>/gi)].filter(m => attribute(m[1], 'id') === 'dm5_key');
    if (keyTags.length > 1) throw Error('DM5 图片参数重复。');
    const key = keyTags.length ? attribute(keyTags[0][1], 'value') ?? '' : '';
    const items: DiscoveredPage[] = new Array(total);
    let nextPage = 1, failure: unknown;
    await Promise.all(Array.from({length: Math.min(4, Math.ceil(total / 2))}, async () => {
      try { while (nextPage <= total && !failure) {
        context.signal?.throwIfAborted();
        const page = nextPage; nextPage += 2;
        const query = new URLSearchParams({cid: loc.chapterId!, page: String(page), key, language: '1', gtk: '6',
          _cid: loc.chapterId!, _mid: String(comicId), _dt: date, _sign: sign});
        const response = await context.request(canonical + 'chapterfun.ashx?' + query, {referer: canonical});
        context.signal?.throwIfAborted();
        const urls = imageUrls(response, loc.chapterId!, comicId);
        if (urls.length !== Math.min(2, total - page + 1)) throw Error('DM5 图片列表不完整，请重新载入章节。');
        urls.forEach((image, offset) => {const order = page - 1 + offset; items[order] = {id: 'page-' + order, order, width: 0, height: 0, resource: {kind: 'http', url: image}};});
      } } catch (error) { failure ??= error; }
    }));
    if (failure) throw failure;
    return {url, adapter: 'dm5', title: text(assignment(data, 'DM5_CTITLE')), direction: 'ltr', note: '',
      discoveryComplete: true, knownTotal: total, items};
  },
};
