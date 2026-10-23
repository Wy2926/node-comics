import {describe, expect, it, vi} from 'vitest';
import {catalogHtml, fixtureSite, minimalReaderHtml, searchHtml, workDocument} from '../../../shared/mangathemesia/tests/fixtures';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, definition, location, origin} from '../definition';
import {network, parseCatalog, parsePages, searchUrl} from '../network';
import {describeWork} from '../page';

const url = catalogUrl('sample'), chapter = 'independent-release-chapter-1', reader = chapterUrl(chapter);
const fixture = {...fixtureSite('kingofshojo'), origin, location, catalogKey, catalogUrl, chapterKey, chapterUrl,
  searchUrl: (query: string, page: number) => searchUrl({siteId: 'kingofshojo', query, ...(page > 1 ? {cursor: 'page:' + page} : {})})};
const pages = () => minimalReaderHtml(fixture).replaceAll('sample-chapter-1', chapter);

describe('King of Shojo integration', () => {
  it('binds verified metadata, injection scope and stable work/chapter identities', () => {
    expect(definition).toMatchObject({embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
      capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true}});
    expect(definition.installation).toEqual({autoContentMatches: [], optionalContentMatches: [origin + '/*']});
    expect(definition.sites![0]).toMatchObject({search: true, pricing: 'free', primaryLanguages: ['en'], isRaw: false, adaptedOn: '2026-10-23'});
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog', pageKey: catalogKey('sample')});
    expect(definition.identify(new URL(reader))).toMatchObject({kind: 'reader', pageKey: chapterKey(chapter)});
    expect(definition.identify(new URL(reader))?.catalog).toBeUndefined();
    expect(definition.identify(new URL(chapterUrl(chapter, 'sample')))).toMatchObject({
      pageKey: chapterKey(chapter), catalog: {key: catalogKey('sample'), url}});
    expect(location(new URL(chapterUrl('sample-chapter-2.5', 'sample')))).toEqual({chapterSlug: 'sample-chapter-2.5', catalogSlug: 'sample'});
    for (const host of [origin.replace('https:', 'http:'), origin + '.evil.test', origin + ':444', origin.replace('://', '://user:pass@')])
      expect(definition.identify(new URL(host + '/manga/sample/'))).toBeNull();
    for (const path of ['/manga/a%2Fb/', '/manga/a%252Fb/', '/manga/sample/extra/', '/manga/sample/?x=1', '/manga/sample/#x',
      '/' + chapter + '/?x=1', '/' + chapter + '/#nodelane-kingofshojo=other&x=1', '/' + chapter + '/#nodelane-other=sample'])
      expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
  });

  it('wires one GET per operation and preserves bound ownership and source order', async () => {
    const html = catalogHtml(fixture, ['independent-release-chapter-2', chapter]);
    const request = vi.fn().mockResolvedValueOnce(pages()).mockResolvedValueOnce(html).mockResolvedValueOnce(pages());
    expect(await network.resolveCatalog(reader, {request})).toBe(url);
    const catalog = await network.catalog(url, {request});
    expect(catalog.entries.map(e => e.id)).toEqual([chapterKey(chapter), chapterKey('independent-release-chapter-2')]);
    const result = await network.pages(chapterUrl(chapter, 'sample'), {request});
    expect(result).toMatchObject({adapter: 'kingofshojo', direction: 'ltr', discoveryComplete: true, knownTotal: 2});
    expect(result.items.map(item => item.id)).toEqual(['page-0', 'page-1']);
    expect(request.mock.calls).toEqual([[reader], [url], [reader]]);
    expect(() => parsePages(pages(), chapterUrl(chapter, 'wrong-owner'))).toThrow();
    expect(() => parseCatalog(html.replace(reader, 'https://other.invalid/chapter-1/'), url)).toThrow();
    const input = {siteId: 'kingofshojo', query: 'a & 日本語'};
    request.mockClear().mockResolvedValue(searchHtml(fixture, 1, 1, true, input.query));
    expect((await network.search(input, {request})).nextCursor).toBe('page:2');
    expect(request).toHaveBeenCalledExactlyOnceWith(origin + '/?s=a+%26+%E6%97%A5%E6%9C%AC%E8%AA%9E');
    expect(searchUrl({...input, cursor: 'page:2'})).toBe(origin + '/page/2/?s=a+%26+%E6%97%A5%E6%9C%AC%E8%AA%9E');
  });

  it('reads work titles from current catalog and bare chapter documents', () => {
    for (const current of [url, reader]) {
      const {document} = workDocument(current, 'Sample & Book', current === reader ? url : undefined);
      expect(describeWork({document, location: definition.identify(new URL(current))!, signal: new AbortController().signal}))
        .toEqual({status: 'ready', value: {title: 'Sample & Book', catalogId: catalogKey('sample'), catalogUrl: url}});
    }
  });
});
