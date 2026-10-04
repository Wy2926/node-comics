import {describe, expect, it, vi} from 'vitest';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {validateSearchCapability, validateSearchPage} from '../../../core/search';
import {sourceNetworks} from '../../../registry/networks';
import {definition, mangaDnaLocation} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {parseSearch} from '../search';
import {regions} from '../html';
import {catalogHtml, cdn, reader, readerHtml, searchHtml, url} from './fixtures';

describe('MangaDNA identity and complete server catalog', () => {
  it('balances nested matching regions in source order and rejects unclosed selected blocks', () => {
    const rows = regions('<div class="body">outer<div class="body">inner</div>end</div>', 'div', a => a.class === 'body');
    expect(rows.map(row => row.body)).toEqual(['outer<div class="body">inner</div>end', 'inner']);
    expect(() => regions('<div class="body"><div>inner</div>', 'div', a => a.class === 'body')).toThrow('结构不完整');
  });
  it('registers automatically and keeps chapter slugs, fractional releases and ownership stable', () => {
    expect(sourceNetworks.mangadna).toBe(network);
    expect(validateSearchCapability(definition, definition.sites![0])).toBe(true);
    expect(mangaDnaLocation(new URL(reader))).toEqual({slug: 'fixture', chapter: 'chapter-175-8-8'});
    expect(definition.identify(new URL(reader + '?style=paged#page-3'))).toMatchObject({kind: 'reader', pageKey: 'mangadna:fixture:chapter-175-8-8', catalog: {key: 'mangadna:fixture', url}});
    expect(definition.identify(new URL(url + '/'))?.pageKey).toBe('mangadna:fixture');
  });
  it.each(['http://mangadna.com/manga/fixture', 'https://mangadna.com.evil.test/manga/fixture',
    'https://evil.mangadna.com/manga/fixture', 'https://user:secret@mangadna.com/manga/fixture', 'https://mangadna.com:444/manga/fixture'])('rejects forged host, transport or credentials: %s', value => {
    expect(definition.identify(new URL(value))).toBeNull();
  });
  it.each(['/manga', '/manga/page/2', '/manga/fixture/other', '/manga/fixture/chapter-1/next', '/manga/fixture%2fother', '/manga/fixture%00'])('does not import unsupported path: %s', path => {
    expect(definition.identify(new URL('https://mangadna.com' + path))?.kind).toBe('other');
  });
  it('reads the hidden full list in source reading order without guessing chapter count or language', () => {
    const value = validateCatalog(parseCatalog(catalogHtml(), url), [definition]);
    expect(value).toMatchObject({id: 'mangadna:fixture', title: 'Fixture & Hero', complete: true, cover: {url: 'https://mangadna.com/thumbnails/fixture-cover.jpg'}});
    expect(value.entries.map(e => [e.remoteId, e.order])).toEqual([['chapter-0', 0], ['chapter-175-8-8', 1]]);
    expect(value.groups[0].entryIds).toEqual(value.entries.map(e => e.id));
    expect(value.entries.every(e => e.sequenceId === value.id && e.contentLanguage === undefined && e.readingSlotId === undefined)).toBe(true);
  });
  it('merges identical duplicate rows, but rejects conflicting labels for the same chapter', () => {
    const rows: Array<[string, string]> = [['chapter-1', 'Chapter 1'], ['chapter-0', 'Chapter 0'], ['chapter-0', 'Chapter 0']];
    expect(parseCatalog(catalogHtml(rows), url).entries.map(e => e.order)).toEqual([0, 1]);
    rows[2][1] = 'Another release';
    expect(() => parseCatalog(catalogHtml(rows), url)).toThrow('重复');
  });
  it.each([
    (html: string) => html.replace('rel="canonical"', 'rel="other"'),
    (html: string) => html.replace(url + '"', url.replace('fixture', 'other') + '"'),
    (html: string) => html.replace(`${url}/chapter-0`, 'https://evil.test/manga/fixture/chapter-0'),
    (html: string) => html.replace(`${url}/chapter-0`, `${url.replace('fixture', 'other')}/chapter-0`),
    (html: string) => html.replace('</ul>', ''),
    (html: string) => html.replace('class="row-content-chapter"', 'class="preview"'),
  ])('rejects changed identity, foreign entries and incomplete markup', mutate => {
    expect(() => parseCatalog(mutate(catalogHtml()), url)).toThrow();
  });
});

