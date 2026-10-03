import {describe, expect, it, vi} from 'vitest';
import {parseSearch, searchUrl} from '../search';
import {network} from '../network';
import {catalogUrl, origin} from '../definition';
import {cover, searchHtml, slug, url} from './fixtures';

const request = {siteId: 'klmanga', query: 'Work & Name'};
describe('KLManga name search', () => {
  it('uses the public GET search and bounded native page cursor', async () => {
    const target = new URL(searchUrl(request));
    expect(target.origin).toBe(origin); expect(target.pathname).toBe('/'); expect(target.searchParams.get('s')).toBe(request.query);
    expect(searchUrl({...request, cursor: 'page:2'})).toBe(origin + '/page/2/?s=Work+%26+Name');
    const fetch = vi.fn(async () => searchHtml(request.query, 1, true));
    const results = await network.search(request, {request: fetch});
    expect(fetch).toHaveBeenCalledWith(searchUrl(request));
    expect(results).toMatchObject({nextCursor: 'page:2', items: [{catalogUrl: url, title: 'Work & Name', cover: {url: cover}, latestLabel: '【第1話】'}]});
    expect(results.items[0]).not.toHaveProperty('contentLanguages');
    expect(parseSearch(searchHtml(request.query, 2), {...request, cursor: 'page:2'}).nextCursor).toBeUndefined();
  });
  it('accepts the source empty marker only under the matching search heading', () => {
    expect(parseSearch('<h4>Search: Work &amp; Name</h4><p>There is no item found!</p>', request)).toEqual({items: []});
    expect(() => parseSearch('<h4>Search: Other</h4><p>There is no item found!</p>', request)).toThrow();
    expect(() => parseSearch('<h4>Search: Work &amp; Name</h4><p>Please verify</p>', request)).toThrow();
  });
  it('compares rendered query whitespace without changing the submitted search', () => {
    for (const query of ['HUNTER  HUNTER', 'HUNTER\u3000HUNTER']) {
      const spaced = {...request, query};
      expect(new URL(searchUrl(spaced)).searchParams.get('s')).toBe(spaced.query);
      expect(parseSearch(searchHtml(spaced.query), spaced).items).toHaveLength(1);
    }
  });
  it('requires the native current page to match a requested continuation', () => {
    expect(() => parseSearch(searchHtml(request.query, 1, true), {...request, cursor: 'page:2'})).toThrow();
    expect(() => parseSearch(searchHtml(request.query), {...request, cursor: 'page:2'})).toThrow();
  });
  it.each([{...request, siteId: 'other'}, {...request, query: ''}, {...request, query: 'x'.repeat(257)},
    {...request, query: 'bad\u0000query'}, {...request, cursor: 'page:0'}, {...request, cursor: 'page:10000'}, {...request, cursor: 'https://evil.test/'}])
    ('rejects invalid request %j', input => expect(() => searchUrl(input)).toThrow());
  it.each(['owner', 'host', 'query', 'next', 'duplicate'])('rejects %s search evidence', kind => {
    let html = searchHtml(request.query, 1, true);
    if (kind === 'owner') html = html.replace(`href="${url}"`, `href="${catalogUrl('other')}"`);
    if (kind === 'host') html = html.replaceAll(url, 'https://klmanga.zone.evil.test/manga-raw/work/');
    if (kind === 'query') html = html.replace('Search: Work &amp; Name', 'Search: Other');
    if (kind === 'next') html = html.replace('/page/2/', '/page/3/');
    if (kind === 'duplicate') html = html.replace('</div>\n    <div class="z-pagination">', '</div>' + searchHtml(request.query));
    expect(() => parseSearch(html, request)).toThrow();
  });
  it('does not request after cancellation or accept a response after cancellation', async () => {
    const signal = new AbortController(); signal.abort(Error('cancelled'));
    const fetch = vi.fn(async () => searchHtml());
    await expect(network.search(request, {request: fetch, signal: signal.signal})).rejects.toThrow('cancelled');
    expect(fetch).not.toHaveBeenCalled();
    const second = new AbortController(); fetch.mockImplementation(async () => {second.abort(Error('cancelled')); return searchHtml();});
    await expect(network.search(request, {request: fetch, signal: second.signal})).rejects.toThrow('cancelled');
  });
  it('keeps the complete source slug in lightweight candidates', () => {
    expect(parseSearch(searchHtml(), request).items[0].catalogUrl).toBe(catalogUrl(slug));
  });
});
