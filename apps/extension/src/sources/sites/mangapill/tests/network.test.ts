import {afterEach, describe, expect, it, vi} from 'vitest';
import {catalogKey, chapterKey, definition, mangapillLocation, origin} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {coverUrl, imageUrl, readerWork} from '../html';
import {parseSearch, resolveQuickCatalog, searchUrl} from '../search';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {createSourceNetworkContext} from '../../../runtime/http';
import {readImportCatalog} from '../../../runtime/import';
import {bareUrl, boundReader, catalogHtml, chapterRows, chapterTitle, cover, image, modernImage, quickHtml, reader, readerHtml, searchHtml, title, url, work} from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('MangaPill URL and source boundaries', () => {
  it('binds slugged and bare routes to stable work and chapter IDs', () => {
    const loc = definition.identify(new URL(reader + '?from=web#page=2'))!;
    expect(loc).toMatchObject({kind: 'reader', pageKey: 'mangapill:42:chapter:10001000'});
    expect(loc.catalog).toBeUndefined();
    expect(definition.identify(new URL(boundReader))).toMatchObject({pageKey: loc.pageKey, catalog: {key: catalogKey(work), url}});
    expect(definition.identify(new URL(origin + '/chapters/42-10001000'))?.pageKey).toBe(loc.pageKey);
    expect(definition.identify(new URL(reader.replace('fixture-work-chapter-1', 'renamed-work')))?.pageKey).toBe(loc.pageKey);
    expect(definition.identify(new URL(bareUrl + '/old-slug'))?.catalog?.key).toBe(catalogKey(work));
    expect(definition.identify(new URL(url))?.kind).toBe('catalog');
    expect(definition.sites![0].primaryLanguages).toEqual(['en']);
    expect(definition.capabilities).toMatchObject({importable: true, catalog: true, pages: true, inline: true, completePageList: true});
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
    expect(definition.installation.optionalContentMatches).toEqual([origin + '/*']);
    expect(definition.sites![0].search).toBe(true);
  });
  it.each(['http://mangapill.com', 'https://mangapill.com.evil.test', 'https://mangapill.com:444', 'https://u:p@mangapill.com', 'ftp://mangapill.com', 'https://www.mangapill.com'])
    ('rejects unclaimed origin %s', host => expect(definition.identify(new URL(host + '/manga/42'))).toBeNull());
  it.each(['/manga/0', '/manga/042', '/manga/%34%32', '/manga/42/slug/extra', '/chapters/42-1/slug/extra', '/chapters/0-1', '/search?q=Fixture', '/manga/42/%2fextra'])
    ('does not expose unsupported route %s as importable', path => expect(definition.identify(new URL(origin + path))?.kind).toBe('other'));
  it('validates both observed image protocols and a dedicated work cover', () => {
    const loc = mangapillLocation(new URL(reader))!;
    expect(imageUrl(image, loc)).toBe(image); expect(imageUrl(modernImage, loc)).toBe(modernImage);
    expect(coverUrl(cover, work)).toEqual({url: cover});
    expect(coverUrl(cover.replace('.webp?h=', '.jpeg?h='), work)).toBeDefined();
    expect(coverUrl(cover.replace('.webp?h=', '.jpg?h='), work)).toBeDefined();
  });
  it.each(['owner', 'chapter', 'host', 'credentials', 'port', 'protocol', 'path', 'extension', 'query', 'fragment'])
    ('rejects %s image evidence before public image registration', mode => {
      let target = image;
      if (mode === 'owner') target = image.replace('/42/', '/43/');
      if (mode === 'chapter') target = image.replace('/10001000/', '/10002000/');
      if (mode === 'host') target = image.replace('.com/', '.com.evil.test/');
      if (mode === 'credentials') target = image.replace('https://', 'https://u:p@');
      if (mode === 'port') target = image.replace('.com/', '.com:444/');
      if (mode === 'protocol') target = image.replace('https:', 'http:');
      if (mode === 'path') target = image.replace('/file/mangap/', '/file/ads/');
      if (mode === 'extension') target = image.replace('.jpeg', '.html');
      if (mode === 'query') target += '&token=private';
      if (mode === 'fragment') target += '#fake';
      expect(() => imageUrl(target, mangapillLocation(new URL(reader))!)).toThrow();
    });
  it('does not use another work, a body page or a forged CDN as a cover', () => {
    for (const candidate of [cover.replace('/42.', '/43.'), image, cover.replace('.com/', '.com.evil.test/'),
      cover.replace('https://', 'https://u:p@'), cover + '&token=private', cover + '#fake'])
      expect(coverUrl(candidate, work)).toBeUndefined();
  });
});

