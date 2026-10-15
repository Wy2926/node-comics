import {afterEach, describe, expect, it, vi} from 'vitest';
import type {SourceNetworkContext} from '../../../contracts/network';
import {SourceSearchError} from '../../../contracts/search';
import type {MadaraSite} from '../config';
import {madaraImageUrl} from '../image';
import {createMadaraNetwork} from '../network';
import {definition as lh} from '../../../sites/lhtranslation/definition';
import {network as lhNetwork} from '../../../sites/lhtranslation/network';
import {definition as sushi} from '../../../sites/mangasushi/definition';
import {network as sushiNetwork} from '../../../sites/mangasushi/network';
import {definition as eclipse} from '../../../sites/mangaeclipse/definition';
import {network as eclipseNetwork} from '../../../sites/mangaeclipse/network';
import {validateSearchPage} from '../../../core/search';

afterEach(() => vi.unstubAllGlobals());

const origin = 'https://ajax.madara.test';
const site: MadaraSite = {
  id: 'ajax', name: 'AJAX fixture', origin, direction: 'ltr', search: 'ajax', searchPageSize: 12,
  location(url) {
    if (url.origin !== origin || url.username || url.password || url.hash || url.search) return null;
    const match = /^\/manga\/([a-z0-9-]+)\/(?:([a-z0-9-]+)\/)?$/.exec(url.pathname);
    return match ? {slug: match[1], chapter: match[2]} : null;
  },
  catalogKey: slug => `ajax:manga:${slug}`, catalogUrl: slug => `${origin}/manga/${slug}/`,
  chapterKey: loc => `ajax:manga:${loc.slug}:${loc.chapter}`, chapterUrl: loc => `${origin}/manga/${loc.slug}/${loc.chapter}/`,
  imageUrl: value => madaraImageUrl(origin, value),
};
const engine = createMadaraNetwork(site), input = {siteId: site.id, query: 'Book & 龍 + "hero"'};
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const terminal = '<div class="invi no-posts"><!-- --></div>';
// Authored fragments model content-search, not captured source content or artwork.
function fragment(start = 0, count = 12, host = origin) {
  return Array.from({length: count}, (_, i) => {
    const url = `${host}/manga/book-${start + i}/`, image = `${host}/covers/${start + i}.jpg?a=1&b=2`;
    return `<div class="row c-tabs-item__content"><div class="tab-thumb"><a href="${url}">
      <img src="data:image/gif;base64,placeholder" data-src="${escape(image)}"><noscript><img src="${escape(image)}"></noscript>
      </a></div><div class="tab-summary"><div class="post-title"><h3><a href="${url}">Book &amp; ${start + i}</a></h3></div>
      <div class="post-content"><a href="${host}/manga-author/example/">Author</a></div></div></div>`;
  }).join('\n');
}