describe('MangaDNA original page slots', () => {
  it('keeps duplicate URLs as separate pages and excludes ads and scripts', () => {
    const pages = validatePages(parsePages(readerHtml([1, 2], [cdn + '1-abc.jpg', cdn + '1-abc.jpg']), reader), definition.identify(new URL(reader))!);
    expect(pages).toMatchObject({discoveryComplete: true, knownTotal: 2, title: 'Fixture & Hero - Chapter 175.88', direction: 'ltr'});
    expect(pages.items.map(p => p.id)).toEqual(['page-0', 'page-1']);
    expect(pages.items[0].resource).toEqual(pages.items[1].resource);
  });
  it.each(['uploads', 'chapters', 'online'])('accepts source image path %s and source CDN hosts', directory => {
    const pages = parsePages(readerHtml([1], [cdn.replace('/uploads/', '/' + directory + '/').replace('cdn01.', 'cdn22.') + '1-abc.webp']), reader);
    expect(pages.knownTotal).toBe(1);
  });
  it('preserves missing source slots and explicitly marks the returned list incomplete', () => {
    const pages = validatePages(parsePages(readerHtml([1, 3]), reader), definition.identify(new URL(reader))!);
    expect(pages).toMatchObject({discoveryComplete: false, knownTotal: 3});
    expect(pages.items.map(p => [p.id, p.order])).toEqual([['page-0', 0], ['page-2', 2]]);
    expect(pages.note).toContain('缺页');
  });
  it('accepts repeated identical selected options without accepting another current chapter', () => {
    const option = '<option data-c="chapter-175-8-8" selected>Chapter 175.88</option>';
    const html = readerHtml().replaceAll(option, option + option);
    expect(parsePages(html, reader).items).toHaveLength(2);
    expect(() => parsePages(html.replace(option, '<option data-c="chapter-0" selected>Chapter 0</option>'), reader)).toThrow('身份');
  });
  it.each([
    (html: string) => html.replace('rel="canonical"', 'rel="other"'),
    (html: string) => html.replace(`href="${url}">Fixture`, 'href="https://evil.test/manga/fixture">Fixture'),
    (html: string) => html.replace('data-c="chapter-175-8-8" selected', 'data-c="chapter-0" selected'),
    (html: string) => html.replace('Page 2', 'Page 1'),
    (html: string) => html.replace('Page 2', 'Page 1501'),
    (html: string) => html.replaceAll('/175.88/2-abc.jpg', '/174/2-abc.jpg'),
    (html: string) => html.replaceAll('/7/175.88/2-abc.jpg', '/9/175.88/2-abc.jpg'),
    (html: string) => html.replaceAll('cdn01.mangadna.com', 'cdn01.mangadna.com.evil.test'),
    (html: string) => html.replaceAll('https://cdn01.', 'http://cdn01.'),
    (html: string) => html.replace('data-src="' + cdn + '2-abc.jpg"', 'data-src="' + cdn + '1-abc.jpg"'),
    (html: string) => html.replace('<div class="read-content">', '<div class="read-content"><canvas></canvas>'),
  ])('rejects wrong work/chapter, invalid images, reordered slots and changed structures', mutate => {
    expect(() => parsePages(mutate(readerHtml()), reader)).toThrow();
  });
  it('rejects out-of-order numbers while allowing real source gaps', () => {
    expect(() => parsePages(readerHtml([2, 1]), reader)).toThrow();
    expect(() => parsePages(readerHtml([]), reader)).toThrow('完整正文');
  });
});

