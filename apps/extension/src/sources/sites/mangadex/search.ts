import type {SourceNetworkContext} from '../../contracts/network';
import {SourceSearchError, type SourceSearchPage, type SourceSearchRequest} from '../../contracts/search';
import {apiOrigin, catalogUrl} from './definition';
import {contentLanguage, id, list, object, relationships, response, text} from './protocol';

const pageSize = 12;
const invalid = () => new SourceSearchError('SOURCE_SEARCH_INVALID');
export function searchUrl(request: SourceSearchRequest) {
  if (request.siteId !== 'mangadex') throw invalid();
  const offset = request.cursor === undefined ? 0 : /^offset:[1-9]\d{0,3}$/.test(request.cursor) ? Number(request.cursor.slice(7)) : NaN;
  if (!Number.isSafeInteger(offset) || offset % pageSize || offset + pageSize > 10000) throw invalid();
  const url = new URL('/manga', apiOrigin);
  url.search = new URLSearchParams({limit: String(pageSize), offset: String(offset), title: request.query, 'order[relevance]': 'desc'}).toString();
  for (const include of ['cover_art', 'author']) url.searchParams.append('includes[]', include);
  return {url: url.href, offset};
}
export function parseSearch(body: string, request: SourceSearchRequest): SourceSearchPage {
  const {offset} = searchUrl(request), result = response(JSON.parse(body)), rows = list(result.data), total = result.total;
  if (result.response !== 'collection' || result.limit !== pageSize || result.offset !== offset ||
      !Number.isSafeInteger(total) || Number(total) < 0 || rows.length > pageSize || rows.length !== Math.min(pageSize, Math.max(0, Number(total) - offset))) throw invalid();
  const seen = new Set<string>();
  const items = rows.map(value => {
    const row = object(value), mangaId = id(row.id), attributes = object(row.attributes), titles = object(attributes.title);
    if (row.type !== 'manga' || seen.has(mangaId)) throw invalid();
    seen.add(mangaId);
    const languages = attributes.availableTranslatedLanguages == null ? [] : list(attributes.availableTranslatedLanguages).map(contentLanguage);
    if (languages.length > 100) throw invalid();
    const title = text(titles.en ?? titles[String(attributes.originalLanguage)] ?? Object.values(titles)[0], 500);
    const authors = relationships(row, 'author').filter(author => author.attributes).map(author => text(object(author.attributes).name, 180));
    const covers = relationships(row, 'cover_art');
    if (covers.length > 1 || authors.length > 30) throw invalid();
    let cover: {url: string} | undefined;
    if (covers[0]?.attributes) {
      const filename = text(object(covers[0].attributes).fileName, 255);
      if (!/^[a-z\d_-]+\.(?:jpg|jpeg|png|webp|gif|avif)$/i.test(filename)) throw invalid();
      cover = {url: `https://uploads.mangadex.org/covers/${mangaId}/${filename}.512.jpg`};
    }
    return {catalogId: 'mangadex:' + mangaId, catalogUrl: catalogUrl(mangaId), title, authors, cover,
      ...(languages.length ? {contentLanguages: [...new Set(languages)]} : {})};
  });
  return {items, ...(offset + items.length < Number(total) && offset + pageSize * 2 <= 10000 ? {nextCursor: 'offset:' + (offset + pageSize)} : {})};
}
export async function search(request: SourceSearchRequest, context: SourceNetworkContext) {
  context.signal?.throwIfAborted();
  const body = await context.request(searchUrl(request).url);
  context.signal?.throwIfAborted();
  return parseSearch(body, request);
}
