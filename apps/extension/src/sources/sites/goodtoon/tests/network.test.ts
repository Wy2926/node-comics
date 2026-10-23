import {describe, expect, it, vi} from 'vitest';
import {catalogKey, definition, mangaLocation, origin} from '../definition';
import {network, parsePages, prepareCatalog} from '../network';
import {parseSearch, searchRequest} from '../search';
import {chapters, detail, pages, readerUrl, searchHtml, workUrl} from './fixtures';

describe('GoodToon Korean raw source', () => {
  it('declares verified capabilities without claiming unknown mirrors', () => {
    expect(definition).toMatchObject({embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720}});
    expect(definition.sites![0]).toMatchObject({search: true, pricing: 'free', primaryLanguages: ['ko'], isRaw: true,
      contentTags: ['manhwa', 'webtoon'], adaptedOn: '2026-10-23'});
    expect(definition.identify(new URL(workUrl))).toMatchObject({kind: 'catalog', pageKey: catalogKey('gt-42')});
    for (const path of ['chapter-1/', '1%ea%b6%8c/chapter-1/', 'chapter-1/?style=list'])
      expect(definition.identify(new URL(workUrl + path))).toMatchObject({kind: 'reader', pageKey: catalogKey('gt-42') + ':chapter-1',
        catalog: {key: catalogKey('gt-42'), url: workUrl}});
    for (const base of [origin + '.evil.test', origin + ':444', origin.replace('https:', 'http:'), origin.replace('://', '://user@'),
      'https://www.goodtoon007.com', 'https://goodtoon008.com']) expect(definition.identify(new URL(base + '/'))).toBeNull();
  });
  it.each(['gt-0/', 'gt-42//', 'gt-42/2권/1/', 'gt-42/1%2f2/', 'gt-42/?style=list', 'gt-42/1/#x', 'gt-42/1/?style=list&style=list',
    'gt-42/1/?next=evil', 'gt-42/1/?style=paged', 'gt-42/%broken/'])('rejects ambiguous paths %s', path => {
    expect(mangaLocation(new URL(origin + '/manga/' + path))).toBeNull();
  });
  it('reuses the complete Madara AJAX list, oldest first, without transient badges', () => {
    const prepared = prepareCatalog(detail, workUrl), catalog = prepared.parse(chapters);
    expect(prepared.url).toBe(workUrl + 'ajax/chapters/');
    expect(catalog).toMatchObject({id: catalogKey('gt-42'), title: '테스트 작품', complete: true, sourceId: 'goodtoon'});
    expect(catalog.entries.map(e => [e.remoteId, e.title, e.order])).toEqual([['chapter-1', '1화', 0], ['2', '2화', 1]]);
    expect(catalog.defaultEntryId).toBe(catalog.entries[0].id);
  });
  it.each([
    (s: string) => s.replace('postid-42', 'postid-99'),
    (s: string) => s.replace('data-id="42"', 'data-id="99"'),
    (s: string) => s.replace('/gt-42/cover', '/gt-99/cover'),
    (s: string) => s.replace('class="summary-title"', 'class="changed"'),
    (s: string) => s.replace('rel="canonical"', 'rel="other"'),
    (s: string) => s.replace(`href="${workUrl}"`, `href="${workUrl}2/"`),
  ])('rejects invalid details before requesting the list', async mutate => {
    const request = vi.fn().mockResolvedValue(mutate(detail));
    await expect(network.catalog(workUrl, {request})).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    (s: string) => s.replace('no-volumn', 'has-volumn'),
    (s: string) => s.replace('gt-42/2/', 'gt-99/2/'),
    (s: string) => s + '<a href="?page=2">Next</a>',
    (s: string) => s + '<button>Load more</button>',
    (s: string) => s.replace('</ul>', '<li>Not loaded</li></ul>'),
    (s: string) => s.replace('</div>', ''),
  ])('does not label partial/mixed chapter lists complete', mutate => {
    expect(() => prepareCatalog(detail, workUrl).parse(mutate(chapters))).toThrow();
  });
  it('preserves duplicate image URLs as ordered slots and binds reader aliases', () => {
    const result = parsePages(pages, workUrl + '1%EA%B6%8C/chapter-1/');
    expect(result).toMatchObject({adapter: 'goodtoon', direction: 'ltr', knownTotal: 2, discoveryComplete: true});
    expect(result.items.map(p => p.id)).toEqual(['image-0', 'image-1']);
    expect(result.items[0].resource).toEqual(result.items[1].resource);
  });
  it('excludes only the verified final source ad, never a missing comic slot', () => {
    const ad = `<div class="gt-reader-ad"><a href="https://ad.test"><img src="${origin}/wp-content/uploads/ads/reader_bottom_123.gif" alt="ad"></a></div>`;
    expect(parsePages(pages.replace('</div>', ad + '</div>'), readerUrl).items).toHaveLength(2);
    for (const bad of [ad.replace('alt="ad"', 'alt="comic"'), ad.replace('reader_bottom_123.gif', 'page.jpg'),
      ad.replace('<img ', '<img id="image-2" '), ad + '<img id="image-3">', ad.replace(origin, 'https://foreign.test')])
      expect(() => parsePages(pages.replace('</div>', bad + '</div>'), readerUrl)).toThrow();
  });
  it.each([
    (s: string) => s.replace('postid-42', 'postid-9'),
    (s: string) => s.replace('value="chapter-1"', 'value="2"'),
    (s: string) => s.replace('image-1', 'image-2'),
    (s: string) => s.replace('https://images.test/gt-42/1/01.jpg', 'javascript:alert(1)'),
    (s: string) => s.replace('/gt-42/1/01.jpg', '/gt-99/1/01.jpg'),
    (s: string) => s.replace('gt-42/2/', 'gt-99/2/'),
    (s: string) => s.replace('id="chapter-heading">1화', 'id="chapter-heading">Wrong'),
    (s: string) => s.replace(' selected>', '>'),
    (s: string) => s.replace(' selected>1화', '>1화').replace('>2화</option>', ' selected>2화</option>'),
    (s: string) => s.replace('</div>', '<canvas></canvas></div>'),
    (s: string) => s.replace('</div>', '<img src="/ad.jpg"></div>'),
    (s: string) => s.replace('</div>', ''),
  ])('rejects changed reader identities, slots and unsupported content', mutate => {
    expect(() => parsePages(mutate(pages), readerUrl)).toThrow();
  });
  it('makes only one detail GET, one read-only chapter POST, and one reader GET', async () => {
    const request = vi.fn().mockResolvedValueOnce(detail).mockResolvedValueOnce(chapters).mockResolvedValueOnce(pages);
    await network.catalog(workUrl, {request}); await network.pages(workUrl + '1권/chapter-1/', {request});
    expect(request.mock.calls).toEqual([[workUrl, undefined], [workUrl + 'ajax/chapters/', {referer: workUrl, form: {}}], [readerUrl, undefined]]);
  });
  it('checks cancellation before and after each request and never mutates previous', async () => {
    const previous = prepareCatalog(detail, workUrl).parse(chapters), original = structuredClone(previous), controller = new AbortController();
    const request = vi.fn(async () => {controller.abort(); return detail;});
    await expect(network.catalog(workUrl, {request, previous, signal: controller.signal})).rejects.toThrow();
    await expect(network.pages(readerUrl, {request, signal: controller.signal})).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1); expect(previous).toEqual(original);
  });
});