describe('MangaPill complete HTTP acquisition', () => {
  it('reverses the source directory once, retains fractional labels and validates every group reference', () => {
    const result = validateCatalog(parseCatalog(catalogHtml(), url + '?from=web'), [definition]);
    expect(result).toMatchObject({id: 'mangapill:42', url, title, complete: true, cover: {url: cover}});
    expect(result.entries.map(entry => [entry.remoteId, entry.title, entry.order])).toEqual([
      ['42-10001000', 'Chapter 1', 0], ['42-10001500', 'Chapter 1.5', 1], ['42-10003000', 'Chapter 3', 2],
    ]);
    expect(result.defaultEntryId).toBe(chapterKey(mangapillLocation(new URL(reader))!));
    expect(result.groups.flatMap(group => group.entryIds)).toEqual(result.entries.map(entry => entry.id));
    for (const entry of result.entries) {
      expect(definition.identify(new URL(entry.url))?.pageKey).toBe(entry.id);
      expect(definition.identify(new URL(entry.url))?.catalog?.url).toBe(url);
      expect(entry.contentLanguage).toBeUndefined(); expect(entry.readingSlotId).toBeUndefined();
    }
    expect(parseCatalog(catalogHtml([]), url)).toMatchObject({complete: true, entries: []});
  });
  it('retains source chapter groups without splitting the observed reading chain', () => {
    const rows = chapterRows(); rows[0].title = 'Group 2 Chapter 3';
    const result = validateCatalog(parseCatalog(catalogHtml(rows), url), [definition]);
    expect(result.entries.at(-1)?.title).toBe('Group 2 Chapter 3');
    expect(result.groups).toHaveLength(2);
    expect(new Set(result.entries.map(entry => entry.sequenceId)).size).toBe(1);
    expect(result.groups.every(group => group.entryIds.every(id => result.entries.some(entry => entry.id === id && entry.groupIds.includes(group.id))))).toBe(true);
  });
  it('uses visible chapter labels when the source link title contains an alternate work name', () => {
    const html = catalogHtml().replace('title=" Chapter 3"', 'title="Alternate Work Name Chapter 3"');
    expect(parseCatalog(html, url).entries.at(-1)?.title).toBe('Chapter 3');
  });
  it.each(['duplicate', 'owner', 'foreign', 'list', 'closure', 'heading', 'cover-owner'])('rejects invalid %s directory evidence', mode => {
    let html = catalogHtml();
    if (mode === 'duplicate') html = catalogHtml([chapterRows()[0], chapterRows()[0]]);
    if (mode === 'owner') html = html.replace('/chapters/42-10001500', '/chapters/43-10001500');
    if (mode === 'foreign') html = html.replace('/chapters/42-10001500', 'https://evil.test/chapters/42-10001500');
    if (mode === 'list') html = html.replace('data-filter-list', 'data-unrelated-list');
    if (mode === 'closure') html = html.replace('</a>\n', '\n');
    if (mode === 'cover-owner') html = html.replaceAll('/i/42.webp', '/i/43.webp');
    if (mode === 'heading') html = html.replace(/<h1[^>]*>.*?<\/h1>/, '');
    expect(() => parseCatalog(html, url)).toThrow();
  });
  it('uses explicitly owned work metadata and does not execute source scripts', () => {
    const loc = mangapillLocation(new URL(reader))!;
    expect(readerWork(readerHtml() + '<script>throw Error("untrusted")</script>', loc)).toEqual({title, chapterTitle});
    expect(() => readerWork(readerHtml().replace('href="/manga/42"', 'href="/manga/43"'), loc)).toThrow();
    expect(() => readerWork(readerHtml().replace('current=10001000', 'current=10002000'), loc)).toThrow();
  });
  it('keeps repeated original URLs as ordered stable slots and proves completeness from all summaries', () => {
    const result = validatePages(parsePages(readerHtml(), reader), definition.identify(new URL(reader))!);
    expect(result).toMatchObject({title: chapterTitle, direction: 'ltr', discoveryComplete: true, knownTotal: 3});
    expect(result.items.map(page => page.order)).toEqual([0, 1, 2]);
    expect(new Set(result.items.map(page => page.id)).size).toBe(3);
    expect(result.items.map(page => page.resource)).toEqual(Array.from({length: 3}, () => ({kind: 'http', url: image})));
    const renamed = parsePages(readerHtml().replaceAll('fixture-work-chapter-1', 'new-slug'), reader.replace('fixture-work-chapter-1', 'new-slug'));
    expect(renamed.items.map(page => page.id)).toEqual(result.items.map(page => page.id));
    expect(parsePages(readerHtml([1, 2, 3], modernImage), reader).items.map(page => page.resource)).toEqual(Array.from({length: 3}, () => ({kind: 'http', url: modernImage})));
  });
  it.each(['missing', 'duplicate-slot', 'summary', 'alt', 'owner', 'current', 'total', 'dimensions', 'closure', 'empty'])
    ('rejects %s body evidence without publishing a falsely complete chapter', mode => {
      let html = readerHtml();
      if (mode === 'missing') html = readerHtml([1, 3]);
      if (mode === 'duplicate-slot') html = readerHtml([1, 1, 3]);
      if (mode === 'summary') html = html.replace('page 1/3', 'page 2/3');
      if (mode === 'alt') html = html.replace('Page 1"', 'Page 9"');
      if (mode === 'owner') html = html.replaceAll('/42/10001000/', '/43/10001000/');
      if (mode === 'current') html = html.replace('current=10001000', 'current=10003000');
      if (mode === 'total') html = html.replace('page 3/3', 'page 3/4');
      if (mode === 'dimensions') html = html.replace('width="1066"', 'width="-1"');
      if (mode === 'closure') html = html.replace('</chapter-page>', '');
      if (mode === 'empty') html = readerHtml([]);
      expect(() => parsePages(html, reader)).toThrow();
    });
  it('performs one bounded request per operation and honors cancellation before and after responses', async () => {
    const request = vi.fn(async (target: string) => target.includes('/chapters/') ? readerHtml() : catalogHtml());
    expect((await network.catalog!(url, {request})).entries).toHaveLength(3);
    expect((await network.pages!(reader, {request})).items).toHaveLength(3);
    expect(request.mock.calls.map(([target]) => target)).toEqual([url, reader]);
    for (const operation of ['catalog', 'pages', 'search'] as const) {
      const input = operation === 'catalog' ? url : operation === 'pages' ? reader : {siteId: 'mangapill', query: 'Fixture'};
      const call = network[operation] as (target: typeof input, context: {request: () => Promise<string>; signal: AbortSignal}) => Promise<unknown>;
      const already = new AbortController(), never = vi.fn(async () => readerHtml()); already.abort();
      await expect(call(input, {request: never, signal: already.signal})).rejects.toThrow(); expect(never).not.toHaveBeenCalled();
      const pending = new AbortController();
      await expect(call(input, {signal: pending.signal, request: async () => {pending.abort(); return readerHtml();}})).rejects.toThrow();
    }
  });
  it.each(['?from=web#page=2', '/?from=web#page=2'])
    ('retains the selected URL suffix %s for public validation while normalizing the HTTP request', async suffix => {
    const selected = reader + suffix, request = vi.fn(async () => readerHtml());
    const snapshot = await network.pages!(selected, {request});
    expect(validatePages(snapshot, definition.identify(new URL(selected))!).url).toBe(selected);
    expect(request).toHaveBeenCalledExactlyOnceWith(reader);
  });
  it('preserves the supplied previous catalog during successful updates, failed reads and cancellation', async () => {
    const previous = parseCatalog(catalogHtml(), url), before = structuredClone(previous);
    const changed = [...chapterRows()]; changed.unshift({id: '10004000', title: 'Chapter 4'});
    const next = await network.catalog!(url, {previous, request: async () => catalogHtml(changed)});
    expect(next.entries).toHaveLength(4); expect(previous).toEqual(before);
    await expect(network.catalog!(url, {previous, request: async () => 'Just a moment...'})).rejects.toThrow();
    const controller = new AbortController();
    await expect(network.catalog!(url, {previous, signal: controller.signal, request: async () => {controller.abort(); return catalogHtml();}})).rejects.toThrow();
    expect(previous).toEqual(before);
    expect((await network.catalog!(url, {previous, request: async () => catalogHtml()})).entries).toEqual(previous.entries);
  });
});

