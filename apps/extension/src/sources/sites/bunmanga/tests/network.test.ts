import {describe, expect, it, vi} from 'vitest';
import {catalogKey, catalogUrl, chapterKey, definition, mangaLocation, origin} from '../definition';
import {network, parsePages} from '../network';

const work = catalogUrl('fixture-book'), chapter = work + 'chap-1/';
const cover = origin + '/uploads/cover.jpg', image = origin + '/uploads/page.jpg';
// Authored structural samples, not copied source HTML or artwork.
const catalog = `<link rel="canonical" href="${work}"><h1>Fixture Book</h1><div class="summary_image"><a href="${work}"><img src="${cover}"></a></div>
  <div class="listing-chapters_wrap"><ul class="main version-chap"><li class="wp-manga-chapter"><a href="${work}chap-2/">Chap 2</a></li>
  <li class="wp-manga-chapter"><a href="${chapter}">Chap 1</a></li></ul></div>`;
const menu = `<select class="single-chapter-select"><option selected="selected" value="chap-1" data-redirect="${chapter}">Chap 1</option></select>`;
const holder = `<div class="chapters_selectbox_holder" data-manga="42" data-chapter="chap-1" data-type="manga" data-style="list" data-vol="0">${menu}</div>`;
const html = `<body class="postid-42"><link rel="canonical" href="${chapter}"><h1 id="chapter-heading">Fixture - Chap 1</h1>
  ${holder}<div id="manga-reading-nav-head" data-id="42" data-chapter="chap-1">${holder}</div>${holder}
  <div class="reading-content"><input id="wp-manga-current-chap" data-id="101" value="chap-1">
  <div class="page-break"><img class="wp-manga-chapter-img" id="image-0" data-src="${image}"></div>
  <div class="page-break"><img class="wp-manga-chapter-img" id="image-1" data-src="${image}"></div></div></body>`;

describe('Bun Manga shared Madara integration', () => {
  it('declares verified HTTP capabilities, English metadata and generic inline recognition', () => {
    expect(definition).toMatchObject({id: 'bunmanga', inlineRecognition: 'generic', embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720}});
    expect(definition.sites![0]).toMatchObject({search: true, pricing: 'unknown', primaryLanguages: ['en'], isRaw: false, adaptedOn: '2026-10-15'});
    expect(definition.sites![0].icon).toMatch(/^data:image\/svg\+xml,/);
    expect(definition.installation).toEqual({autoContentMatches: [], optionalContentMatches: [origin + '/*']});
    expect(network).not.toHaveProperty('pageTransport');
    expect(definition.identify(new URL(work))).toMatchObject({kind: 'catalog', pageKey: catalogKey('fixture-book')});
  });
  it.each(['http://bunmanga.com', 'https://www.bunmanga.com', 'https://bunmanga.com.evil.test', 'https://secret@bunmanga.com', 'https://bunmanga.com:444'])(
    'rejects unverified origin %s', host => expect(definition.identify(new URL(host + '/manga/book/'))).toBeNull());
  it.each(['chap-0', 'chap-1.5', 'chap-12-extra', 'chapter-2_1'])('retains opaque chapter %s across styles', chapter => {
    for (const style of ['', '?style=list', '?style=paged']) {
      expect(mangaLocation(new URL(work + chapter + '/' + style))).toEqual({slug: 'fixture-book', chapter});
      expect(definition.identify(new URL(work + chapter + '/' + style))?.pageKey).toBe(chapterKey({slug: 'fixture-book', chapter}));
    }
  });
  it.each(['/manga/a%2fb/', '/manga/book/ch-1/extra/', '/manga/book/?style=list', '/manga/book/ch-1/?style=other',
    '/manga/book/ch-1/?style=list&style=paged', '/manga/book/ch-1/#fragment', '/manga/'])(
    'does not import unsupported path %s', value => expect(definition.identify(new URL(origin + value))?.kind).toBe('other'));
  it('uses one catalog GET without chapter requests and returns source order', async () => {
    const request = vi.fn().mockResolvedValue(catalog), result = await network.catalog(work, {request});
    expect(request).toHaveBeenCalledExactlyOnceWith(work);
    expect(result).toMatchObject({sourceId: 'bunmanga', complete: true, cover: {url: cover}});
    expect(result.entries.map(entry => entry.remoteId)).toEqual(['chap-1', 'chap-2']);
  });
  it('validates all populated pickers, preserves duplicate image slots and makes one reader GET', async () => {
    const request = vi.fn().mockResolvedValue(html), result = await network.pages(chapter + '?style=paged', {request});
    expect(request).toHaveBeenCalledExactlyOnceWith(chapter + '?style=list');
    expect(result).toMatchObject({adapter: 'bunmanga', direction: 'ltr', discoveryComplete: true, knownTotal: 2});
    expect(result.items.map(item => item.id)).toEqual(['image-0', 'image-1']);
    expect(result.items[0].resource).toEqual(result.items[1].resource);
    expect(() => parsePages(html.replace('data-manga="42"', 'data-manga="43"'), chapter)).toThrow();
    expect(() => parsePages(html.replace('id="image-1"', 'id="image-2"'), chapter)).toThrow();
  });
  it.each(['catalog', 'pages'] as const)('honors cancellation without retry for %s', async operation => {
    const controller = new AbortController(), request = vi.fn(async () => {controller.abort(Error('cancelled')); return html;});
    const invoke = () => network[operation](operation === 'catalog' ? work : chapter, {request, signal: controller.signal});
    await expect(invoke()).rejects.toThrow('cancelled'); expect(request).toHaveBeenCalledOnce();
    request.mockClear(); await expect(invoke()).rejects.toThrow('cancelled'); expect(request).not.toHaveBeenCalled();
  });
});
