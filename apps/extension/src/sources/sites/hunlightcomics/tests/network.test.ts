import {describe, expect, it, vi} from 'vitest';
import {catalogKey, catalogUrl, chapterKey, definition, mangaLocation, origin} from '../definition';
import {network, parsePages} from '../network';

const url = catalogUrl('fixture-book'), reader = url + 'chapter-1/';
const detail = `<body class="postid-42"><link rel="canonical" href="${url}"><h1>Fixture Book</h1>
  <div class="summary_image"><a href="${url}"><img src="${origin}/cover.jpg"></a></div><div id="manga-chapters-holder" data-id="42"></div></body>`;
const chapters = `<div class="listing-chapters_wrap"><ul class="main version-chap">
  <li class="wp-manga-chapter"><a href="${url}chapter-2/">Chapter 2</a></li>
  <li class="wp-manga-chapter"><a href="${reader}">Chapter 1</a></li></ul></div>`;
const holder = '<div class="chapters_selectbox_holder" data-manga="42" data-chapter="chapter-1" data-type="manga" data-style="list" data-vol="0"></div>';
const html = `<body class="postid-42"><link rel="canonical" href="${reader}"><h1 id="chapter-heading">Fixture - Chapter 1</h1>
  ${holder}<div id="manga-reading-nav-head" data-id="42" data-chapter="chapter-1">${holder}</div>${holder}
  <div class="reading-content"><input id="wp-manga-current-chap" data-id="101" value="chapter-1">
  <div class="page-break"><img class="wp-manga-chapter-img" id="image-0" data-src="${origin}/page.jpg"></div></div></body>`;

describe('Hunlight Comics Madara integration', () => {
  it('declares exact-origin capabilities and stable identities across reader styles', () => {
    expect(definition).toMatchObject({inlineRecognition: 'generic', embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720},
      capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true}});
    expect(definition.sites![0]).toMatchObject({search: true, pricing: 'free', primaryLanguages: ['en'], isRaw: false, adaptedOn: '2026-10-23'});
    expect(definition.installation).toEqual({autoContentMatches: [], optionalContentMatches: [origin + '/*']});
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog', pageKey: catalogKey('fixture-book')});
    for (const style of ['', '?style=list', '?style=paged'])
      expect(definition.identify(new URL(reader + style))).toMatchObject({kind: 'reader',
        pageKey: chapterKey({slug: 'fixture-book', chapter: 'chapter-1'}), catalog: {key: catalogKey('fixture-book'), url}});
    for (const target of [origin + '.evil.test', origin + ':444', origin.replace('://', '://user@'), origin.replace('https:', 'http:')])
      expect(definition.identify(new URL(target + '/'))).toBeNull();
    for (const target of [url + '?style=list', reader + '?style=list&style=paged', reader + '#x', url + 'chapter-1/extra/', catalogUrl('a%2fb')])
      expect(mangaLocation(new URL(target))).toBeNull();
  });

  it('uses only the declared AJAX catalog, list reader and lightweight search endpoints', async () => {
    const request = vi.fn().mockResolvedValueOnce(detail).mockResolvedValueOnce(chapters).mockResolvedValueOnce(html);
    const catalog = await network.catalog(url, {request});
    expect(catalog).toMatchObject({sourceId: 'hunlightcomics', complete: true});
    expect(catalog.entries.map(e => e.remoteId)).toEqual(['chapter-1', 'chapter-2']);
    expect(await network.pages(reader + '?style=paged', {request})).toMatchObject({
      adapter: 'hunlightcomics', direction: 'rtl', discoveryComplete: true, knownTotal: 1});
    expect(request.mock.calls).toEqual([[url], [url + 'ajax/chapters/', {referer: url, form: {}}], [reader + '?style=list']]);
    expect(() => parsePages(html.replace('data-manga="42"', 'data-manga="99"'), reader)).toThrow();
    request.mockClear().mockResolvedValue('');
    expect(await network.search!({siteId: 'hunlightcomics', query: 'missing'}, {request})).toEqual({items: []});
    expect(request).toHaveBeenCalledExactlyOnceWith(origin + '/wp-admin/admin-ajax.php', {
      referer: origin + '/?s=missing&post_type=wp-manga', form: {action: 'madara_load_more', page: '0',
        template: 'madara-core/content/content-search', 'vars[paged]': '1', 'vars[template]': 'search',
        'vars[posts_per_page]': '12', 'vars[post_type]': 'wp-manga', 'vars[post_status]': 'publish', 'vars[s]': 'missing'},
    });
  });
});
