import 'fake-indexeddb/auto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {catalog, openCatalog} from '../../../../comics/repositories';
import {importManifest} from '../../../../comics/application/import-service';
import {importWebsiteLink} from '../../../../comics/application/website-import';
import {checkCatalogUpdates} from '../../../../comics/application/catalog-sync';
import type {SourceCatalog} from '../../../../comics/application/types';
import {validateSourceCatalog} from '../../../index';
import {readNetworkPages} from '../../../runtime/network';
import {catalogKey, catalogUrl, episodeUrl} from '../definition';
import {network} from '../network';
import {catalogData, graphql, html, pagesData, readerData, seriesId} from './fixtures';

const url = catalogUrl(seriesId), id = catalogKey(seriesId);
const importUrl = 'https://ridibooks.com/books/4921002551?_rdt_sid=webtoon_recommendation_reading_book&_rdt_idx=1';
let fetcher: ReturnType<typeof vi.fn<(target: string) => Promise<Response>>>;

beforeEach(() => {
  let rules: chrome.declarativeNetRequest.Rule[] = [];
  vi.stubGlobal('navigator', {locks: {request: async (_name: string, options: unknown, callback?: (lock: object) => unknown) =>
    (callback ?? options as (lock: object) => unknown)({})}});
  vi.stubGlobal('chrome', {
    runtime: {id: 'ridi-test', getURL: (path: string) => 'chrome-extension://ridi-test/' + path},
    permissions: {contains: vi.fn(async () => true)}, storage: {local: {set: vi.fn()}},
    declarativeNetRequest: {
      getSessionRules: async () => rules,
      updateSessionRules: async ({addRules = [], removeRuleIds = []}: Parameters<typeof chrome.declarativeNetRequest.updateSessionRules>[0]) => {
        rules = rules.filter(rule => !removeRuleIds.includes(rule.id)).concat(addRules);
      },
    },
  });
  fetcher = vi.fn(async (target: string) => {
    if (target === url) return new Response(html('__NEXT_DATA__', catalogData()));
    if (target === 'https://api.ridibooks.com/graphql') return Response.json(graphql());
    if (target === episodeUrl(seriesId)) return new Response(html('app_init', readerData()));
    if (target === 'https://ridibooks.com/api/web-viewer/generate') return Response.json(pagesData());
    throw Error('Unexpected source request');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => {
  for (const comic of await catalog.list('comics')) await catalog.deleteComic(comic.id);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function staleCatalog() {
  const saved = await catalog.get('catalogs', id) as unknown as SourceCatalog;
  const stale = {...saved, entries: saved.entries.map(entry => ({...entry, url: entry.url.split('#')[0]}))};
  await catalog.put('catalogs', stale);
  for (const entry of await catalog.listEntries(saved.comicId!))
    await catalog.patch('entries', entry.id, {sourceUrl: entry.sourceUrl!.split('#')[0]});
  expect(() => validateSourceCatalog(stale)).toThrow('INVALID_SOURCE_CATALOG');
  fetcher.mockClear();
  return stale;
}

describe('RIDI production link import', () => {
  it('imports the original recommendation URL and reopens the persisted catalog through the same entry point', async () => {
    const read = vi.spyOn(network, 'catalog'), first = await importWebsiteLink(importUrl);
    const saved = await catalog.get('catalogs', id) as unknown as SourceCatalog;
    expect(validateSourceCatalog(saved).entries).toHaveLength(3);
    expect(saved.entries.every(entry => new URL(entry.url).hash === '#nodelane-ridi=' + seriesId)).toBe(true);
    const entries = await catalog.listEntries(first.id);
    // Reopen IndexedDB, so a successful in-memory snapshot cannot hide a persistence regression.
    (await openCatalog()).dispatchEvent(new IDBVersionChangeEvent('versionchange'));
    expect((await importWebsiteLink(importUrl)).id).toBe(first.id);
    expect(await catalog.list('comics')).toHaveLength(1);
    expect(await catalog.listEntries(first.id)).toEqual(entries);
    expect(read.mock.calls[1][1].previous).toEqual(validateSourceCatalog(saved));
    expect(read.mock.calls[1][1].onCatalogProgress).toBeTypeOf('function');
    expect(fetcher.mock.calls.every(([target]) => target === url || target === 'https://api.ridibooks.com/graphql')).toBe(true);
  });

  it.each(['import', 'refresh'])('recovers missing chapter bindings on %s without resetting content, position or bookmarks', async action => {
    const comic = await importWebsiteLink(importUrl), [entry] = await catalog.listEntries(comic.id);
    await importManifest(await readNetworkPages(entry.sourceUrl!));
    const pages = await catalog.listPages(entry.contentId);
    const position = {id: entry.id, entryId: entry.id, comicId: comic.id, contentId: entry.contentId,
      pageId: pages[0].pageId, relativeOffset: .4, updatedAt: Date.now()};
    await catalog.savePosition(position);
    const bookmark = {...position, id: 'ridi-bookmark', title: 'Fixture', pageNumber: 1, locationKey: 'ridi-location', createdAt: Date.now(), note: ''};
    await catalog.put('bookmarks', bookmark);
    const before = await catalog.get('entries', entry.id);
    await staleCatalog();
    const read = vi.spyOn(network, 'catalog');
    if (action === 'import') expect((await importWebsiteLink(importUrl)).id).toBe(comic.id);
    else expect(await checkCatalogUpdates(comic.id, {manual: true})).toMatchObject({status: 'checked', hasUpdates: false});
    expect(read.mock.calls[0][1].previous).toBeUndefined();
    expect(fetcher).toHaveBeenCalled();
    expect(validateSourceCatalog(await catalog.get('catalogs', id)).entries).toHaveLength(3);
    expect(await catalog.list('comics')).toHaveLength(1);
    expect(await catalog.get('entries', entry.id)).toEqual(before);
    expect(await catalog.get('positions', entry.id)).toEqual(position);
    expect(await catalog.get('bookmarks', bookmark.id)).toEqual(bookmark);
    expect(await catalog.listPages(entry.contentId)).toEqual(pages);
    expect(await catalog.get('comics', comic.id)).toMatchObject({lastEntryId: entry.id, lastReadAt: position.updatedAt});
  });

  it('retains the stale snapshot and entries when the recovery request fails', async () => {
    const comic = await importWebsiteLink(importUrl), stale = await staleCatalog();
    const entries = await catalog.listEntries(comic.id);
    fetcher.mockResolvedValueOnce(new Response('Unavailable', {status: 503}));
    await expect(importWebsiteLink(importUrl)).rejects.toThrow('HTTP 503');
    expect(fetcher).toHaveBeenCalled();
    expect(await catalog.get('catalogs', id)).toEqual(stale);
    expect(await catalog.listEntries(comic.id)).toEqual(entries);
    expect(await catalog.list('comics')).toHaveLength(1);
  });

  it('waits for complete recovery instead of publishing a partial adapter result', async () => {
    const comic = await importWebsiteLink(importUrl);
    const valid = validateSourceCatalog(await catalog.get('catalogs', id)), stale = await staleCatalog(), onReady = vi.fn();
    vi.spyOn(network, 'catalog').mockImplementationOnce(async (_url, context) => {
      expect(context.previous).toBeUndefined();
      await context.onCatalogProgress?.({...valid, complete: false, groups: valid.groups.map(group => ({...group, complete: false}))});
      throw Error('Recovery interrupted');
    });
    await expect(importWebsiteLink(importUrl, {onReady})).rejects.toThrow('Recovery interrupted');
    expect(onReady).not.toHaveBeenCalled();
    expect(await catalog.get('catalogs', id)).toEqual(stale);
    expect(await catalog.listEntries(comic.id)).toHaveLength(3);
  });

  it('still rejects an unbound fresh catalog and does not replace the saved record', async () => {
    await importWebsiteLink(importUrl);
    const stale = await staleCatalog();
    vi.spyOn(network, 'catalog').mockResolvedValueOnce(stale);
    await expect(importWebsiteLink(importUrl)).rejects.toThrow('INVALID_SOURCE_CATALOG');
    expect(await catalog.get('catalogs', id)).toEqual(stale);
  });
});
