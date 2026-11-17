import {describe, expect, it, vi} from 'vitest';
import {catalogKey, definition, mangaLocation, origin} from '../definition';
import {network, preparePages, prepareCatalog} from '../network';
import {parseSearch, searchRequest} from '../search';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {validateSearchPage} from '../../../core/search';
import {chapters, detail, pages, nav, navigation, apiPages, readerUrl, searchHtml, workUrl} from './fixtures';

const parsePages = (content: string, url: string) => preparePages(apiPages(content), url).parse(navigation);
const readerApi = origin + '/wp-admin/admin-ajax.php?postID=42&chapter=chapter-1&manga-paged=1&style=list&action=chapter_navigate_page';
const navForm = {action: 'manga_get_reading_nav', manga: '42', chapter: 'chapter-1', volume_id: '0', style: 'list', type: 'manga'};

describe('GoodToon Korean raw source', () => {
  it('recognizes numbered migrations while rejecting foreign hosts and unsafe origins', () => {
    expect(definition.identify(new URL(workUrl))).toMatchObject({kind: 'catalog', pageKey: catalogKey('gt-42')});
    for (const path of ['chapter-1/', '1%ea%b6%8c/chapter-1/', 'chapter-1/?style=list'])
      expect(definition.identify(new URL(workUrl + path))).toMatchObject({kind: 'reader', pageKey: catalogKey('gt-42') + ':chapter-1',
        catalog: {key: catalogKey('gt-42'), url: workUrl}});
    for (const base of [origin + '.evil.test', origin + ':444', origin.replace('https:', 'http:'), origin.replace('://', '://user@'),
      'https://www.goodtoonabc.com', 'https://www.goodtoon012.net', 'https://goodtoon008.com'])
      expect(definition.identify(new URL(base + '/'))).toBeNull();
    for (const base of ['https://www.goodtoon007.com', 'https://www.goodtoon012.com', 'https://www.goodtoon1000.com']) {
      const url = workUrl.replace(origin, base);
      expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog', pageKey: catalogKey('gt-42'),
        catalog: {key: catalogKey('gt-42'), url}});
    }
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
    expect(result).toMatchObject({adapter: 'goodtoon', title: '1화', direction: 'ltr', knownTotal: 2, discoveryComplete: true});
    expect(result.items.map(p => p.id)).toEqual(['image-0', 'image-1']);
    expect(result.items[0].resource).toEqual(result.items[1].resource);
  });
  it('excludes only verified edge ads, including the API’s old-domain assets', () => {
    const top = '<div class="gt-reader-ad"><img src="https://www.goodtoon001.com/wp-content/uploads/ads/reader_top_123.gif" alt="ad"></div>';
    const bottom = top.replace('reader_top_', 'reader_bottom_');
    const html = pages.replace('<img id="image-0"', top + '<img id="image-0"').replace(/<\/div>$/, bottom + '</div>');
    expect(parsePages(html, readerUrl).items).toHaveLength(2);
    for (const invalid of [
      html.replace(top, top + top),
      pages.replace('<img id="image-1"', top + '<img id="image-1"'),
      html.replace('alt="ad"', 'alt="comic"'),
      html.replace('reader_bottom_123.gif', 'page.jpg'),
      html.replace('<img src=', '<img id="image-2" src='),
      html.replace(bottom, bottom + '<img id="image-3">'),
      html.replace('www.goodtoon001.com', 'foreign.test'),
      html.replace(top, top.replace('reader_top_', 'reader_bottom_')),
    ]) expect(() => parsePages(invalid, readerUrl)).toThrow();
  });
  it.each([
    (s: string) => s.replace('data-id="123"', 'data-id="invalid"'),
    (s: string) => s.replace('value="chapter-1"', 'value="2"'),
    (s: string) => s.replace('image-1', 'image-2'),
    (s: string) => s.replace('https://images.test/gt-42/1/01.jpg', 'javascript:alert(1)'),
    (s: string) => s.replace('/gt-42/1/01.jpg', '/gt-99/1/01.jpg'),
    (s: string) => s.replace('</div>', '<canvas></canvas></div>'),
    (s: string) => s.replace('</div>', '<img src="/ad.jpg"></div>'),
    (s: string) => s.replace('</div>', ''),
  ])('rejects changed reader identities, slots and unsupported content', mutate => {
    expect(() => parsePages(mutate(pages), readerUrl)).toThrow();
  });
  it.each([origin, 'https://www.goodtoon012.com'])('uses %s for follow-up APIs and images while preserving identities', async next => {
    const moved = (html: string) => html.replaceAll(origin, next).replaceAll('https://images.test', '');
    const nextWork = workUrl.replace(origin, next), nextReader = readerUrl.replace(origin, next);
    const request = vi.fn().mockResolvedValueOnce(moved(detail)).mockResolvedValueOnce(moved(chapters))
      .mockResolvedValueOnce(apiPages(moved(pages), moved(nav))).mockResolvedValueOnce(moved(navigation));
    const catalog = validateCatalog(await network.catalog(workUrl, {request}), [definition]);
    const original = prepareCatalog(detail, workUrl).parse(chapters);
    expect(catalog.id).toBe(original.id);
    expect(catalog.entries.map(entry => entry.id)).toEqual(original.entries.map(entry => entry.id));
    expect(catalog.url).toBe(nextWork); expect(catalog.entries[0].url).toBe(nextReader);
    expect(catalog.cover?.url).toBe(next + '/gt-42/cover.jpg?v=123');
    const snapshot = validatePages(await network.pages(readerUrl, {request}), definition.identify(new URL(readerUrl))!);
    expect(snapshot.url).toBe(readerUrl);
    expect(snapshot.items[0].resource).toEqual({kind: 'http', url: next + '/gt-42/1/01.jpg'});
    expect(request.mock.calls).toEqual([[workUrl, undefined], [nextWork + 'ajax/chapters/', {referer: nextWork, form: {}}],
      [readerApi, undefined], [next + '/wp-admin/admin-ajax.php', {referer: nextReader, form: navForm}]]);
    request.mockResolvedValueOnce(apiPages(moved(pages), moved(nav))).mockResolvedValueOnce(moved(navigation));
    await network.pages(nextReader, {request});
    expect(request.mock.calls.at(-2)).toEqual([readerApi.replace(origin, next), undefined]);
  });
  it('keeps simultaneous migrations request-local and rejects unrelated canonical destinations', () => {
    const next = 'https://www.goodtoon012.com', later = 'https://www.goodtoon013.com';
    const first = prepareCatalog(detail.replaceAll(origin, next), workUrl);
    const second = prepareCatalog(detail.replaceAll(origin, later), workUrl);
    expect(second.parse(chapters.replaceAll(origin, later)).url).toBe(workUrl.replace(origin, later));
    expect(first.parse(chapters.replaceAll(origin, next)).url).toBe(workUrl.replace(origin, next));
    for (const canonical of [workUrl.replace(origin, origin + '.evil.test'), workUrl.replace('gt-42', 'gt-99'), readerUrl])
      expect(() => prepareCatalog(detail.replace(`href="${workUrl}"`, `href="${canonical}"`), workUrl)).toThrow();
    expect(() => preparePages(apiPages(pages, nav.replace(readerUrl, workUrl + '2/')), readerUrl)).toThrow();
  });
  it('checks cancellation before and after each request and never mutates previous', async () => {
    const previous = prepareCatalog(detail, workUrl).parse(chapters), original = structuredClone(previous), controller = new AbortController();
    const request = vi.fn(async () => {controller.abort(); return detail;});
    await expect(network.catalog(workUrl, {request, previous, signal: controller.signal})).rejects.toThrow();
    await expect(network.pages(readerUrl, {request, signal: controller.signal})).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1); expect(previous).toEqual(original);
  });
});