describe('MangaPill canonical parent resolution under the production HTTP transport', () => {
  const quick = new URL('/quick-search', origin); quick.searchParams.set('q', title);
  it('resolves the exact numeric work from the lightweight source fragment without choosing a title match', async () => {
    const html = quickHtml([{id: '43', slug: 'another-work', title}, {id: work, slug: 'fixture-work', title}]);
    expect(resolveQuickCatalog(html, work)).toBe(url);
    const request = vi.fn(async (target: string) => target === reader ? readerHtml() : html);
    expect(await network.resolveCatalog!(reader, {request})).toBe(url);
    expect(request.mock.calls.map(([target]) => target)).toEqual([reader, quick.href]);
    expect(request.mock.calls.every(([target]) => !target.includes('/file/') && !target.includes('/manga/'))).toBe(true);
  });
  it.each(['missing', 'duplicate', 'foreign', 'cover-owner', 'bare', 'query', 'truncated'])
    ('rejects %s quick results before selecting a parent', mode => {
      let html = quickHtml();
      if (mode === 'missing') html = quickHtml([{id: '43', slug: 'another-work', title}]);
      if (mode === 'duplicate') html = quickHtml([{id: work, slug: 'fixture-work'}, {id: work, slug: 'renamed-work'}]);
      if (mode === 'foreign') html = html.replace('/manga/42/fixture-work', 'https://evil.test/manga/42/fixture-work');
      if (mode === 'cover-owner') html = html.replace('/i/42.jpeg', '/i/43.jpeg');
      if (mode === 'bare') html = html.replace('/manga/42/fixture-work', '/manga/42');
      if (mode === 'query') html = html.replace('/manga/42/fixture-work', '/manga/42/fixture-work?token=private');
      if (mode === 'truncated') html = html.replace('</a>', '');
      expect(() => resolveQuickCatalog(html, work)).toThrow();
    });
  it('checks reader ownership and aborts between bounded requests or after the final response', async () => {
    const wrong = vi.fn(async () => readerHtml().replace('current=10001000', 'current=10002000'));
    await expect(network.resolveCatalog!(reader, {request: wrong})).rejects.toThrow(); expect(wrong).toHaveBeenCalledTimes(1);
    for (const abortAt of [0, 1, 2]) {
      const controller = new AbortController(); let calls = 0;
      if (abortAt === 0) controller.abort();
      const request = vi.fn(async (target: string) => {
        if (++calls === abortAt) controller.abort();
        return target === reader ? readerHtml() : quickHtml();
      });
      await expect(network.resolveCatalog!(reader, {request, signal: controller.signal})).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(abortAt);
    }
    await expect(network.resolveCatalog!(reader + '#nodelane-mangapill=other-work', {
      request: async target => target === reader ? readerHtml() : quickHtml(),
    })).rejects.toThrow();
  });
  it('rejects bare redirecting source routes before making any HTTP request', async () => {
    const request = vi.fn(async () => {throw TypeError('redirect blocked');});
    await expect(network.catalog!(bareUrl, {request})).rejects.toThrow('完整作品链接');
    await expect(network.pages!(origin + '/chapters/42-10001000', {request})).rejects.toThrow('完整章节链接');
    await expect(network.resolveCatalog!(origin + '/chapters/42-10001000', {request})).rejects.toThrow('完整章节链接');
    expect(request).not.toHaveBeenCalled();
  });
  it('completes public reader import and bound page reading with redirect:error and canonical URLs', async () => {
    vi.stubGlobal('chrome', undefined);
    const fetcher = vi.fn(async (target: string, options?: RequestInit) => {
      expect(options?.redirect).toBe('error');
      if (target === bareUrl || target === origin + '/chapters/42-10001000') throw TypeError('redirect blocked');
      const body = target === reader ? readerHtml() : target === quick.href ? quickHtml() : target === url ? catalogHtml() : undefined;
      if (body === undefined) throw Error('Unexpected source request: ' + target);
      return new Response(body, {status: 200, headers: {'content-type': 'text/html'}});
    });
    vi.stubGlobal('fetch', fetcher);
    // This guard makes a fabricated bare-route fixture fail just as the production fetch transport does.
    await expect(createSourceNetworkContext().request(bareUrl)).rejects.toThrow('redirect blocked'); fetcher.mockClear();
    const snapshot = await readImportCatalog(reader);
    expect(validateCatalog(snapshot, [definition])).toMatchObject({id: catalogKey(work), url, complete: true});
    expect(snapshot.entries[0].url).toBe(boundReader);
    expect(fetcher.mock.calls.map(([target]) => target)).toEqual([reader, quick.href, url]);
    expect(snapshot.entries.every(entry => definition.identify(new URL(entry.url))?.catalog?.url === url)).toBe(true);
    const pages = await network.pages!(snapshot.entries[0].url, createSourceNetworkContext());
    expect(validatePages(pages, definition.identify(new URL(boundReader))!)).toMatchObject({knownTotal: 3, discoveryComplete: true});
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(reader);
    expect(fetcher.mock.calls.every(([target]) => !target.includes('#nodelane-mangapill='))).toBe(true);
  });
  it('preserves canonical search hits through the real HTTP context', async () => {
    vi.stubGlobal('chrome', undefined);
    const request = {siteId: 'mangapill', query: 'Fixture'};
    const fetcher = vi.fn(async (_target: string, options?: RequestInit) => {
      expect(options?.redirect).toBe('error'); return new Response(searchHtml());
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await network.search!(request, createSourceNetworkContext());
    expect(result.items[0].catalogUrl).toBe(bareUrl + '/fixture-42');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('MangaPill name search', () => {
  const request = {siteId: 'mangapill', query: 'Fixture'};
  it('returns lightweight titles and source covers without guessing content languages', async () => {
    expect(new URL(searchUrl(request).url).searchParams.get('q')).toBe('Fixture');
    const result = parseSearch(searchHtml(), request); expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({catalogId: 'mangapill:42', catalogUrl: bareUrl + '/fixture-42', title: 'Fixture 42'});
    expect(result.items[0].contentLanguages).toBeUndefined(); expect(result.nextCursor).toBeUndefined();
    const fetch = vi.fn(async (_target: string) => searchHtml()); expect((await network.search!(request, {request: fetch})).items).toHaveLength(2);
    expect(fetch.mock.calls.map(([target]) => target)).toEqual([searchUrl(request).url]);
    expect(parseSearch(searchHtml('Fixture', []), request)).toEqual({items: []});
  });
  it('validates pagination, query echoes and cursor structure', () => {
    const ids = Array.from({length: 50}, (_, index) => String(42 + index));
    const first = parseSearch(searchHtml('Fixture', ids, 1, true), request); expect(first.nextCursor).toBeDefined();
    const next = {...request, cursor: first.nextCursor};
    expect(new URL(searchUrl(next).url).searchParams.get('page')).toBe('2');
    expect(parseSearch(searchHtml('Fixture', ['99'], 2), next).nextCursor).toBeUndefined();
    expect(() => parseSearch(searchHtml('Fixture', ['99'], 2), {...next, query: 'Other'})).toThrow();
    expect(() => searchUrl({...request, cursor: 'https://evil.test/search'})).toThrow();
    expect(() => searchUrl({...request, siteId: 'other'})).toThrow();
    expect(() => parseSearch(searchHtml('Fixture', ids, 1, true).replace('page=2', 'page=3'), request)).toThrow();
    expect(() => parseSearch(searchHtml('Fixture', ids, 1, true).replace('/search?q=Fixture', '/search?q=Other'), request)).toThrow();
    expect(() => parseSearch(searchHtml('Fixture', ids, 1, true).replace('/search?q=Fixture', 'https://evil.test/search?q=Fixture'), request)).toThrow();
  });
  it.each(['query', 'duplicate', 'owner', 'cover-owner', 'truncated', 'challenge', 'empty-evidence'])('rejects %s search responses', mode => {
    let html = searchHtml();
    if (mode === 'query') html = searchHtml('Other');
    if (mode === 'duplicate') html = searchHtml('Fixture', ['42', '42']);
    if (mode === 'owner') html = html.replaceAll('/manga/42/fixture-42', 'https://evil.test/manga/42/fixture-42');
    if (mode === 'cover-owner') html = html.replace('/i/42.jpeg', '/i/43.jpeg');
    if (mode === 'truncated') html = html.replace('</figure></a>', '</figure>');
    if (mode === 'challenge') html = 'Just a moment...';
    if (mode === 'empty-evidence') html = searchHtml('Fixture', []).replace('No results found', '');
    expect(() => parseSearch(html, request)).toThrow();
  });
});
