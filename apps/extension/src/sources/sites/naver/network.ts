import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceEntry, SourceSnapshot} from '../../contracts/source';
import {catalogUrl, episodeUrl, naverLocation, origin, levels, type Section} from './definition';
import {attributes, inertHtml} from '../../shared/html';
import {sourceCover} from '../../shared/cover';

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('NAVER 返回的数据格式已变化。');
  return value as RecordValue;
}
function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < min) throw Error('NAVER 数量字段无效。');
  return Number(value);
}
function text(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw Error('NAVER 文本字段无效。');
  return value;
}
async function api(path: string, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const raw = await context.request(origin + path);
  context.signal?.throwIfAborted();
  try { return object(JSON.parse(raw)); } catch { throw Error('NAVER 接口不可用，可能需要在源站登录或验证。'); }
}
function location(url: string) {
  const loc = naverLocation(new URL(url));
  if (!loc) throw Error('NAVER 来源地址无效，请使用 Webtoon 作品或阅读页。');
  return loc;
}
function belongs(body: RecordValue, titleId: string, section: Section) {
  if (body.titleId !== Number(titleId) || body.webtoonLevelCode !== levels[section]) throw Error('NAVER 作品归属已变化。');
}

export function parsePages(html: string, url: string): SourceSnapshot {
  const loc = location(url);
  if (!loc.no) throw Error('NAVER 阅读页地址无效。');
  const safe = inertHtml(html);
  const current = [...safe.matchAll(/<a\b[^>]*>/gi)].map(match => attributes(match[0])).filter(attrs => attrs['aria-current'] === 'true');
  const currentLocation = current.length === 1 && current[0].href ? naverLocation(new URL(current[0].href, origin)) : null;
  if (!currentLocation || currentLocation.section !== loc.section || currentLocation.titleId !== loc.titleId || currentLocation.no !== loc.no)
    throw Error('NAVER 阅读页不属于当前话，可能需要在源站完成验证。');
  // This viewer is a complete server-rendered list, bounded by its closing element.
  const viewers = [...safe.matchAll(/<div\b[^>]*\bclass=["'][^"']*\bwt_viewer\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/gi)];
  if (viewers.length !== 1) throw Error('NAVER 未提供可读取的正文，可能需要登录、年龄验证或购买，请在源站确认。');
  const viewer = viewers[0];
  const opening = attributes(viewer[0].slice(0, viewer[0].indexOf('>') + 1));
  if (!opening.class?.split(/\s+/).includes('wt_viewer') || /<div\b/i.test(viewer[1])) throw Error('NAVER 阅读页结构已变化。');
  const images = [...viewer[1].matchAll(/<img\b[^>]*>/gi)].map(match => attributes(match[0]))
    .filter(attrs => attrs.id?.startsWith('content_image_'));
  if (!images.length || images.length > 1500) throw Error('NAVER 正文图片为空或超过限制，请在源站确认访问权限。');
  const items = images.map((attrs, order) => {
    if (attrs.id !== 'content_image_' + order) throw Error('NAVER 正文图片缺页或顺序已变化。');
    let image: URL;
    try { image = new URL(attrs.src); } catch { throw Error('NAVER 正文图片地址无效。'); }
    if (image.protocol !== 'https:' || image.hostname !== 'image-comic.pstatic.net' || image.port || image.username || image.password ||
      !(loc.section === 'webtoon' ? image.pathname.startsWith(`/webtoon/${loc.titleId}/${loc.no}/`)
        : /^\/user_contents_data\/challenge_comic\/\d{4}\/\d{2}\/\d{2}\/\d+\/[^/]+$/.test(image.pathname))) throw Error('NAVER 图片不属于当前话。');
    return {id: 'page-' + order, order, width: 0, height: 0, resource: {kind: 'http' as const, url: image.href}};
  });
  const meta = [...safe.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0])).find(attrs => attrs.property === 'og:title');
  return {url, adapter: 'naver', title: meta?.content?.slice(0, 2048) || `NAVER ${loc.titleId} · ${loc.no}`,
    direction: 'ltr', discoveryComplete: true, knownTotal: items.length, note: '', items};
}

export const network = {
  async catalog(url, context) {
    const loc = location(url);
    if (loc.no) throw Error('请使用 NAVER Webtoon 作品详情页链接。');
    const info = await api('/api/article/list/info?titleId=' + loc.titleId, context);
    belongs(info, loc.titleId, loc.section);
    const id = 'naver:' + loc.section + ':' + loc.titleId, entries: SourceEntry[] = [], ids = new Set<number>();
    let total: number | undefined, pages: number | undefined, size: number | undefined;
    for (let page = 1; page <= 500; page++) {
      const body = await api(`/api/article/list?titleId=${loc.titleId}&page=${page}&sort=ASC`, context);
      belongs(body, loc.titleId, loc.section);
      const paging = object(body.pageInfo), count = integer(body.totalCount), totalPages = integer(paging.totalPages), pageSize = integer(paging.pageSize, 1);
      if (count > 10000 || totalPages > 500 || pageSize > 100 || totalPages !== Math.ceil(count / pageSize) ||
        paging.totalRows !== count || paging.page !== page || body.sort !== 'ASC' ||
        total !== undefined && total !== count || pages !== undefined && pages !== totalPages || size !== undefined && size !== pageSize ||
        !Array.isArray(body.articleList) || body.articleList.length !== Math.min(pageSize, count - (page - 1) * pageSize))
        throw Error('NAVER 目录分页不完整或更新中，请重试。');
      total = count; pages = totalPages; size = pageSize;
      for (const value of body.articleList) {
        const row = object(value), no = integer(row.no, 1);
        if (no > 9999999999 || ids.has(no) || entries.length && no <= Number(entries.at(-1)!.remoteId)) throw Error('NAVER 目录重复或顺序已变化。');
        ids.add(no);
        entries.push({id: id + ':episode:' + no, catalogId: id, remoteId: String(no), url: episodeUrl(loc.titleId, no, loc.section),
          title: text(row.subtitle), groupIds: ['episodes'], rawTypes: [row.charge === true ? '유료' : '무료'],
          order: entries.length, related: false, sequenceId: id});
      }
      if (page >= totalPages) break;
    }
    if (entries.length !== total) throw Error('NAVER 目录未完整获取。');
    // Detect changes during a paginated read before replacing a previously usable directory.
    if ((pages ?? 0) > 1) {
      const head = await api(`/api/article/list?titleId=${loc.titleId}&page=1&sort=ASC`, context);
      belongs(head, loc.titleId, loc.section);
      if (head.totalCount !== total || head.sort !== 'ASC' || !Array.isArray(head.articleList) ||
        head.articleList.length !== Math.min(size!, total!) || head.articleList.some((row, index) => object(row).no !== Number(entries[index].remoteId)))
        throw Error('NAVER 目录在读取期间发生变化，请重试。');
    }
    return {id, sourceId: 'naver', url: catalogUrl(loc.titleId, loc.section), title: text(info.titleName), observedAt: Date.now(), complete: true,
      cover: sourceCover(info.posterThumbnailUrl, url) ?? sourceCover(info.thumbnailUrl, url),
      note: '已读取网站公开目录；需要登录、验证或购买的话仍受源站访问限制。',
      groups: [{id: 'episodes', title: '회차', entryIds: entries.map(entry => entry.id), complete: true}], entries, defaultEntryId: entries[0]?.id};
  },
  async pages(url, context) {
    context.signal?.throwIfAborted();
    const loc = location(url);
    if (!loc.no) throw Error('NAVER 阅读页地址无效。');
    const html = await context.request(episodeUrl(loc.titleId, Number(loc.no), loc.section));
    context.signal?.throwIfAborted();
    return parsePages(html, url);
  },
} satisfies SourceNetwork;