describe('GoodToon chapter API validation', () => {
  it.each(['', '0', 'null', '{}', '{"success":false}', '{"success":true,"data":{"data":{"content":[],"nav":""}}}'])
    ('rejects invalid JSON/envelopes before requesting navigation: %s', async response => {
      const request = vi.fn().mockResolvedValue(response);
      await expect(network.pages(readerUrl, {request})).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    });
  it.each([
    (s: string) => s.replace('data-manga="42"', 'data-manga="99"'),
    (s: string) => s.replace('data-chapter="chapter-1"', 'data-chapter="2"'),
    (s: string) => s.replace('data-style="list"', 'data-style="paged"'),
    (s: string) => s.replace('data-type="manga"', 'data-type="text"'),
    (s: string) => s.replace('?style=list', ''),
    (s: string) => s.replace(' selected="selected"', ''),
    (s: string) => s.replace(origin, origin + '.evil.test'),
  ])('rejects mismatched works, chapters and single-page mode', mutate => {
    expect(() => preparePages(apiPages(pages, mutate(nav)), readerUrl)).toThrow();
  });
  it.each([
    (s: string) => s.replace('gt-42/2/', 'gt-99/2/'),
    (s: string) => s.replace('value="chapter-1"', 'value="2"'),
    (s: string) => s.replace(' selected="selected"', ''),
    (s: string) => s.replace('>2화', ' selected="selected">2화'),
    (s: string) => s.replace('1화', ''),
    (s: string) => s.replace('single-chapter-select', 'unknown'),
  ])('rejects wrong or incomplete title navigation', mutate => {
    expect(() => preparePages(apiPages(), readerUrl).parse(mutate(navigation))).toThrow();
  });
  it.each([1, 2])('honors cancellation after API request %s', async stage => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      if (request.mock.calls.length === stage) controller.abort();
      return request.mock.calls.length === 1 ? apiPages() : navigation;
    });
    await expect(network.pages(readerUrl, {request, signal: controller.signal})).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(stage);
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
  it('accepts redirected search pages and keeps their current import and cover URLs', async () => {
    const next = 'https://www.goodtoon012.com';
    const request = vi.fn().mockResolvedValue(searchHtml(63, 1, true).replaceAll(origin, next).replaceAll('https://images.test', ''));
    const result = validateSearchPage(await network.search(input, {request}), definition, definition.sites![0], [definition]);
    expect(result.nextCursor).toBe('2');
    expect(result.items[0]).toMatchObject({catalogId: catalogKey('gt-1'), catalogUrl: next + '/manga/gt-1/',
      cover: {url: next + '/gt-1/cover_123.jpg'}});
    expect(request).toHaveBeenCalledExactlyOnceWith(origin + '/?q=test', undefined);
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
