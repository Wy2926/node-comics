import type {SourceNetwork} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceEntry, SourceSnapshot} from '../../contracts/source';
import {atsuLocation, catalogUrl, cdnOrigin, chapterKey, chapterUrl} from './definition';
import {assetUrl, count, id, invalid, list, object, request, text} from './protocol';
import {search} from './search';

function location(url: string) {return atsuLocation(new URL(url)) ?? invalid();}
function mangaMetadata(metadata: unknown, mangaId: string) {
  const manga = object(object(metadata).mangaPage);
  if (id(manga.id) !== mangaId || manga.medium !== 'Comic') return invalid();
  return manga;
}
export function parseCatalog(metadata: unknown, allChapters: unknown, mangaId: string): SourceCatalogSnapshot {
  const manga = mangaMetadata(metadata, mangaId);
  const scanlators = list(manga.scanlators, 1000).map(value => {
    const row = object(value); return {id: id(row.id), title: text(row.name, 180)};
  });
  const groupIds = new Set(scanlators.map(row => row.id));
  if (groupIds.size !== scanlators.length) return invalid();
  const rows = list(object(allChapters).chapters).map(value => {
    const row = object(value), scanlator = id(row.scanlationMangaId);
    if (!groupIds.has(scanlator)) return invalid();
    return {id: id(row.id), scanlator, title: text(row.title), index: count(row.index, 1000000), pages: count(row.pageCount, 1500)};
  });
  const chaptersById = new Map(rows.map(row => [row.id, row]));
  if (chaptersById.size !== rows.length) return invalid();
  // allChapters is the site's full-list endpoint. totalChapterCount is the highest
  // chapter number (possibly fractional), not the number of scanlation releases.
  // Reject responses that even omit or misattribute a chapter already in the preview.
  for (const value of list(manga.chapters)) {
    const preview = object(value), chapter = chaptersById.get(id(preview.id));
    if (!chapter || chapter.scanlator !== id(preview.scanlationMangaId)) return invalid();
  }
  // index is the source's reading order within one scanlation. Different scanlations remain independent chains.
  const ranks = new Map(scanlators.map((row, index) => [row.id, index]));
  rows.sort((a, b) => ranks.get(a.scanlator)! - ranks.get(b.scanlator)! || a.index - b.index || a.id.localeCompare(b.id));
  const seenPositions = new Set<string>(), catalogId = 'atsu:' + mangaId;
  const groupEntries = new Map(scanlators.map(group => [group.id, [] as string[]]));
  const entries: SourceEntry[] = rows.map((row, order) => {
    const position = row.scanlator + ':' + row.index;
    if (seenPositions.has(position)) return invalid();
    seenPositions.add(position);
    const entryId = chapterKey(mangaId, row.id);
    groupEntries.get(row.scanlator)!.push(entryId);
    return {id: entryId, catalogId, remoteId: row.id, url: chapterUrl(mangaId, row.id), title: row.title,
      groupIds: [row.scanlator], rawTypes: [scanlators[ranks.get(row.scanlator)!].title], order, related: false,
      sequenceId: `${catalogId}:scanlation:${row.scanlator}`, readable: row.pages > 0};
  });
  const poster = manga.poster == null ? undefined : object(manga.poster);
  return {id: catalogId, sourceId: 'atsu', url: catalogUrl(mangaId), title: text(manga.title),
    cover: poster ? {url: assetUrl(poster.image, 'cover')} : undefined, observedAt: Date.now(), complete: true, note: '', entries,
    groups: scanlators.map(group => ({...group, complete: true, entryIds: groupEntries.get(group.id)!})),
    defaultEntryId: entries.find(row => row.readable)?.id};
}
function preparePages(value: unknown, url: string) {
  const loc = location(url);
  if (!loc.chapterId) return invalid();
  const chapter = object(object(value).readChapter);
  if (id(chapter.id) !== loc.chapterId) return invalid();
  const scanlator = id(chapter.scanlationMangaId);
  // read.chapter is the site's unpaginated full-page endpoint. It supplies zero-based page numbers and IDs.
  const rows = list(chapter.pages, 1500);
  if (!rows.length) throw Error('Atsumaru 此章节没有正文图片，请在源站确认状态。');
  const seen = new Set<string>();
  let needsOwnership = false;
  const items = rows.map((value, order) => {
    const row = object(value), pageId = text(row.id, 100);
    if (pageId !== `${loc.chapterId}-${order}` || count(row.number, 1500) !== order || seen.has(pageId)) return invalid();
    seen.add(pageId);
    const image = assetUrl(row.image, 'page', loc.mangaId, loc.chapterId, scanlator);
    if (!image.startsWith(`${cdnOrigin}/static/pages/${loc.mangaId}/${loc.chapterId}/`)) needsOwnership = true;
    return {id: pageId, order, width: count(row.width, Number.MAX_SAFE_INTEGER), height: count(row.height, Number.MAX_SAFE_INTEGER),
      resource: {kind: 'http' as const, url: image}};
  });
  const snapshot: SourceSnapshot = {url, adapter: 'atsu', title: text(chapter.title), direction: 'rtl', note: '',
    discoveryComplete: true, knownTotal: items.length, items};
  return {mangaId: loc.mangaId, scanlator, needsOwnership, snapshot};
}
function confirmPages(prepared: ReturnType<typeof preparePages>, metadata?: unknown): SourceSnapshot {
  if (prepared.needsOwnership) {
    // read.chapter ignores mangaId. Scanlation/chapter-only paths need independent work ownership evidence.
    const manga = mangaMetadata(metadata, prepared.mangaId);
    if (!list(manga.scanlators, 1000).some(value => id(object(value).id) === prepared.scanlator)) return invalid();
  }
  return prepared.snapshot;
}
export function parsePages(value: unknown, url: string, metadata?: unknown): SourceSnapshot {
  return confirmPages(preparePages(value, url), metadata);
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapterId) return invalid();
    const referer = catalogUrl(loc.mangaId);
    const metadata = await request('/api/manga/page?id=' + loc.mangaId, referer, context);
    mangaMetadata(metadata, loc.mangaId);
    const chapters = await request('/api/manga/allChapters?mangaId=' + loc.mangaId, referer, context);
    return parseCatalog(metadata, chapters, loc.mangaId);
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapterId) return invalid();
    const data = await request(`/api/read/chapter?mangaId=${loc.mangaId}&chapterId=${loc.chapterId}`,
      chapterUrl(loc.mangaId, loc.chapterId), context);
    const prepared = preparePages(data, url);
    const metadata = prepared.needsOwnership ? await request('/api/manga/page?id=' + loc.mangaId, catalogUrl(loc.mangaId), context) : undefined;
    return confirmPages(prepared, metadata);
  },
} satisfies SourceNetwork;
