import {describe, expect, it, vi} from 'vitest';
import {definition, api, catalogUrl, chapterUrl, mangaBallLocation} from '../definition';
import {network, parseCatalog, parsePages, readerData} from '../network';
import {validateSourceCatalog} from '../../../index';
import {imageUrl} from '../protocol';
import {chapterId, groups, image, listing, otherTitleId, reader, row, secondChapterId, success, thirdChapterId, title, titleId} from './fixtures';

describe('MangaBall HTTP isolation and catalog', () => {
  it('recognizes exact hosts, title slugs and chapter IDs independently of the display hint', () => {
    expect(definition.identify(new URL(catalogUrl(titleId) + '-fixture-work'))?.catalog?.key).toBe('mangaball:' + titleId);
    expect(definition.identify(new URL(chapterUrl(chapterId) + '?chapter=0.1'))?.pageKey).toBe('mangaball:chapter:' + chapterId);
    expect(definition.identify(new URL(chapterUrl(chapterId, titleId)))?.catalog?.key).toBe('mangaball:' + titleId);
    for (const url of ['http://mangaball.com/title-detail/' + titleId, 'https://mangaball.com.evil.test/title-detail/' + titleId,
      'https://user:pass@mangaball.com/title-detail/' + titleId, 'https://mangaball.com:444/title-detail/' + titleId]) expect(definition.identify(new URL(url))).toBeNull();
    for (const url of [catalogUrl('bad'), chapterUrl(chapterId) + '?chapter=1&chapter=2', chapterUrl(chapterId) + '#nodelane-mangaball=bad']) expect(mangaBallLocation(new URL(url))).toBeNull();
    expect(definition.installation.optionalContentMatches).toEqual(['https://mangaball.com/*']);
    expect(definition.embeddedEntry).toBe('floating');
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
  });
  it('keeps source-proven same-chapter releases, order, language and separate identities', () => {
    const catalog = validateSourceCatalog(parseCatalog(title(), groups(), titleId));
    expect(catalog.entries.map(row => row.remoteId)).toEqual([chapterId, secondChapterId, thirdChapterId]);
    expect(catalog.entries.map(row => row.order)).toEqual([0, 0, 1]);
    expect(catalog.entries.map(row => row.contentLanguage)).toEqual(['en', 'es', 'zh-Hans']);
    expect(catalog.entries[0].readingSlotId).toBe(catalog.entries[1].readingSlotId);
    expect(catalog.entries[0].sequenceId).toBe(catalog.entries[2].sequenceId);
    expect(catalog.entries[0].rawTypes).toEqual(['Public group']);
    expect(catalog.cover?.url).toBe('https://bulbasaur.poke-black-and-white.net/covers/' + titleId + '/cover_123.jpg');
    for (const entry of catalog.entries) expect(definition.identify(new URL(entry.url))?.pageKey).toBe(entry.id);
    const unnamed = parseCatalog(title(1), [{chapter_number: null, releases: [row(chapterId, null), row(secondChapterId, null)]}], titleId);
    expect(unnamed.entries.every(row => !row.readingSlotId)).toBe(true);
    expect(unnamed.entries[0].sequenceId).not.toBe(unnamed.entries[1].sequenceId);
    expect(parseCatalog(title(0), [], titleId).entries).toEqual([]);
  });
  it('rejects incomplete, duplicate or foreign directories and keeps previous snapshots immutable', async () => {
    const previous = parseCatalog(title(), groups(), titleId), before = structuredClone(previous);
    for (const [metadata, list] of [[title(4), groups()], [title(), [...groups(), groups()[0]]],
      [title(2), [{chapter_number: 1, releases: [row(), row()]}]], [title(1), [{chapter_number: 1, releases: [{...row(), title_id: otherTitleId}]}]],
      [title(1), [{chapter_number: 2, releases: [row()]}]], [title(1), [{chapter_number: 1, releases: []}]]] as const)
      expect(() => parseCatalog(metadata, [...list], titleId)).toThrow();
    await expect(network.catalog(catalogUrl(titleId), {previous, request: async url => JSON.stringify(url.includes('/detail/') ? title() : listing([], 2))})).rejects.toThrow();
    expect(previous).toEqual(before);
  });
  it('reads all pages of grouped releases; cross-checks complete release counts and response lists', async () => {
    const all = Array.from({length: 101}, (_, number) => ({chapter_number: number, title: 'Chapter ' + number, releases: [row((number + 1).toString(16).padStart(24, '0'), number)]}));
    const requests: string[] = [];
    const value = await network.catalog(catalogUrl(titleId), {request: async url => {
      requests.push(url);
      if (url.includes('/detail/')) return JSON.stringify(title(101));
      const page = Number(new URL(url).searchParams.get('page'));
      return JSON.stringify(listing(all.slice((page - 1) * 100, page * 100), 101, page));
    }});
    expect(value.entries).toHaveLength(101); expect(requests).toHaveLength(3);
    for (const url of requests.slice(1)) {
      expect(new URL(url).searchParams.get('language')).toBe('all');
      expect(new URL(url).searchParams.get('group_by')).toBe('chapter');
    }
    const broken = listing(); broken.data = [];
    await expect(network.catalog(catalogUrl(titleId), {request: async url => JSON.stringify(url.includes('/detail/') ? title() : broken)})).rejects.toThrow();
  });
  it('rejects oversized totals and release batches before any later HTTP page or direct parser retention', async () => {
    const overGroups = listing([], 10001);
    const dense = Array.from({length: 100}, (_, number) => ({chapter_number: number, title: 'Chapter ' + number,
      releases: Array(101).fill(row(chapterId, number))}));
    const overReleases = listing(dense, 200);
    for (const value of [overGroups, overReleases]) {
      const fetcher = vi.fn(async (url: string) => JSON.stringify(url.includes('/detail/') ? title(200) : value));
      await expect(network.catalog(catalogUrl(titleId), {request: fetcher})).rejects.toThrow('10000');
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls.every(([url]) => !url.includes('page=2'))).toBe(true);
    }
    expect(() => parseCatalog(title(10001), Array(10001).fill(groups()[0]), titleId)).toThrow('10000');
    expect(() => parseCatalog(title(1), [{chapter_number: 1, releases: Array(10001).fill(row())}], titleId)).toThrow('10000');
    expect(() => parseCatalog(title(10001), groups(), titleId, false)).toThrow('10000');
  });
  it.each(['owner', 'budget'])('stops before listing requests or progress for invalid %s title details', async mode => {
    const metadata = title(mode === 'budget' ? 10001 : 2);
    if (mode === 'owner') {metadata.data.id = otherTitleId; metadata.data._id = otherTitleId;}
    const previous = parseCatalog(title(), groups(), titleId), before = structuredClone(previous);
    const fetcher = vi.fn(async (_url: string) => JSON.stringify(metadata)), progress = vi.fn();
    await expect(network.catalog(catalogUrl(titleId), {request: fetcher, previous, onCatalogProgress: progress})).rejects.toThrow(mode === 'owner' ? '归属' : '10000');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toBe(api + '/title/detail/' + titleId);
    expect(progress).not.toHaveBeenCalled(); expect(previous).toEqual(before);
  });
  it('verifies chapter and parent metadata and keeps API image addresses in stable page slots', () => {
    const snapshot = parsePages(reader(), chapterUrl(chapterId, titleId));
    expect(snapshot).toMatchObject({discoveryComplete: true, knownTotal: 2, adapter: 'mangaball'});
    expect(snapshot.items.map(row => row.id)).toEqual(['page-0', 'page-1']);
    expect(snapshot.items[0].resource).toEqual(snapshot.items[1].resource);
    expect(readerData(reader(), chapterUrl(chapterId)).titleId).toBe(titleId);
    expect(() => parsePages(reader(), chapterUrl(chapterId, otherTitleId))).toThrow('不属于');
    expect(() => parsePages(reader(), chapterUrl(secondChapterId))).toThrow('不属于');
    expect(() => parsePages(reader([]), chapterUrl(chapterId))).toThrow();
    const mismatched = reader(); mismatched.data.title.id = otherTitleId;
    expect(() => parsePages(mismatched, chapterUrl(chapterId))).toThrow();
    for (const url of [image.replace('chikorita.red-and-blue.net', 'images.example.test'), image.replace(chapterId, secondChapterId),
      image.replace(titleId, otherTitleId), image.replace('/storage/', '/raw/'), image.replace('https:', 'http:'), image.replace('.net/', '.net:444/')])
      expect(imageUrl(url)).toBe(url);
  });
  it('performs pure GET operations, aborting before and after responses without another channel', async () => {
    const request = vi.fn(async (url: string) => JSON.stringify(url.includes('/title/detail/') ? title() : url.includes('/chapter-listing') ? listing() : reader()));
    expect(await network.resolveCatalog(chapterUrl(chapterId), {request})).toBe(catalogUrl(titleId));
    await network.pages(chapterUrl(chapterId), {request}); await network.catalog(catalogUrl(titleId), {request});
    expect(request.mock.calls.every(([url]) => url.startsWith(api + '/'))).toBe(true);
    for (const operation of ['catalog', 'pages', 'resolveCatalog'] as const) {
      const target = operation === 'catalog' ? catalogUrl(titleId) : chapterUrl(chapterId), controller = new AbortController(), never = vi.fn();
      controller.abort(); await expect(network[operation](target, {request: never, signal: controller.signal})).rejects.toThrow(); expect(never).not.toHaveBeenCalled();
      const inFlight = new AbortController();
      await expect(network[operation](target, {signal: inFlight.signal, request: async () => {inFlight.abort(); return JSON.stringify(success({}));}})).rejects.toThrow();
    }
  });
});