describe('Madara shared AJAX search', () => {
  it('uses one fixed read-only POST per page from page zero, without an initial GET or candidate prefetch', async () => {
    const fetch = vi.fn(() => {throw Error('unexpected direct fetch');}); vi.stubGlobal('fetch', fetch);
    for (const name of ['DOMParser', 'document', 'window', 'chrome']) vi.stubGlobal(name, undefined);
    const request = vi.fn<SourceNetworkContext['request']>().mockResolvedValueOnce(fragment()).mockResolvedValueOnce(fragment(12, 3) + terminal);
    const first = await engine.network.search!(input, {request});
    expect(first.items).toHaveLength(12); expect(first.nextCursor).toBe('page:2');
    expect(first.items[0]).toEqual({catalogId: 'ajax:manga:book-0', catalogUrl: origin + '/manga/book-0/', title: 'Book & 0',
      cover: {url: origin + '/covers/0.jpg?a=1&b=2'}});
    const second = await engine.network.search!({...input, cursor: first.nextCursor}, {request});
    expect(second.items.map(item => item.catalogId)).toEqual(['ajax:manga:book-12', 'ajax:manga:book-13', 'ajax:manga:book-14']);
    expect(second.nextCursor).toBeUndefined();
    expect(request.mock.calls).toEqual([0, 1].map(page => [origin + '/wp-admin/admin-ajax.php', {
      referer: origin + '/?' + new URLSearchParams({s: input.query, post_type: 'wp-manga'}),
      form: {action: 'madara_load_more', page: String(page), template: 'madara-core/content/content-search',
        'vars[paged]': '1', 'vars[template]': 'search', 'vars[posts_per_page]': '12',
        'vars[post_type]': 'wp-manga', 'vars[post_status]': 'publish', 'vars[s]': input.query},
    }]));
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['', ' \n\t'])('accepts the empty successful endpoint response %j, including a full final page', async empty => {
    const request = vi.fn().mockResolvedValueOnce(fragment()).mockResolvedValueOnce(empty);
    const first = await engine.network.search!(input, {request});
    expect(first.nextCursor).toBe('page:2');
    expect(await engine.network.search!({...input, cursor: first.nextCursor}, {request})).toEqual({items: []});
    expect(engine.parseSearch(empty, input)).toEqual({items: []});
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('uses the configured page size and never a public-page total or theme default', () => {
    const small = createMadaraNetwork({...site, searchPageSize: 2});
    expect(small.searchRequest(input).options?.form?.['vars[posts_per_page]']).toBe('2');
    expect(small.parseSearch(fragment(0, 2), input).nextCursor).toBe('page:2');
    expect(small.parseSearch(fragment(2, 1) + terminal, {...input, cursor: 'page:2'}).nextCursor).toBeUndefined();
    expect(() => createMadaraNetwork({...site, searchPageSize: undefined})).toThrow();
  });
  it('honors one empty trailing no-posts marker, including an exactly full last page', () => {
    for (const count of [0, 5, 12]) {
      const last = engine.parseSearch(fragment(12, count) + terminal, {...input, cursor: 'page:2'});
      expect(last.items).toHaveLength(count); expect(last.nextCursor).toBeUndefined();
    }
  });
  it.each([1, 5, 11])('rejects a %s-card short fragment without the verified end marker', count => {
    expect(() => engine.parseSearch(fragment(0, count), input)).toThrowError(SourceSearchError);
  });
  it.each(['0', '-1', 'null', '{}', '<p>No matches found. Try a different search...</p>',
    '<div class="no-posts">Unverified sentinel</div>', '<title>Just a moment...</title>', '<html><body>Login</body></html>',
    '<script>location.reload()</script>', '<!-- empty -->', '<div></div>', fragment(0, 13),
    fragment(0, 1) + '<p>Server error</p>', '<form>' + fragment(0, 1) + '</form>', fragment(0, 1).slice(0, -6),
    '<div class="unknown-layout">' + fragment(0, 1) + '</div>', fragment(0, 1) + fragment(0, 1),
    fragment(0, 1).replaceAll('/manga/book-0/', '/manga/book-0/chapter-1/'), fragment(0, 1, 'https://foreign.test'),
    fragment(0, 1).replace('class="tab-thumb"', 'class="missing-thumb"'),
    fragment(0, 1).replace('href="' + origin + '/manga/book-0/"', 'href="' + origin + '/manga/other/"'),
    '<div class="invi no-posts"></div>' + fragment(0, 1),
    fragment(0, 1) + '<div class="invi no-posts"></div><div class="invi no-posts"></div>',
    fragment(0, 1) + '<div class="invi no-posts"><div>Next page</div></div>',
    fragment(0, 1) + '<div class="invi no-posts" data-next="2"></div>',
    fragment(0, 1) + '<div class="invi no-posts" data-next=2></div>',
    '<div class="invi no-posts" hidden></div>',
  ])('rejects malformed, foreign, partial or non-protocol payload %#', html => {
    expect(() => engine.parseSearch(html, input)).toThrow();
  });
  it('ignores inert snippets alongside real cards but never executes them', () => {
    expect(engine.parseSearch('<script>' + fragment() + '</script><!-- ignored -->' + fragment(0, 1) + terminal, input).items).toHaveLength(1);
  });
  it.each(['page:0', 'page:-1', 'page:01', 'page:1.5', 'page:10000', 'page:2&vars[s]=other', '', 'https://foreign.test'])('rejects bad cursor %s before any request', async cursor => {
    const request = vi.fn();
    await expect(engine.network.search!({...input, cursor}, {request})).rejects.toBeInstanceOf(SourceSearchError);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([{siteId: 'foreign'}, {query: ''}, {query: ' '}, {query: 'line\nbreak'}, {query: 'x'.repeat(257)}])('validates request %# before networking', async change => {
    const request = vi.fn();
    await expect(engine.network.search!({...input, ...change}, {request})).rejects.toBeInstanceOf(SourceSearchError);
    expect(request).not.toHaveBeenCalled();
  });
  it('does not issue an out-of-bounds continuation', () => {
    expect(() => engine.parseSearch(fragment(), {...input, cursor: 'page:9999'})).toThrow();
    expect(engine.parseSearch(fragment(0, 1) + terminal, {...input, cursor: 'page:9999'}).nextCursor).toBeUndefined();
  });
  it.each([0, 1])('honors cancellation at stage %s without parsing or retrying', async stop => {
    const controller = new AbortController(), reason = Error('cancelled');
    const request = vi.fn(async () => {controller.abort(reason); return 'invalid';});
    if (stop === 0) controller.abort(reason);
    await expect(engine.network.search!(input, {request, signal: controller.signal})).rejects.toBe(reason);
    expect(request).toHaveBeenCalledTimes(stop);
  });
  it('propagates HTTP denial/failure without retry, false empty result or another channel', async () => {
    const error = Error('HTTP 403'), request = vi.fn().mockRejectedValue(error);
    await expect(engine.network.search!(input, {request})).rejects.toBe(error);
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('explicit Madara AJAX search consumers', () => {
  it.each([{definition: lh, network: lhNetwork}, {definition: sushi, network: sushiNetwork}, {definition: eclipse, network: eclipseNetwork}])(
    'validates $definition.id search results through the public contract with shared pagination', async ({definition, network}) => {
      const registered = definition.sites![0], host = new URL(registered.url).origin;
      expect(registered.search).toBe(true); expect(network).not.toHaveProperty('pageTransport');
      const request = vi.fn().mockResolvedValueOnce(fragment(0, 12, host)).mockResolvedValueOnce(fragment(12, 1, host) + terminal);
      const query = {siteId: registered.id, query: 'book'};
      const first = validateSearchPage(await network.search!(query, {request}), definition, registered, [lh, sushi, eclipse]);
      expect(first.items).toHaveLength(12); expect(first.nextCursor).toBe('page:2');
      expect(first.items[0]).toMatchObject({sourceId: definition.id, siteId: registered.id, catalogId: `${definition.id}:manga:book-0`});
      const last = validateSearchPage(await network.search!({...query, cursor: first.nextCursor}, {request}), definition, registered, [lh, sushi, eclipse]);
      expect(last.items).toHaveLength(1); expect(last.nextCursor).toBeUndefined();
      expect(request.mock.calls.map(([url, options]) => [url, options.form.page, options.form['vars[posts_per_page]']])).toEqual(
        ['0', '1'].map(page => [host + '/wp-admin/admin-ajax.php', page, '12']));
    });
});
