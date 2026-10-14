import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {catalogKey, catalogUrl, comicLocation, origin, readerKey, readerUrl} from './definition';

const invalid = (): never => {throw Error('nHentai.com 响应不完整或作品归属无效。');};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  return value.trim();
}
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) return invalid();
  return value as number;
}
function json(body: string) {
  try {return object(JSON.parse(body));}
  catch {throw Error('nHentai.com 未返回有效数据，请在源站完成验证后重试。');}
}
function location(url: string) {
  const loc = comicLocation(new URL(url));
  if (!loc) return invalid();
  return loc;
}
function comic(value: unknown, slug: string) {
  const data = object(value);
  if (data.slug !== slug) return invalid();
  if (data.chapters_count !== 0)
    throw Error('nHentai.com 当前仅支持整本画廊，分章作品尚未适配。');
  return {data, id: positive(data.id), title: text(data.title), pages: positive(data.pages, 1500)};
}
function asset(value: unknown, id: number, cover = false): string {
  const raw = text(value, 8192);
  let url: URL;
  try {url = new URL(raw);} catch {return invalid();}
  const path = cover ? `comics/${id}\\.(?:jpe?g|png|webp|gif|avif)`
    : `images/${id}/[a-zA-Z0-9_-]+\\.(?:jpe?g|png|webp|gif|avif)`;
  if (url.origin !== 'https://cdn.nhentai.com' || url.username || url.password || url.search || url.hash ||
      !new RegExp(`^/nhentai/storage/${path}$`).test(url.pathname) || url.href !== raw) return invalid();
  return url.href;
}

// API language labels describe content; the URL locale describes only the website UI.
const languages: Record<string, string> = {japanese: 'ja', english: 'en', chinese: 'zh', korean: 'ko',
  spanish: 'es', french: 'fr', german: 'de', russian: 'ru', portuguese: 'pt', italian: 'it',
  indonesian: 'id', thai: 'th', vietnamese: 'vi', arabic: 'ar', hindi: 'hi'};
export function parseCatalog(body: string, url: string): SourceCatalogSnapshot {
  const loc = location(url);
  if (loc.reader) return invalid();
  const {data, id: remoteId, title} = comic(json(body), loc.slug);
  if (data.first_chapter !== null) return invalid();
  const languageSlug = data.language == null ? '' : text(object(data.language).slug, 80);
  const language = Object.hasOwn(languages, languageSlug) ? languages[languageSlug] : undefined;
  const category = data.category == null ? [] : [text(object(data.category).name, 180)];
  const id = catalogKey(loc.slug), entryId = readerKey(loc.slug);
  return {id, sourceId: 'nhentaicom', url: catalogUrl(loc), title,
    cover: {url: asset(data.image_url, remoteId, true)}, observedAt: Date.now(), complete: true, note: '',
    groups: [{id: 'book', title, entryIds: [entryId], complete: true}],
    entries: [{id: entryId, catalogId: id, remoteId: String(remoteId), url: readerUrl(loc), title,
      order: 0, groupIds: ['book'], rawTypes: category, related: false, contentLanguage: language}],
    defaultEntryId: entryId};
}
export function parsePages(body: string, url: string): SourceSnapshot {
  const loc = location(url);
  if (!loc.reader) return invalid();
  const data = json(body), work = comic(data.comic, loc.slug);
  if (data.chapter !== null || data.next_chapter !== null || !Array.isArray(data.images) ||
      data.images.length !== work.pages || (loc.page ?? 1) > work.pages) return invalid();
  const ids = new Set<number>(), orders = new Set<number>();
  const items = data.images.map(value => {
    const image = object(value), id = positive(image.id), page = positive(image.page, work.pages);
    if (ids.has(id) || orders.has(page)) return invalid();
    ids.add(id); orders.add(page);
    return {id: `image-${id}`, order: page - 1, width: 0, height: 0,
      resource: {kind: 'http' as const, url: asset(image.source_url, work.id)}};
  }).sort((a, b) => a.order - b.order);
  // Explicit page numbers and the declared total, never filename guesses or URL deduplication.
  if (items.some((item, index) => item.order !== index)) return invalid();
  return {url, adapter: 'nhentaicom', title: work.title, direction: 'rtl', discoveryComplete: true,
    knownTotal: work.pages, note: '', items};
}
async function request(url: string, pages: boolean, context: SourceNetworkContext) {
  const loc = location(url);
  if (loc.reader !== pages) return invalid();
  context.signal?.throwIfAborted();
  const endpoint = `${origin}/api/comics/${loc.slug}${pages ? '/images' : ''}?lang=${loc.locale}&nsfw=false`;
  const body = await context.request(endpoint, {referer: catalogUrl(loc)});
  context.signal?.throwIfAborted();
  return body;
}
export const network = {
  pageTransport: ['catalog', 'pages'],
  async catalog(url, context) {return parseCatalog(await request(url, false, context), url);},
  async pages(url, context) {return parsePages(await request(url, true, context), url);},
} satisfies SourceNetwork;