describe('GoodToon bounded GET name search', () => {
  const input = {siteId: 'goodtoon', query: 'test'};
  it('returns light candidates, a terminal short page, and the verified empty grid', async () => {
    const request = vi.fn().mockResolvedValue(searchHtml());
    const result = await network.search(input, {request});
    expect(request).toHaveBeenCalledExactlyOnceWith(origin + '/?q=test', undefined);
    expect(result.items).toHaveLength(2); expect(result.nextCursor).toBeUndefined();
    expect(result.items[0]).toMatchObject({title: '테스트 1', catalogId: catalogKey('gt-1')});
    expect(parseSearch(searchHtml(0), input)).toEqual({items: []});
  });
  it('follows explicit query-bound pagination instead of downloading all works', () => {
    expect(parseSearch(searchHtml(63, 1, true), input).nextCursor).toBe('2');
    const next = {...input, cursor: '2'};
    expect(searchRequest(next).url).toBe(origin + '/?q=test&pg=2');
    expect(parseSearch(searchHtml(5, 2), next).nextCursor).toBeUndefined();
  });
  it.each(['0', '01', '-1', '1.5', '1001', 'https://evil.test', '2e1'])('rejects invalid cursor %s', cursor => {
    expect(() => searchRequest({...input, cursor})).toThrow();
  });
  it.each([
    (s: string) => s.replaceAll('q=test', 'q=other'),
    (s: string) => s.replace('href="/?q=test&pg=2"', 'href="https://evil.test/?q=test&pg=2"'),
    (s: string) => s.replace('pg=2', 'pg=3'),
    (s: string) => s.replace('page-numbers current', 'page-numbers'),
    (s: string) => s.replace('gt-2/', 'gt-1/'),
    (s: string) => s.replace('gt-1/cover', 'gt-99/cover'),
    (s: string) => s.replace('class="card"', 'class="unknown"'),
    (s: string) => s.replace('다음 &raquo;', 'Unknown'),
  ])('rejects stale, foreign, conflicting or partial results', mutate => {
    expect(() => parseSearch(mutate(searchHtml(63, 1, true)), input)).toThrow();
  });
  it('does not invent empty results or accept lost pagination', () => {
    for (const body of ['', '0', '<h1>Verify</h1>', searchHtml(63), searchHtml(2, 1, true), searchHtml(0, 2)])
      expect(() => parseSearch(body, input)).toThrow();
    expect(() => searchRequest({...input, siteId: 'other'})).toThrow();
    expect(() => searchRequest({...input, query: ' '.repeat(2)})).toThrow();
  });
});
