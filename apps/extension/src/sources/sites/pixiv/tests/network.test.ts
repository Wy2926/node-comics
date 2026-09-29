import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {artworkUrl, catalogKey, catalogUrl, definition, type PixivCollection} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {inlineImageSize, sourceFor, validateSourceCatalog} from '../../../index';
import {createSourceNavigation} from '../../../page';
import {readSourceCatalog} from '../../../runtime/catalog-reader';
import {importCatalog} from '../../../../comics/application/import-service';
import {applyCatalogRefresh} from '../../../../comics/application/catalog-service';
import {catalog, openCatalog, idbCompleted} from '../../../../comics/repositories';
import {detail, fixtureBody, pages, response, tag, user, work} from './fixtures';

const all = {userId: '7'}, tagged = {...all, tag}, url = catalogUrl(all), reader = artworkUrl(tagged, '101');
const context = (rows?: ReturnType<typeof work>[]) => ({request: vi.fn(async (target: string) => response(fixtureBody(target, rows)))});
afterEach(async () => {
  vi.unstubAllGlobals();
  const db = await openCatalog(), tx = db.transaction([...db.objectStoreNames], 'readwrite'), done = idbCompleted(tx);
  for (const name of db.objectStoreNames) tx.objectStore(name).clear();
  await done;
});
describe('Pixiv author and tag catalogs', () => {
  it('normalizes author links and keeps author/tag identities separate', () => {
    for (const target of [url, url + '/?p=3', url.replace('/users/', '/en/users/'), 'https://www.pixiv.net/users/7', 'https://www.pixiv.net/en/users/7/'])
      expect(sourceFor(target).location.catalog?.key).toBe('pixiv:user:7:all');
    expect(catalogKey(tagged)).toBe('pixiv:user:7:tag:%E4%BA%8C%E5%89%B5');
    expect(sourceFor(catalogUrl(tagged)).location.catalog?.key).not.toBe(catalogKey(all));
    expect(sourceFor(catalogUrl({...all, tag: 'a/b & +'})).location.catalog?.key).toBe(catalogKey({...all, tag: 'a/b & +'}));
    expect(sourceFor(reader).location.catalog?.url).toBe(catalogUrl(tagged));
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
    expect(definition.inlineRecognition).toBe('generic');
    for (const target of ['http://www.pixiv.net/users/7/artworks', url.replace('.net', '.net.evil.test'), url.replace('.net', '.net:444'),
      url.replace('www.', 'user:pass@www.'), url + '/%E0%A4', url + '?tag=two', url.replace('/7/', '/07/'),
      reader + '&tag=extra', reader.replace('nodelane-pixiv=7', 'nodelane-pixiv=07'), url.replace('/artworks', '/bookmarks/artworks'),
      reader + '&category=novels', reader + '&category=manga&category=illustrations', reader + '&series=9',
      'https://www.pixiv.net/user/7/series/09', 'https://www.pixiv.net/users/7/series/9'])
      expect(definition.identify(new URL(target))).toBeNull();
    expect(sourceFor('https://www.pixiv.net/artworks/101').definition.id).toBe('generic');
  });
  it.each(['illustrations', 'manga'] as const)('isolates %s imports, tags and chapter bindings', async category => {
    const collection = {...all, category}, ctx = context(), value = validateSourceCatalog(await network.catalog(catalogUrl(collection), ctx));
    expect(value.entries.map(e => e.remoteId)).toEqual(category === 'illustrations' ? ['101', '103'] : ['102']);
    expect(value.id).not.toBe(catalogKey(all)); expect(value.title).toContain(category === 'manga' ? '漫画' : '插画');
    expect(sourceFor(catalogUrl(collection).replace('/users/', '/en/users/') + '/?p=2').location.catalog?.key).toBe(value.id);
    for (const entry of value.entries) {
      expect(sourceFor(entry.url).location).toMatchObject({pageKey: entry.id, catalog: {key: value.id, url: value.url}});
      expect((await network.pages(entry.url, ctx)).knownTotal).toBe(3);
    }
    const scoped = await network.catalog(catalogUrl({...collection, tag}), ctx);
    expect(scoped.entries.map(e => e.remoteId)).toEqual(category === 'illustrations' ? ['101'] : ['102']);
    expect(ctx.request.mock.calls.some(([target]) => target.includes(`/${category === 'manga' ? 'manga' : 'illusts'}/tag?`))).toBe(true);
    const wrong = category === 'manga' ? 0 : 1;
    expect(() => parseCatalog(user, [work('101', {illustType: wrong})], collection)).toThrow();
    expect(() => parsePages(detail('101', {illustType: wrong}), pages(), artworkUrl(collection, '101'))).toThrow();
  });
  it('handles empty categories and does not request details from the other category', async () => {
    const ctx = context([work('101', {illustType: 1})]);
    const value = await network.catalog(catalogUrl({...all, category: 'illustrations'}), ctx);
    expect(value.entries).toEqual([]); expect(value.complete).toBe(true);
    expect(ctx.request.mock.calls.some(([target]) => target.includes('/profile/illusts?'))).toBe(false);
  });
  it('only requires tags for tag-filtered imports and identifies invalid required fields', () => {
    const row = work('101', {tags: undefined});
    expect(parseCatalog(user, [row], all).entries).toHaveLength(1);
    expect(() => parseCatalog(user, [row], tagged)).toThrow('作品标签');
    expect(() => parseCatalog(user, [{...row, userId: '8'}], all)).toThrow('作品作者归属');
    expect(() => parseCatalog(user, [{...row, pageCount: undefined}], all)).toThrow('作品页数');
  });
  it('imports complete series in source order and excludes recommendations', async () => {
    const collection = {...all, seriesId: '9'}, rows = Array.from({length: 14}, (_, i) => work(String(200 - i), {seriesId: '9', illustType: 1}));
    const ctx = context(rows), value = validateSourceCatalog(await network.catalog(catalogUrl(collection), ctx));
    expect(value.entries.map(e => e.remoteId)).toEqual(rows.map(row => row.id)); expect(value.title).toBe('Series fixture');
    expect(ctx.request).toHaveBeenCalledTimes(2); expect(value.id).not.toBe(catalogKey({...all, category: 'manga'}));
    const entry = value.entries[0]; expect(sourceFor(entry.url).location.catalog?.key).toBe(value.id);
    expect(sourceFor(value.url.replace('/user/', '/en/user/') + '?p=2').location.catalog?.key).toBe(value.id);
    expect((await network.pages(entry.url, ctx)).items).toHaveLength(3);
    for (const seriesNavData of [null, {seriesId: '10'}]) expect(parsePages(detail('200', {seriesNavData}), pages('200'), entry.url).items).toHaveLength(3);
  });
  it.each(['missing', 'duplicate', 'truncated', 'count'])('rejects %s in paginated series', async mode => {
    const collection = {...all, seriesId: '9'}, rows = Array.from({length: 14}, (_, i) => work(String(200 - i), {seriesId: '9'}));
    await expect(network.catalog(catalogUrl(collection), {request: async target => {
      if (mode === 'missing' && target.includes('/ajax/illust/')) return JSON.stringify({error: true});
      const body = fixtureBody(target, rows) as {page: {seriesId: number; total: number; series: {workId: string; order: number}[]};
        illustSeries: {userId: string; updateDate: string}[]; thumbnails: {illust: ReturnType<typeof work>[]}};
      if (target.endsWith('p=2')) {
        if (mode === 'missing') body.thumbnails.illust = [];
        if (mode === 'duplicate') body.page.series[1] = body.page.series[0];
        if (mode === 'truncated') body.page.series.pop();
        if (mode === 'count') body.page.total++;
      }
      return response(body);
    }})).rejects.toThrow();
  });
  it.each(['missing', 'missing-series', 'numeric-series', 'stale-series'])('imports %s summaries without redundant membership requests', async mode => {
    const collection = {...all, seriesId: '9'}, rows = [work('201', {seriesId: '9'}), work('200', {seriesId: '9'})];
    const request = vi.fn(async (target: string) => {
        const body = structuredClone(fixtureBody(target, rows));
        if ('thumbnails' in body && body.thumbnails) {
          if (mode === 'missing') body.thumbnails.illust = body.thumbnails.illust.filter(row => row.id !== '201');
          else {
            const summary = body.thumbnails.illust.find(row => row.id === '201')!;
            if (mode === 'missing-series') Reflect.deleteProperty(summary, 'seriesId');
            else Object.assign(summary, {seriesId: mode === 'numeric-series' ? 9 : '10'});
          }
        }
        if ('seriesNavData' in body) {
          Reflect.deleteProperty(body, 'tags');
          Reflect.deleteProperty(body, 'seriesNavData');
        }
        return response(body);
    });
    const snapshot = validateSourceCatalog(await network.catalog(catalogUrl(collection), {request}));
    expect(request).toHaveBeenCalledTimes(mode === 'missing' ? 2 : 1);
    expect(snapshot.entries.map(row => row.remoteId)).toEqual(['201', '200']);
    const comic = await importCatalog(snapshot);
    expect((await catalog.get('comics', comic.id))?.sourceUrl).toBe(catalogUrl(collection));
    expect((await catalog.listEntries(comic.id)).map(row => row.sourceEntryId)).toEqual(snapshot.entries.map(row => row.id));
  });
  it('keeps all, category, tag and series updates independent while the home URL reuses the original book', async () => {
    const collections: PixivCollection[] = [all, {...all, category: 'illustrations'}, {...all, category: 'manga'}, tagged, {...all, seriesId: '9'}];
    const initial = await Promise.all(collections.map(async collection => importCatalog(await network.catalog(catalogUrl(collection), context()))));
    expect(new Set(initial.map(comic => comic.id)).size).toBe(5);
    expect((await importCatalog(await network.catalog('https://www.pixiv.net/users/7', context()))).id).toBe(initial[0].id);
    const rows = [work('101', {seriesId: '9'}), work('102', {illustType: 1, seriesId: '9'}), work('103', {tags: ['other']}), work('104', {illustType: 1, seriesId: '9'})];
    for (let i = 0; i < collections.length; i++) {
      const comic = (await catalog.get('comics', initial[i].id))!, updated = await network.catalog(catalogUrl(collections[i]), context(rows));
      await applyCatalogRefresh(comic.id, comic.source.generation, updated); await applyCatalogRefresh(comic.id, comic.source.generation, updated);
      const entries = await catalog.list('entries', {index: 'comicId', range: comic.id});
      expect(entries).toHaveLength([4, 2, 2, 3, 3][i]);
      expect((await catalog.get('comics', comic.id))?.catalogUpdates?.count ?? 0).toBe(i === 1 ? 0 : 1);
    }
  });
  it('reads all illustration and manga batches, ignoring API object order', async () => {
    const rows = Array.from({length: 51}, (_, n) => work(String(101 + n), {illustType: n % 2})), ctx = context(rows);
    const value = validateSourceCatalog(await network.catalog(url, ctx));
    expect(value.entries).toHaveLength(51); expect(value.entries.map(e => e.remoteId)).toEqual(rows.map(row => row.id));
    expect(value.cover).toBeUndefined(); expect(value.groups[0].entryIds).toEqual(value.entries.map(e => e.id));
    expect(ctx.request.mock.calls.filter(([target]) => target.includes('/profile/illusts?'))).toHaveLength(2);
    expect(ctx.request.mock.calls.filter(([target]) => target.includes('/profile/all'))).toHaveLength(1);
    for (const entry of value.entries) expect(sourceFor(entry.url).location).toMatchObject({pageKey: entry.id, catalog: {key: value.id}});
  });
  it('uses the combined tagged endpoint through every page and keeps stable overlapping entries', async () => {
    const rows = Array.from({length: 51}, (_, n) => work(String(101 + n), {illustType: n % 2}));
    const ctx = context([...rows, work('900', {tags: ['other']})]);
    const value = validateSourceCatalog(await network.catalog(catalogUrl(tagged), ctx));
    expect(value.entries).toHaveLength(51); expect(value.title).toBe(user.name + ' · ' + tag);
    expect(ctx.request.mock.calls.filter(([target]) => target.includes('/illustmanga/tag?'))).toHaveLength(2);
    expect(ctx.request.mock.calls.every(([target]) => !target.includes('/illusts/tag'))).toBe(true);
    const empty = await network.catalog(catalogUrl({...all, tag: 'missing'}), ctx);
    expect(empty.entries).toEqual([]); expect(empty.complete).toBe(true);
  });
  it.each(['missing', 'owner', 'duplicate', 'tag', 'total', 'error', 'json'])('rejects %s instead of returning a partial directory', async mode => {
    const rows = Array.from({length: 50}, (_, n) => work(String(101 + n)));
    await expect(network.catalog(mode === 'missing' ? url : catalogUrl(tagged), {request: async target => {
      if (mode === 'json') return '<html>login</html>';
      if (mode === 'error') return JSON.stringify({error: true, body: []});
      let body = fixtureBody(target, rows);
      if (target.includes('/profile/illusts') && mode === 'missing') body = {works: {}};
      if (target.includes('/illustmanga/tag') && target.includes('offset=48')) {
        if (mode === 'owner') body = {total: 50, works: [work('102', {userId: '8'}), work()]};
        if (mode === 'duplicate') body = {total: 50, works: [work('150'), work()]};
        if (mode === 'tag') body = {total: 50, works: [work('102', {tags: ['other']}), work()]};
        if (mode === 'total') body = {total: 51, works: [work('102'), work()]};
      }
      return response(body);
    }})).rejects.toThrow();
  });
  it('preserves unavailable/animation entries and reports page failures without substituting previews', () => {
    const value = parseCatalog(user, [work('101', {illustType: 2}), work('102', {isMasked: true}), work('103')], all);
    expect(value.entries.map(e => e.readable)).toEqual([false, false, true]); expect(value.defaultEntryId).toBe(value.entries[2].id);
    expect(() => parsePages(detail('101', {illustType: 2}), pages(), reader)).toThrow('动画');
  });
  it('reads each original page in order and validates the owner, tag, count and image identity', async () => {
    const value = await network.pages(reader, context());
    expect(value.knownTotal).toBe(3); expect(value.items.map(p => p.id)).toEqual(['page-0', 'page-1', 'page-2']);
    expect(value.discoveryComplete).toBe(true);
    for (const d of [detail('102'), detail('101', {userId: '8'}), detail('101', {tags: {tags: [{tag: 'other'}]}}), detail('101', {pageCount: 4}), detail('101', {illustType: null})])
      expect(() => parsePages(d, pages(), reader)).toThrow();
    const mutations: Array<(p: ReturnType<typeof pages>) => ReturnType<typeof pages>> = [p => p.reverse(), p => {p[1] = p[0]; return p;},
      p => {p[0].urls.original = p[0].urls.original.replace('i.pximg.net', 'i.pximg.net.evil.test'); return p;},
      p => {p[0].urls.original = p[0].urls.original.replace('img-original', 'img-master'); return p;}];
    for (const mutate of mutations)
      expect(() => parsePages(detail(), mutate(pages()), reader)).toThrow();
  });
  it('honors cancellation before and after a request', async () => {
    const abort = new AbortController(), ctx = context(); abort.abort();
    await expect(network.catalog(url, {...ctx, signal: abort.signal})).rejects.toThrow(); expect(ctx.request).not.toHaveBeenCalled();
    const active = new AbortController();
    await expect(network.pages(reader, {signal: active.signal, request: async () => {active.abort(); return response(detail());}})).rejects.toThrow();
  });
  it('uses generic rendered-image recognition even for catalog-bound artwork navigation', async () => {
    vi.stubGlobal('getComputedStyle', () => ({visibility: 'visible', opacity: '1'}));
    const image = {src: pages()[0].urls.original, currentSrc: '', complete: true, naturalWidth: 800, naturalHeight: 1200,
      checkVisibility: () => true, getBoundingClientRect: () => ({width: 400, height: 600})};
    const doc = {title: 'Artwork', querySelectorAll: () => [image]} as unknown as Document, navigation = createSourceNavigation(doc);
    const first = navigation.get('https://www.pixiv.net/artworks/101');
    expect(first.location.sourceId).toBe('generic'); expect(first.session.inlineTargets()).toHaveLength(1);
    const bound = navigation.get(reader); expect(bound.session.inlineTargets()).toHaveLength(1);
    expect(bound.session.snapshot().adapter).toBe('pixiv'); expect((await bound.session.discoverPages!()).status).toBe('unsupported');
    expect(inlineImageSize(10, 10, reader)).toBe(false);
    expect(() => first.session.snapshot()).toThrow(); navigation.dispose(); expect(() => bound.session.inlineTargets()).toThrow();
  });
  it('deduplicates imports per scope, refreshes idempotently and preserves the old directory on failure', async () => {
    const original = await network.catalog(url, context()), filtered = await network.catalog(catalogUrl(tagged), context());
    const imported = await importCatalog(original), repeat = await importCatalog(original), separate = await importCatalog(filtered);
    expect(repeat.id).toBe(imported.id); expect(separate.id).not.toBe(imported.id);
    const before = await catalog.list('entries', {index: 'comicId', range: imported.id});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(response({works: []}))));
    await expect(readSourceCatalog(url)).rejects.toThrow(); expect(await catalog.list('entries', {index: 'comicId', range: imported.id})).toEqual(before);
    const comic = (await catalog.get('comics', imported.id))!, updated = await network.catalog(url, context([work(), work('102'), work('103'), work('104')]));
    await applyCatalogRefresh(imported.id, comic.source.generation, updated); await applyCatalogRefresh(imported.id, comic.source.generation, updated);
    expect(await catalog.list('entries', {index: 'comicId', range: imported.id})).toHaveLength(4);
    expect((await catalog.get('comics', imported.id))?.catalogUpdates?.count).toBe(1);
    expect(await catalog.list('entries', {index: 'comicId', range: separate.id})).toHaveLength(2);
  });
});
