import {describe, expect, it, vi} from 'vitest';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {definition} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {describeWork} from '../page';
import {parseSearch, searchUrl} from '../search';
import {catalog, catalogData, imageUrl, origin, pages, readerData, readerUrl, searchHtml, title, workUrl} from './fixtures';

describe('BatCave adapter', () => {
  it('identifies works and reader links while keeping list pages out of catalog import', () => {
    expect(definition.identify(new URL(origin + '/watched/'))?.kind).toBe('other');
    expect(definition.identify(new URL(workUrl))).toMatchObject({kind: 'catalog', pageKey: 'batcave:101'});
    const bound = definition.identify(new URL(readerUrl + '#nodelane-batcave=test-comic'));
    expect(bound).toMatchObject({kind: 'reader', pageKey: 'batcave:101:chapter:501', catalog: {key: 'batcave:101', url: workUrl}});
    expect(definition.identify(new URL(readerUrl + '?page=2#top'))?.pageKey).toBe(bound?.pageKey);
    expect(definition.identify(new URL(readerUrl))?.catalog).toBeUndefined();
    for (const url of [workUrl.replace('batcave.biz', 'batcave.biz.evil.test'), workUrl.replace('https:', 'http:'),
      workUrl.replace('://', '://user:pass@'), workUrl.replace('.biz/', '.biz:444/')])
      expect(definition.identify(new URL(url))).toBeNull();
    for (const path of ['/reader/0/1', '/reader/101/501/2', '/reader/101/501#nodelane-batcave=%2f', '/101-.html'])
      expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
    expect(network.pageTransport).toEqual(['catalog', 'pages']);
  });
  it('uses the complete embedded list beyond the UI limit, preserving source ordering and broken issues', () => {
    const data = {...catalogData, chapters: Array.from({length: 45}, (_, n) =>
      ({id: 600 + n, posi: 45 - n, pages: 2, title: `Issue ${n}`, broken: false}))};
    const result = validateCatalog(parseCatalog(catalog(data), workUrl), [definition]);
    expect(result.entries).toHaveLength(45);
    expect(result.entries[0].remoteId).toBe('644');
    expect(result.groups[0].entryIds).toEqual(result.entries.map(e => e.id));
    const small = validateCatalog(parseCatalog(catalog(), workUrl), [definition]);
    expect(small.entries.map(e => e.remoteId)).toEqual(['501', '502', '503']);
    expect(small.entries[2]).toMatchObject({title: title + ' #Annual 2026', readable: false});
    expect(small.defaultEntryId).toBe(small.entries[0].id);
  });
  it('keeps annuals and specials in source reading order when positions repeat or have gaps', () => {
    const chapters = [
      {id: 900, posi: 8, title: 'Issue #2'},
      {id: 500, posi: 2, title: 'Issue #1'},
      {id: 350, posi: 1, title: '_Special'},
      {id: 100, posi: 1, title: '_Annual 2'},
      {id: 700, posi: 1, title: '_Annual 1'},
    ].map(row => ({...row, pages: 2, broken: false}));
    const result = validateCatalog(parseCatalog(catalog({...catalogData, chapters}), workUrl), [definition]);
    expect(result.entries.map(e => e.remoteId)).toEqual(['700', '100', '350', '500', '900']);
    expect(result.entries.map(e => e.title)).toEqual(['_Annual 1', '_Annual 2', '_Special', 'Issue #1', 'Issue #2']);
    expect(result.entries.map(e => e.order)).toEqual([0, 1, 2, 3, 4]);
    expect(result.groups[0].entryIds).toEqual(result.entries.map(e => e.id));
    expect(result.defaultEntryId).toBe(result.entries[0].id);
  });
  it('reads structured catalogs despite stale labels, optional metadata and duplicate rows', () => {
    const html = catalog().replace(`<h1>${title}</h1>`, '<h1>Old title</h1><h1>Other heading</h1>')
      .replace('Chapters (3)', 'Issues: 999').replace('rel="canonical"', 'rel="other"')
      .replace(/<div class="page__poster[\s\S]*?<\/div>/, '')
      .replace('"news_id":101', '"news_id":"101"').replace('"id":502', '"id":"502"')
      .replaceAll('"pages":2', '"pages":null').replaceAll('"broken":false,', '')
      .replace('"title":"Test Comic (2026-) #1"', '"title":"  Test Comic\\n(2026-) #1  "');
    const result = validateCatalog(parseCatalog(html, workUrl), [definition]);
    expect(result.title).toBe(title);
    expect(result.cover).toBeUndefined();
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toMatchObject({title: title + ' #1'});
    expect(result.entries[0].readable).toBeUndefined();
    const duplicate = parseCatalog(catalog({...catalogData, chapters: [catalogData.chapters[2], ...catalogData.chapters]}), workUrl);
    expect(duplicate.entries.map(e => [e.remoteId, e.order])).toEqual([['501', 0], ['502', 1], ['503', 2]]);
    expect(parseCatalog(catalog().replace('/uploads/posts/hd/101.webp', 'javascript:alert(1)'), workUrl).cover).toBeUndefined();
    expect(parseCatalog(catalog().replace('/uploads/posts/hd/101.webp', '/art/cover.avif'), workUrl).cover?.url).toBe(origin + '/art/cover.avif');
  });
  it('rejects malformed and wrong-owner catalogs without changing a previous snapshot', async () => {
    const previous = parseCatalog(catalog(), workUrl), original = structuredClone(previous);
    for (const mutate of [
      (s: string) => s.replace('"news_id":101', '"news_id":102'),
      (s: string) => s.replace('"id":502', '"id":-1'),
      (s: string) => s.replace('"chapters":[', '"chapters":null,"ignored":['),
      (s: string) => s.replace(workUrl, workUrl.replace('101-', '102-')),
      (s: string) => s.replace('};</script>', '</script>'),
    ]) await expect(network.catalog(workUrl, {previous, request: async () => mutate(catalog())})).rejects.toThrow();
    expect(previous).toEqual(original);
  });
  it('preserves slash-bearing work slugs in search, catalogs and reader bindings', () => {
    const slug = 'batman-/-superman-worlds-finest';
    const url = workUrl.replace('test-comic', slug);
    const result = validateCatalog(parseCatalog(catalog().replaceAll('test-comic', slug), url), [definition]);
    expect(result.entries[0].url).toBe(readerUrl + '#nodelane-batcave=' + slug);
    expect(definition.identify(new URL(result.entries[0].url))?.catalog?.url).toBe(url);
    const hits = parseSearch(searchHtml(1).replaceAll('1-test-1.html', '1-' + slug + '.html'), {siteId: 'batcave', query: 'Test'});
    expect(hits.items[0].catalogUrl).toBe(origin + '/1-' + slug + '.html');
  });
  it('honors the declared page count, preserves duplicate slots and renews signatures without changing content identity', () => {
    const result = validatePages(parsePages(pages(), readerUrl), definition.identify(new URL(readerUrl))!);
    expect(result).toMatchObject({direction: 'ltr', discoveryComplete: true, knownTotal: 2, title: title + ' #1'});
    expect(result.items.map(p => p.resource)).toEqual([{kind: 'http', url: imageUrl}, {kind: 'http', url: imageUrl}]);
    expect(result.items.map(p => p.id)).toEqual(['page-0', 'page-1']);
    const renewed = parsePages(pages().replaceAll('?s=fixture', '?s=renewed'), readerUrl);
    expect(renewed.items.map(p => p.contentKey)).toEqual(result.items.map(p => p.contentKey));
    expect(renewed.items[0].resource).not.toEqual(result.items[0].resource);
  });
  it('reads available images despite flags, string IDs/counts, changed headings and missing parent metadata', () => {
    const html = pages({...readerData, broken: true, rdr_ajax: true}).replace('"news_id":101', '"news_id":"101"')
      .replace('"chapter_id":501', '"chapter_id":"501"').replace('"pages":2', '"pages":"2"')
      .replace(/<h1[\s\S]*?<\/h1>/, '').replace(`"post_link":"${workUrl}",`, '')
      .replace('rel="canonical"', 'rel="other"').replaceAll('1-abcdef.jpg', 'page-one.avif');
    const result = parsePages(html, readerUrl);
    expect(result).toMatchObject({title, knownTotal: 2, discoveryComplete: true});
    expect(result.items[0].resource).toEqual({kind: 'http', url: imageUrl.replace('1-abcdef.jpg', 'page-one.avif')});
    expect(parsePages(pages() + pages(), readerUrl).items).toHaveLength(2);
    expect(parsePages(pages(), readerUrl + '#nodelane-batcave=old-slug').items).toHaveLength(2);
  });
  it('fails closed for incomplete, foreign, unsafe and malformed reader data', () => {
    for (const data of [
      {...readerData, pages: 4}, {...readerData, images: []}, {...readerData, pages: 0},
      {...readerData, chapter_id: 502},
      {...readerData, images: [imageUrl.replace('/101/501/', '/101/502/'), imageUrl]},
      {...readerData, images: ['javascript:alert(1)', imageUrl]},
      {...readerData, images: [imageUrl.replace('.biz/', '.biz.evil.test/'), imageUrl]},
    ]) expect(() => parsePages(pages(data), readerUrl)).toThrow();
    for (const html of ['<title>Just a moment...</title>', pages().replace('"news_id":101', '"news_id":102'),
      pages().replace('"pages":2', '"pages":10001'), pages().replace('window.__DATA__ = {', 'window.__DATA__ = (() => ({')])
      expect(() => parsePages(html, readerUrl)).toThrow();
  });
  it('fetches one document, strips local bindings and checks cancellation before and after requests', async () => {
    const request = vi.fn().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(pages()).mockResolvedValueOnce(pages());
    await network.catalog(workUrl, {request});
    await network.pages(readerUrl + '#nodelane-batcave=test-comic', {request});
    expect(await network.resolveCatalog(readerUrl, {request})).toBe(workUrl);
    await expect(network.resolveCatalog(readerUrl, {request: async () => pages({...readerData, post_link: workUrl.replace('101-', '102-')})})).rejects.toThrow();
    expect(request.mock.calls).toEqual([[workUrl], [readerUrl], [readerUrl]]);
    const controller = new AbortController(), cancelled = vi.fn(async () => {controller.abort(); return catalog();});
    await expect(network.catalog(workUrl, {request: cancelled, signal: controller.signal})).rejects.toThrow();
    await expect(network.pages(readerUrl, {request: cancelled, signal: controller.signal})).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('describes a reader through its verified parent link', async () => {
    const element = (href: string, textContent = '') => ({getAttribute: () => href, textContent});
    const document = {querySelectorAll: (selector: string) => selector === 'link[rel="canonical"]' ?
      [element(readerUrl)] : [element(workUrl, title)]} as unknown as Document;
    const context = {document, location: definition.identify(new URL(readerUrl))!, signal: new AbortController().signal};
    expect(await describeWork(context)).toEqual({status: 'ready', value: {title, catalogId: 'batcave:101', catalogUrl: workUrl}});
    expect(await describeWork({...context, location: definition.identify(new URL(origin + '/reader/102/501'))!})).toMatchObject({status: 'not-ready'});
    const repeated = {querySelectorAll: (selector: string) => selector === 'link[rel="canonical"]' ? [] :
      [element(workUrl, title), element(workUrl, title)]} as unknown as Document;
    expect(await describeWork({...context, document: repeated})).toMatchObject({status: 'ready', value: {catalogUrl: workUrl}});
  });
});

describe('BatCave name search', () => {
  const input = {siteId: 'batcave', query: 'Test'};
  it('reads bounded pages, lazy covers, terminal and empty results including the source ten-page cap', async () => {
    const request = vi.fn(async () => searchHtml());
    const first = await network.search(input, {request});
    expect(request).toHaveBeenCalledExactlyOnceWith(network.searchPage(input));
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toBe('page:2');
    expect(first.items[0]).toMatchObject({catalogId: 'batcave:1', cover: {url: origin + '/uploads/mini/100x150/a/1.webp'}});
    expect(parseSearch(searchHtml(11, 2), {...input, cursor: first.nextCursor})).toMatchObject({items: [{catalogId: 'batcave:11'}]});
    expect(parseSearch(searchHtml(780, 10), {...input, cursor: 'page:10'}).nextCursor).toBeUndefined();
    expect(parseSearch(searchHtml(0), input)).toEqual({items: []});
  });
  it('uses cards and next links despite changed query echo, counts, page sizes and optional artwork', () => {
    const html = searchHtml().replace('value="Test"', 'value="test"').replace('id="main-content"', 'id="content"')
      .replace(/<div class="message-info">.*?<\/div>/, '<div class="message-info">搜索结果</div>')
      .replaceAll('readed d-flex short', 'readed').replace('alt="Comic 1"', 'alt="Different"')
      .replaceAll('/2-test-2.html', '/1-test-1.html')
      .replace('/uploads/mini/100x150/a/1.webp', 'javascript:alert(1)');
    const result = parseSearch(html, input);
    expect(result.items).toHaveLength(9);
    expect(result.items[0].cover).toBeUndefined();
    expect(result.nextCursor).toBe('page:2');
    expect(parseSearch(searchHtml().replace('href="/search/', 'href="https://evil.test/search/'), input).nextCursor).toBeUndefined();
    expect(parseSearch(searchHtml().replaceAll('/2-test-2.html', 'https://evil.test/2.html'), input).items).toHaveLength(9);
    const empty = searchHtml(0).replace('Your query found 0 answers:', 'Nothing here');
    expect(parseSearch(empty, input)).toEqual({items: []});
    const extended = searchHtml(780, 10).replace('</main>', '<a href="/search/Test/page/11/">Next</a></main>');
    expect(parseSearch(extended, {...input, cursor: 'page:10'}).nextCursor).toBe('page:11');
  });
  it('rejects challenge pages, malformed input and truncated responses', () => {
    for (const html of ['<title>Just a moment...</title>', '<main>Please sign in</main>', searchHtml().replace('</main>', '')])
      expect(() => parseSearch(html, input)).toThrow();
    for (const bad of [{...input, query: ''}, {...input, query: 'a\n'}, {...input, siteId: 'other'},
      {...input, cursor: 'page:0'}, {...input, cursor: 'page:10000'}, {...input, cursor: 'https://evil.test'}, {...input, query: 'x'.repeat(257)}])
      expect(() => searchUrl(bad)).toThrow();
    expect(searchUrl({...input, query: 'One & 日本語'}).url).toBe(origin + '/search/One%20%26%20%E6%97%A5%E6%9C%AC%E8%AA%9E');
  });
  it('preserves search cancellation', async () => {
    const controller = new AbortController(), request = vi.fn(async () => {controller.abort(); return searchHtml();});
    await expect(network.search(input, {request, signal: controller.signal})).rejects.toThrow();
    await expect(network.search(input, {request, signal: controller.signal})).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
