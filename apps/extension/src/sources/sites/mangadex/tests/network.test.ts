import {describe, expect, it, vi} from 'vitest';
import {catalogUrl, chapterUrl, definition} from '../definition';
import {feedUrl, imageBaseUrl, network, parseCatalog, parsePages} from '../network';
import {chapterData, contentLanguage} from '../protocol';
import {validateCatalog} from '../../../core/catalog';
import {aggregate, atHome, chapter, manga, mangaId, otherMangaId, requestFixture, uuid} from './fixtures';

const url = catalogUrl(mangaId), reader = chapterUrl(uuid(1), mangaId);
describe('MangaDex API source', () => {
  it('claims only HTTPS MangaDex title/chapter UUIDs and keeps chapter identity independent of language, page and parent binding', () => {
    expect(definition.identify(new URL(url + '/fixture-title'))?.catalog?.key).toBe('mangadex:' + mangaId);
    for (const link of [chapterUrl(uuid(1)), reader, chapterUrl(uuid(1)) + '/5'])
      expect(definition.identify(new URL(link))?.pageKey).toBe('mangadex:chapter:' + uuid(1));
    expect(definition.identify(new URL(reader))?.catalog?.url).toBe(url);
    for (const bad of [url.replace('https:', 'http:'), url.replace('.org', '.org.evil.test'), url.replace('.org', '.org:444'), url.replace('mangadex.org', 'u:p@mangadex.org'), url.replace('mangadex.org', 'api.mangadex.org')])
      expect(definition.identify(new URL(bad))).toBeNull();
    for (const bad of [url + '/slug/extra', url.replace(mangaId, 'invalid'), chapterUrl(uuid(1)) + '/0', chapterUrl(uuid(1)) + '#nodelane-mangadex=invalid'])
      expect(definition.identify(new URL(bad))?.kind).toBe('other');
    expect(definition.installation.requiredOrigins).toEqual([]);
    expect(definition.installation.autoContentMatches).toEqual([]);
    expect(definition.installation.optionalOrigins).toContain('https://*.mangadex.network/*');
    expect(definition.installation.optionalContentMatches).toEqual(['https://mangadex.org/*']);
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
  });

  it('retains independent releases in source order and source-proven cross-language reading slots with a dedicated cover', () => {
    const rows = [chapter(3, 'zh-hk'), chapter(2), chapter(1), chapter(4, 'en', '1.5'), chapter(5, 'en', '2')];
    const value = validateCatalog(parseCatalog(manga(), rows, aggregate(rows), mangaId), [definition]);
    expect(value.entries.map(entry => entry.remoteId)).toEqual([uuid(3), uuid(2), uuid(1), uuid(4), uuid(5)]);
    expect(value.entries.map(entry => entry.contentLanguage)).toEqual(['zh-HK', 'en', 'en', 'en', 'en']);
    expect(value.entries.map(entry => entry.order)).toEqual([0, 0, 0, 1, 2]);
    expect(value.entries[0].readingSlotId).toBe(value.entries[2].readingSlotId);
    expect(new Set(value.entries.map(entry => entry.sequenceId))).toEqual(new Set(['mangadex:' + mangaId + ':chapters']));
    for (const entry of value.entries) expect(entry.id).toBe(definition.identify(new URL(entry.url))?.pageKey);
    expect(value.entries[0].rawTypes).toEqual(['Fixture group']);
    expect(value.entries[0].title).toBe('Vol. 1 · Ch. 1 · Fixture chapter');
    expect(value.entries.every(entry => entry.readable)).toBe(true);
    expect(value.cover?.url).toBe(`https://uploads.mangadex.org/covers/${mangaId}/${uuid(901)}.jpg.512.jpg`);
    expect(value.defaultEntryId).toBe('mangadex:chapter:' + uuid(3));
    expect(parseCatalog(manga(), [chapter()], aggregate(), mangaId).defaultEntryId).toBe('mangadex:chapter:' + uuid(1));
    const sameLanguage = [chapter(1), chapter(2)];
    expect(parseCatalog(manga(), sameLanguage, aggregate(sameLanguage), mangaId).defaultEntryId).toBe('mangadex:chapter:' + uuid(1));
    expect(value.complete).toBe(true);
  });

  it('defaults to the first readable release while retaining unavailable candidates in their original slots', () => {
    const rows = [chapter(4, 'vi', '2'), chapter(3, 'zh-hk'), chapter(2), chapter(1)];
    rows[1].attributes.externalUrl = 'https://external.test/read';
    rows[2].attributes.isUnavailable = true;
    rows[3].attributes.pages = 0;
    const value = parseCatalog(manga(), rows, aggregate(rows), mangaId);
    expect(value.entries.map(entry => entry.remoteId)).toEqual([uuid(3), uuid(2), uuid(1), uuid(4)]);
    expect(value.entries.map(entry => entry.readable)).toEqual([false, false, false, true]);
    expect(value.entries.map(entry => entry.order)).toEqual([0, 0, 0, 1]);
    expect(value.entries.slice(0, 3).map(entry => entry.title)).toEqual(Array(3).fill('Vol. 1 · Ch. 1 · Fixture chapter'));
    expect(value.defaultEntryId).toBe('mangadex:chapter:' + uuid(4));
    const unavailable = rows.slice(1);
    expect(parseCatalog(manga(), unavailable, aggregate(unavailable), mangaId).defaultEntryId).toBeUndefined();
  });

  it('keeps unnumbered and unproven releases separate, preserves decimal/suffix labels, and never infers slots from titles', () => {
    const rows = [chapter(1, 'en', null), chapter(2, 'en', null), chapter(3, 'en', '1.5'), chapter(4, 'en', '1.25'), chapter(5, 'en', '1a'), chapter(6, 'en', '1')];
    const value = parseCatalog(manga(), rows, aggregate(rows), mangaId);
    expect(value.entries.map(entry => entry.remoteId)).toEqual([uuid(6), uuid(5), uuid(4), uuid(3), uuid(1), uuid(2)]);
    const unnamed = value.entries.slice(-2);
    expect(unnamed.map(entry => entry.readingSlotId)).toEqual([undefined, undefined]);
    expect(unnamed[0].sequenceId).not.toBe(unnamed[1].sequenceId);
    const unproven = parseCatalog(manga(), [chapter(1), chapter(2)], aggregate([]), mangaId);
    expect(unproven.entries.map(entry => entry.readingSlotId)).toEqual([undefined, undefined]);
    expect(unproven.entries[0].sequenceId).not.toBe(unproven.entries[1].sequenceId);
    expect(parseCatalog(manga(), [], {result: 'ok', volumes: []}, mangaId).entries).toEqual([]);
  });

  it('maps MangaDex language codes to their intended BCP 47 meaning', () => {
    expect(['es-la', 'pt-br', 'zh-hk', 'zh', 'ja-ro', 'ko-ro', 'en'].map(contentLanguage)).toEqual(['es-419', 'pt-BR', 'zh-HK', 'zh-Hans', 'ja-Latn', 'ko-Latn', 'en']);
    expect(() => contentLanguage('bad-language-tag')).toThrow();
    expect(parseCatalog(manga(), [chapter()], aggregate(), mangaId).entries[0].contentLanguage).toBe('en');
  });

  it.each(['duplicate', 'owner', 'manga-id', 'aggregate-owner', 'aggregate-duplicate', 'aggregate-chapter', 'aggregate-count', 'aggregate-volume-count', 'cover-path'])('rejects %s catalog before replacing stored data', mode => {
    const rows = [chapter()], metadata = manga(), summary = aggregate(rows);
    if (mode === 'duplicate') rows.push(chapter());
    if (mode === 'owner') rows[0].relationships[0].id = otherMangaId;
    if (mode === 'manga-id') metadata.data.id = otherMangaId;
    if (mode === 'aggregate-owner') summary.volumes['1'].chapters['1'].id = uuid(100);
    if (mode === 'aggregate-duplicate') {summary.volumes['1'].chapters['1'].others.push(uuid(1)); summary.volumes['1'].chapters['1'].count++; summary.volumes['1'].count++;}
    if (mode === 'aggregate-chapter') rows[0].attributes.chapter = '2';
    if (mode === 'aggregate-count') summary.volumes['1'].chapters['1'].count++;
    if (mode === 'aggregate-volume-count') summary.volumes['1'].count++;
    if (mode === 'cover-path') metadata.data.relationships[0].attributes.fileName = '../other.jpg';
    expect(() => parseCatalog(metadata, rows, summary, mangaId)).toThrow();
  });

  it('reads every feed page without filtering languages, external or empty releases; validates pagination and stable totals', async () => {
    const rows = Array.from({length: 103}, (_, i) => chapter(i + 1, i % 2 ? 'en' : 'vi', String(i + 1)));
    const request = vi.fn(requestFixture(rows));
    const value = await network.catalog(url, {request});
    expect(value.entries).toHaveLength(103);
    const feeds = request.mock.calls.map(([target]) => new URL(target)).filter(target => target.pathname.endsWith('/feed'));
    expect(feeds.map(target => target.searchParams.get('offset'))).toEqual(['0', '100']);
    for (const feed of feeds) {
      expect(feed.searchParams.get('includeUnavailable')).toBe('1');
      expect(feed.searchParams.getAll('contentRating[]')).toEqual(['safe', 'suggestive', 'erotica', 'pornographic']);
      for (const key of ['translatedLanguage[]', 'includeExternalUrl', 'includeEmptyPages']) expect(feed.searchParams.has(key)).toBe(false);
    }
    expect(feedUrl(mangaId, 100)).toBe(feeds[1].href);
    for (const mode of ['offset', 'total', 'missing', 'duplicate', 'limit']) {
      const original = requestFixture(rows);
      await expect(network.catalog(url, {request: async target => {
        const result = JSON.parse(await original(target));
        if (new URL(target).searchParams.get('offset') === '100') {
          if (mode === 'offset') result.offset = 0;
          if (mode === 'total') result.total++;
          if (mode === 'missing') result.data.pop();
          if (mode === 'duplicate') result.data[0] = rows[0];
          if (mode === 'limit') result.limit = 1;
        }
        return JSON.stringify(result);
      }})).rejects.toThrow();
    }
  });

  it('resolves a bare chapter by verified API ownership and rejects a conflicting local parent binding', async () => {
    expect(await network.resolveCatalog(chapterUrl(uuid(1)) + '/3', {request: requestFixture()})).toBe(url);
    await expect(network.resolveCatalog(chapterUrl(uuid(1), otherMangaId), {request: requestFixture()})).rejects.toThrow('不属于');
    await expect(network.pages(chapterUrl(uuid(2)), {request: requestFixture()})).rejects.toThrow();
  });

  it('uses original image order, keeps duplicate URLs in separate page slots and stable content identity across leased hosts', () => {
    const value = parsePages(atHome(['2-image.jpg', '2-image.jpg']), chapterData(chapter()), reader);
    expect(value.knownTotal).toBe(2);
    expect(value.items.map(item => [item.id, item.order])).toEqual([['page-0', 0], ['page-1', 1]]);
    expect(value.items[0].resource).toEqual(value.items[1].resource);
    const changed = parsePages(atHome(['2-image.jpg', '2-image.jpg'], 'https://other.mangadex.network'), chapterData(chapter()), reader);
    expect(value.items.map(item => item.contentKey)).toEqual(changed.items.map(item => item.contentKey));
    expect(value.items[0].resource).not.toEqual(changed.items[0].resource);
    expect(parsePages(atHome(), chapterData(chapter()), reader).items[1].resource).toEqual({kind: 'http', url: 'https://fixture.mangadex.network/data/0123456789abcdef0123456789abcdef/2-image.jpg'});
  });

  it.each(['https://mangadex.network', 'https://node.mangadex.network.evil.test', 'http://node.mangadex.network', 'https://user:pass@node.mangadex.network', 'https://node.mangadex.network:444', 'https://node.mangadex.network/path', 'https://node.mangadex.network?token=bad', 'https://example.test'])('rejects unauthorized lease base %s', base => {
    expect(() => imageBaseUrl(base)).toThrow();
  });
  it('accepts only declared image hosts and rejects incomplete, traversal or invalid image lists', () => {
    expect(imageBaseUrl('https://uploads.mangadex.org')).toBe('https://uploads.mangadex.org');
    for (const filenames of [[], ['one.png'], ['../one.png', 'two.png'], ['one.png?token=bad', 'two.png'], ['https://evil.test/one.png', 'two.png']])
      expect(() => parsePages(atHome(filenames), chapterData(chapter()), reader)).toThrow();
    const invalid = atHome(); invalid.chapter.hash = '../unknown';
    expect(() => parsePages(invalid, chapterData(chapter()), reader)).toThrow();
  });

  it.each(['external', 'unavailable', 'empty'])('keeps %s releases visible but reports their exact status before leasing images', async mode => {
    const row = chapter();
    if (mode === 'external') row.attributes.externalUrl = 'https://external.test/read';
    if (mode === 'unavailable') row.attributes.isUnavailable = true;
    if (mode === 'empty') row.attributes.pages = 0;
    const request = vi.fn(requestFixture([row]));
    const catalog = await network.catalog(url, {request});
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0].readable).toBe(false);
    expect(catalog.defaultEntryId).toBeUndefined();
    request.mockClear();
    await expect(network.pages(reader, {request})).rejects.toThrow(mode === 'external' ? '外部网站' : '暂不可用');
    expect(request.mock.calls).toHaveLength(1);
    expect(request.mock.calls[0][0]).toContain('/chapter/');
  });

  it('does not mutate previous catalog on failure and honors cancellation before and after every request', async () => {
    const previous = await network.catalog(url, {request: requestFixture()}), before = JSON.stringify(previous);
    await expect(network.catalog(url, {previous, request: async () => '{broken json'})).rejects.toThrow('JSON');
    expect(JSON.stringify(previous)).toBe(before);
    for (const operation of ['catalog', 'pages', 'resolveCatalog'] as const) {
      const controller = new AbortController(), request = vi.fn(requestFixture());
      controller.abort();
      await expect(network[operation](operation === 'catalog' ? url : reader, {request, signal: controller.signal})).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
      const pending = new AbortController();
      await expect(network[operation](operation === 'catalog' ? url : reader, {signal: pending.signal,
        request: async target => {pending.abort(); return requestFixture()(target);}})).rejects.toThrow();
    }
  });
});
