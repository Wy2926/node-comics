import type {SourceNetwork} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceEntry, SourceSnapshot} from '../../contracts/source';
import {catalogKey, catalogUrl, chapterKey, origin} from './definition';
import {asset, count, invalid, list, object, parseReader, parseWork, remoteId, request, sourceLocation, text} from './protocol';
import {search} from './search';
import {chapterToken} from './token';

export function parseCatalog(work: ReturnType<typeof parseWork>, rows: unknown[]): SourceCatalogSnapshot {
  const id = catalogKey(work.slug), seen = new Set<string>(), slots = new Map<string, number>();
  const entries: SourceEntry[] = rows.map((value, index) => {
    const row = object(value), chapterId = remoteId(row.id), url = text(row.url, 2048), loc = sourceLocation(url);
    const chapter = text(row.chapter, 80);
    if (loc.slug !== work.slug || loc.id !== chapterId || loc.chapter !== chapter || seen.has(chapterId) ||
        !['media', 'text'].includes(text(row.chapter_type))) return invalid();
    seen.add(chapterId);
    let contentLanguage: string | undefined;
    if (row.language != null && row.language !== '') {
      try {contentLanguage = Intl.getCanonicalLocales(text(row.language, 40))[0];} catch {return invalid();}
    }
    const slot = id + ':chapter:' + chapter;
    if (!slots.has(slot)) slots.set(slot, index);
    const label = row.title == null || row.title === '' ? '' : text(row.title);
    return {id: chapterKey(chapterId), catalogId: id, remoteId: chapterId, url,
      title: `Ch. ${chapter}` + (label ? ' · ' + label : ''), groupIds: ['chapters'],
      rawTypes: row.group_name ? [text(row.group_name, 180)] : [], order: slots.get(slot)!, related: false,
      contentLanguage, readingSlotId: slot, sequenceId: id, ...(row.chapter_type === 'text' ? {readable: false} : {})};
  });
  return {id, sourceId: 'mangataro', url: catalogUrl(work.slug), title: work.title, cover: work.cover, observedAt: Date.now(),
    complete: true, note: '', groups: [{id: 'chapters', title: 'Chapters', complete: true, entryIds: entries.map(e => e.id)}],
    entries, defaultEntryId: entries.find(e => e.readable !== false)?.id};
}
export function parsePages(body: string, reader: ReturnType<typeof parseReader>, url: string): SourceSnapshot {
  const data = object(JSON.parse(body));
  if (data.success !== true || remoteId(data.chapter_id) !== reader.id || data.chapter_type !== 'media')
    throw Error('MangaTaro 未提供可读的漫画图片，请在源站确认访问条件。');
  const images = list(data.images, 1500);
  if (!images.length || count(data.total, 1500) !== images.length) return invalid();
  const items = images.map((value, order) => ({id: 'page-' + order, order, width: 0, height: 0,
    resource: {kind: 'http' as const, url: asset(value)}}));
  return {url, adapter: 'mangataro', title: reader.title, direction: 'ltr', discoveryComplete: true, knownTotal: items.length, note: '', items};
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = sourceLocation(url);
    if (loc.id) return invalid();
    const referer = catalogUrl(loc.slug), work = parseWork(await request(referer, context, referer), referer);
    const rows: unknown[] = []; let total: number | undefined;
    // Sequential 500-entry batches: bounded memory and no speculative requests beyond has_more.
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({manga_id: work.mangaId, offset: String(rows.length), limit: '500', order: 'ASC', ...chapterToken()});
      const data = object(JSON.parse(await request(`${origin}/auth/manga-chapters?${params}`, context, referer)));
      const batch = list(data.chapters), currentTotal = count(data.total);
      if (data.success !== true || count(data.offset) !== rows.length || data.limit !== 500 ||
          (total !== undefined && total !== currentTotal) || typeof data.has_more !== 'boolean' ||
          batch.length !== Math.min(500, currentTotal - rows.length)) return invalid();
      total = currentTotal; rows.push(...batch);
      if (data.has_more !== (rows.length < total)) return invalid();
      if (!data.has_more) return parseCatalog(work, rows);
    }
    return invalid();
  },
  async pages(url, context) {
    const loc = sourceLocation(url);
    if (!loc.id) return invalid();
    const reader = parseReader(await request(url, context, catalogUrl(loc.slug)), url);
    return parsePages(await request(`${origin}/auth/chapter-content?chapter_id=${loc.id}`, context, url), reader, url);
  },
} satisfies SourceNetwork;