describe('MangaDNA lightweight name search and requests', () => {
  const request = {siteId: 'mangadna', query: 'Hero'};
  it('uses query-bound server pagination, keeps optional language unknown and handles empty results', async () => {
    const value = validateSearchPage(parseSearch(searchHtml(), request), definition, definition.sites![0], [definition]);
    expect(value).toMatchObject({nextCursor: 'page:2', items: [{catalogId: 'mangadna:fixture', title: 'Fixture & Hero', latestLabel: 'Chapter 175.88'}]});
    expect(value.items[0].contentLanguages).toBeUndefined();
    const http = vi.fn().mockResolvedValue(searchHtml('Hero', 2));
    await network.search!({...request, cursor: 'page:2'}, {request: http});
    expect(http).toHaveBeenCalledExactlyOnceWith('https://mangadna.com/search?q=Hero&page=2');
    expect(parseSearch(searchHtml('Hero', 1, true), request)).toEqual({items: []});
  });
  it.each(['https://evil.test', 'page:0', 'page:10000', 'page:2?x=1'])('rejects invalid cursors before making a request: %s', async cursor => {
    const http = vi.fn();
    await expect(network.search!({...request, cursor}, {request: http})).rejects.toThrow('SOURCE_SEARCH_INVALID');
    expect(http).not.toHaveBeenCalled();
  });
  it.each([
    (html: string) => html.replace('RESULTS FOR "Hero"', 'RESULTS FOR "Other"'),
    (html: string) => html.replace('/search?q=Hero&amp;page=2', 'https://evil.test/search?q=Hero&amp;page=2'),
    (html: string) => html.replace('/search?q=Hero&amp;page=2', '/search?q=Other&amp;page=2'),
    (html: string) => html.replace('page=1', 'page=3'),
    (html: string) => html.replace(`${url}/chapter-175-8-8`, `${url.replace('fixture', 'other')}/chapter-1`),
  ])('rejects foreign candidates, pages and query changes', mutate => {
    expect(() => parseSearch(mutate(searchHtml()), request)).toThrow();
  });
  it('deduplicates identical candidates without treating related-site links as search hits', () => {
    const html = searchHtml(), card = html.slice(html.indexOf('<div class="home-item">'), html.indexOf('</div>\n    <div class="blog-pager">'));
    expect(parseSearch(html.replace('<div class="listupd">', '<div class="listupd">' + card), request).items).toHaveLength(1);
  });
  it('stops before/after requests on cancellation, propagates failures and only reads the requested operation', async () => {
    const controller = new AbortController(), http = vi.fn();
    controller.abort(Error('cancelled'));
    await expect(network.catalog!(url, {request: http, signal: controller.signal})).rejects.toThrow('cancelled');
    expect(http).not.toHaveBeenCalled();
    const next = new AbortController();
    http.mockImplementation(async () => {next.abort(Error('stopped')); return catalogHtml();});
    await expect(network.catalog!(url, {request: http, signal: next.signal})).rejects.toThrow('stopped');
    http.mockRejectedValue(Error('HTTP 503'));
    await expect(network.pages!(reader, {request: http})).rejects.toThrow('HTTP 503');
    http.mockResolvedValue(readerHtml());
    await network.pages!(reader, {request: http});
    expect(http).toHaveBeenLastCalledWith(reader);
  });
  it('refreshes from the current full response and does not mutate the previous catalog on failure', async () => {
    const previous = parseCatalog(catalogHtml(), url), old = JSON.stringify(previous), http = vi.fn().mockResolvedValue(catalogHtml([['chapter-176', 'Chapter 176'], ['chapter-175-8-8', 'Chapter 175.88'], ['chapter-0', 'Chapter 0']]));
    expect((await network.catalog!(url, {request: http, previous})).entries).toHaveLength(3);
    http.mockResolvedValue('unavailable');
    await expect(network.catalog!(url, {request: http, previous})).rejects.toThrow();
    expect(JSON.stringify(previous)).toBe(old);
  });
});
