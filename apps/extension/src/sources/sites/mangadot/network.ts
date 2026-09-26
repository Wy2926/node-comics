import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceEntry, SourceSnapshot} from '../../contracts/source';
import {catalogUrl, mangaDotLocation, releaseKey, releaseUrl, type ReleaseKind, type ReleaseSource} from './definition';
import {assetUrl, count, id, invalid, language, list, number, object, request, text, type JsonObject} from './protocol';
import {search} from './search';

function location(url: string) {return mangaDotLocation(new URL(url)) ?? invalid();}
function release(row: unknown, kind: ReleaseKind) {
  const data = object(row), source: ReleaseSource = kind === 'volume' ? 'user' : data.source === 'scraper' || data.source === 'user' ? data.source : invalid();
  const date = text(data.date_added, 100), added = Date.parse(date.replace(' ', 'T').replace(/\+00$/, 'Z'));
  if (!Number.isFinite(added)) return invalid();
  const groups = list(data.groups, 100).map(value => text(object(value).name, 180));
  const labels = [...groups, ...(!groups.length && data.group_name ? [text(data.group_name, 180)] : []), ...(data.scanlator_name ? [text(data.scanlator_name, 180)] : [])];
  return {id: id(data.id), source, kind, number: number(kind === 'volume' ? data.volume_number : data.chapter_number), added,
    title: data.chapter_title == null || data.chapter_title === '' ? undefined : text(data.chapter_title, 1500),
    language: language(data.language), pages: count(data.page_count), labels: [...new Set(labels)]};
}
type Release = ReturnType<typeof release>;
function title(row: Pick<Release, 'kind' | 'number' | 'title'>) {
  return `${row.kind === 'volume' ? 'Vol.' : 'Ch.'} ${row.number}${row.title ? ' · ' + row.title : ''}`;
}
export function parseCatalog(metadata: unknown, chaptersValue: unknown, volumesValue: unknown, mangaId: string): SourceCatalogSnapshot {
  const result = object(metadata), manga = object(result.manga);
  if (id(manga.id) !== mangaId) return invalid();
  const chapters = list(chaptersValue).map(row => release(row, 'chapter')), volumes = list(volumesValue).map(row => release(row, 'volume'));
  // The website groups releases by chapter_number (and volumes separately by volume_number).
  if (new Set(chapters.map(row => row.number)).size !== count(result.total_chapters) ||
      new Set(volumes.map(row => row.number)).size !== count(result.total_volumes)) return invalid();
  const rows = [...chapters, ...volumes].sort((a, b) => a.kind.localeCompare(b.kind) || a.number - b.number || a.added - b.added ||
    a.source.localeCompare(b.source) || Number(a.id) - Number(b.id));
  const seen = new Set<string>(), slots = new Map<string, number>(), catalogId = 'mangadot:' + mangaId;
  const entries: SourceEntry[] = rows.map(row => {
    const entryId = releaseKey(row.id, row.source, row.kind), slot = `${catalogId}:${row.kind}:${row.number}`;
    if (seen.has(entryId)) return invalid();
    seen.add(entryId);
    if (!slots.has(slot)) slots.set(slot, slots.size);
    return {id: entryId, remoteId: `${row.source}:${row.kind}:${row.id}`, catalogId,
      url: releaseUrl(row.id, row.source, row.kind, mangaId), title: title(row), groupIds: [row.kind], rawTypes: row.labels,
      contentLanguage: row.language, readingSlotId: slot, sequenceId: `${catalogId}:${row.kind}s`,
      order: slots.get(slot)!, related: false, readable: row.pages > 0};
  });
  return {id: catalogId, sourceId: 'mangadot', url: catalogUrl(mangaId), title: text(manga.title),
    cover: manga.photo ? {url: assetUrl(manga.photo, 'cover')} : undefined, complete: true, observedAt: Date.now(), note: '', entries,
    groups: (['chapter', 'volume'] as const).map(kind => ({id: kind, title: kind === 'chapter' ? 'Chapters' : 'Volumes', complete: true,
      entryIds: entries.filter(entry => entry.groupIds.includes(kind)).map(entry => entry.id)})),
    defaultEntryId: entries.find(entry => entry.readable)?.id};
}
function chapterData(value: unknown, url: string) {
  const loc = location(url), requested = loc.release;
  if (!requested) return invalid();
  const data = object(value), chapter = object(data.chapter), manga = object(data.manga), mangaId = id(manga.id);
  if (id(chapter.id) !== requested.id || id(chapter.manga_id) !== mangaId || loc.mangaId && loc.mangaId !== mangaId ||
      requested.source === 'user' && (data.source !== 'user' || data.type !== requested.kind || chapter.type !== requested.kind) ||
      requested.source === 'scraper' && (data.source != null && data.source !== 'scraper' || chapter.type != null && chapter.type !== 'chapter')) return invalid();
  if (chapter.status != null && chapter.status !== 'approved') throw Error('MangaDot 此发布条目暂不可读，请在源站确认状态。');
  return {data, chapter, mangaId, requested};
}
export function parsePages(value: unknown, url: string): SourceSnapshot {
  const {data, chapter, mangaId, requested} = chapterData(value, url), images = list(data.images, 1500), pages = count(chapter.page_count, 1500);
  if (images.length !== pages) return invalid();
  if (!pages) throw Error('MangaDot 此发布条目没有正文图片，请在源站确认状态。');
  const items = images.map((value, order) => {
    const image = object(value);
    return {id: 'page-' + order, order, width: count(image.w, 100000), height: count(image.h, 100000),
      resource: {kind: 'http' as const, url: assetUrl(image.url, 'page', mangaId)}};
  });
  return {url, adapter: 'mangadot', title: title({kind: requested.kind,
    number: number(requested.kind === 'volume' ? chapter.volume_number : chapter.chapter_number),
    title: chapter.chapter_title ? text(chapter.chapter_title) : undefined}),
    direction: 'rtl', note: '', discoveryComplete: true, knownTotal: items.length, items};
}
async function readRelease(url: string, context: SourceNetworkContext): Promise<JsonObject> {
  const entry = location(url).release;
  if (!entry) return invalid();
  return object(await request(`/api/${entry.source === 'user' ? 'uploads' : 'chapters'}/${entry.id}/images`,
    releaseUrl(entry.id, entry.source, entry.kind), context));
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = location(url);
    if (!loc.mangaId || loc.release) return invalid();
    const referer = catalogUrl(loc.mangaId), path = '/api/manga/' + loc.mangaId;
    const metadata = await request(path, referer, context);
    const chapters = await request(path + '/chapters/list', referer, context);
    const volumes = await request(path + '/volumes', referer, context);
    return parseCatalog(metadata, chapters, volumes, loc.mangaId);
  },
  async resolveCatalog(url, context) {return catalogUrl(chapterData(await readRelease(url, context), url).mangaId);},
  async pages(url, context) {return parsePages(await readRelease(url, context), url);},
} satisfies SourceNetwork;
