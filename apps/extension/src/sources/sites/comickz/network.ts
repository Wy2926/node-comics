import type {SourceNetwork} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceEntry, SourceGroup, SourceSnapshot} from '../../contracts/source';
import {catalogKey, catalogUrl, chapterKey, origin} from './definition';
import {asset, count, cover, embedded, hid, invalid, json, language, list, numberLabel, object, request, slug, sourceLocation, text, type Row} from './protocol';
import {search} from './search';

function chapterTitle(row: Row) {
  const chap = numberLabel(row.chap), vol = numberLabel(row.vol);
  return [vol === null ? '' : 'Vol. ' + vol, chap === null ? '' : 'Ch. ' + chap, row.title ? text(row.title) : ''].filter(Boolean).join(' · ') || 'Chapter';
}
export function chapterUrl(work: string, row: Row) {
  return `${catalogUrl(work)}/${hid(row.hid)}-chapter-${numberLabel(row.chap)}-${language(row.lang).toLowerCase()}`;
}
export function parseCatalog(work: Row, rows: unknown[], url: string): SourceCatalogSnapshot {
  const loc = sourceLocation(url), workSlug = slug(work.slug), id = catalogKey(workSlug);
  if (loc.hid || loc.slug !== workSlug || count(work.chapter_count) !== rows.length) return invalid();
  const groups = new Map<string, SourceGroup>(), seen = new Set<string>(), numericIds = new Set<number>(), slots = new Map<string, number>();
  const entries: SourceEntry[] = rows.map((value, index) => {
    const row = object(value), chapter = hid(row.hid), numericId = count(row.id, Number.MAX_SAFE_INTEGER);
    if (!numericId || seen.has(chapter) || numericIds.has(numericId)) return invalid();
    seen.add(chapter); numericIds.add(numericId);
    const vol = numberLabel(row.vol), chap = numberLabel(row.chap), groupId = vol === null ? 'chapters' : 'volume:' + vol;
    const group = groups.get(groupId) ?? {id: groupId, title: vol === null ? 'Chapters' : 'Vol. ' + vol, complete: true, entryIds: []};
    groups.set(groupId, group);
    const entryId = chapterKey(chapter); group.entryIds.push(entryId);
    // Volume is explicit source data. Do not merge unnumbered releases or guess across volume boundaries.
    const slot = chap === null ? undefined : `${id}:${groupId}:chapter:${chap}`;
    if (slot && !slots.has(slot)) slots.set(slot, index);
    return {id: entryId, catalogId: id, remoteId: chapter, url: chapterUrl(workSlug, row), title: chapterTitle(row), groupIds: [groupId],
      rawTypes: list(row.group_name, 30).map(value => text(value, 180)), order: slot ? slots.get(slot)! : index, related: false,
      contentLanguage: language(row.lang), readingSlotId: slot, sequenceId: slot ? `${id}:${groupId}` : entryId};
  });
  return {id, sourceId: 'comickz', url: catalogUrl(workSlug), title: text(work.title), cover: cover(work.default_thumbnail, workSlug),
    observedAt: Date.now(), complete: true, note: '', groups: [...groups.values()], entries, defaultEntryId: entries[0]?.id};
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const loc = sourceLocation(url), chapter = object(embedded(html, 'sv-data').chapter), work = object(chapter.comic);
  if (!loc.hid || hid(chapter.hid) !== loc.hid || slug(work.slug) !== loc.slug || String(numberLabel(chapter.chap)) !== loc.chap ||
      language(chapter.lang).toLowerCase() !== loc.lang || chapter.external_type != null) return invalid();
  const rows = list(chapter.images, 1500);
  if (!rows.length) throw Error('ComicK 未提供章节正文，请在源站确认是否可读。');
  const directory = `${numberLabel(chapter.vol) ?? 0}_${numberLabel(chapter.chap) ?? 0}/${loc.lang}`;
  const items = rows.map((value, order) => {
    const row = object(value);
    return {id: 'page-' + order, order, width: count(row.w, 1000000), height: count(row.h, 1000000),
      resource: {kind: 'http' as const, url: asset(row.url, loc.slug, directory)}};
  });
  return {url, adapter: 'comickz', title: chapterTitle(chapter), direction: 'ltr', discoveryComplete: true, knownTotal: items.length, note: '', items};
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = sourceLocation(url);
    if (loc.hid) return invalid();
    const work = embedded(await request(catalogUrl(loc.slug), context), 'comic-data');
    if (slug(work.slug) !== loc.slug) return invalid();
    const total = count(work.chapter_count);
    let pages = 1, perPage: number | undefined;
    async function readPage(page: number) {
      // The source's "all" option omits lang; sending lang=all returns an empty list.
      const target = `${origin}/api/comics/${loc.slug}/chapter-list?chapOrder=asc&page=${page}`;
      const data = json(await request(target, context)), meta = object(data.pagination), batch = list(data.data, 1000);
      const size = count(meta.per_page, 1000), last = count(meta.last_page, 10000);
      if (!size || count(meta.current_page) !== page || count(meta.total) !== total || last !== Math.max(1, Math.ceil(total / size)) ||
          perPage !== undefined && perPage !== size || batch.length !== Math.min(size, Math.max(0, total - (page - 1) * size))) return invalid();
      perPage = size; pages = last;
      return batch;
    }
    const rows = await readPage(1);
    // Bounded prefetch; retain the source's page order and validate every total before publishing.
    for (let page = 2; page <= pages; page += 3) {
      const batches = await Promise.all(Array.from({length: Math.min(3, pages - page + 1)}, (_, offset) => readPage(page + offset)));
      for (const batch of batches) rows.push(...batch);
    }
    return parseCatalog(work, rows, url);
  },
  async pages(url, context) {
    const loc = sourceLocation(url);
    if (!loc.hid) return invalid();
    const target = new URL(url); target.search = ''; target.hash = '';
    return parsePages(await request(target.href, context), url);
  },
} satisfies SourceNetwork;
