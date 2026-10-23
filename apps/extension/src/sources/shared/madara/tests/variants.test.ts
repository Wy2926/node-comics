import {afterEach, describe, expect, it, vi} from 'vitest';
import type {SourceNetworkContext} from '../../../contracts/network';
import type {MadaraLocation, MadaraSite} from '../config';
import {madaraImageUrl} from '../image';
import {createMadaraParsers} from '../index';
import {createMadaraNetwork} from '../network';

afterEach(() => vi.unstubAllGlobals());

// Small, authored protocol examples: no copied source HTML, live requests or registered sites.
function fixtureSite(options: Pick<MadaraSite, 'catalog' | 'reader' | 'searchPageSize'> = {}): MadaraSite {
  const origin = 'https://variants.madara.test';
  const catalogUrl = (slug: string) => `${origin}/manga/${slug}/`;
  const catalogKey = (slug: string) => `variants:manga:${slug}`;
  return {
    id: 'variants', name: 'Fixture variants', origin, direction: 'ltr', ...options,
    location(url: URL): MadaraLocation | null {
      if (url.origin !== origin || url.username || url.password || url.hash) return null;
      const match = /^\/manga\/([a-z0-9-]+)(?:\/([a-z0-9.-]+))?\/?$/.exec(url.pathname);
      if (!match || url.search && (!match[2] || !/^\?style=(?:list|paged)$/.test(url.search))) return null;
      return {slug: match[1], ...(match[2] ? {chapter: match[2]} : {})};
    },
    catalogUrl, catalogKey,
    chapterUrl: loc => `${catalogUrl(loc.slug)}${loc.chapter}/`,
    chapterKey: loc => `${catalogKey(loc.slug)}:${loc.chapter}`,
    imageUrl: value => madaraImageUrl(origin, value),
  };
}

const ajaxSite = fixtureSite({catalog: 'ajax', reader: 'ajax-select'});
const catalogSite = fixtureSite({reader: 'catalog-select'});
const workUrl = ajaxSite.catalogUrl('sample');
const pageUrl = ajaxSite.chapterUrl({slug: 'sample', chapter: 'chapter-1'});
const otherPageUrl = ajaxSite.chapterUrl({slug: 'other', chapter: 'chapter-1'});
const endpoint = workUrl + 'ajax/chapters/';
const download = (chapter = '101') => `<a class="btn-chapter-download" href="#" data-manga_id="42" data-chapter="${chapter}">Download</a>`;
const holder = '<div class="chapters_selectbox_holder" data-manga="42" data-chapter="chapter-1" data-type="manga" data-style="list" data-vol="0"></div>';
const nav = '<div id="manga-reading-nav-head" data-id="42" data-chapter="chapter-1"></div>';
const current = '<input id="wp-manga-current-chap" data-id="101" value="chapter-1">';
const menu = `<select class="single-chapter-select"><option value="chapter-2" data-redirect="${workUrl}chapter-2/">Chapter 2</option>
  <option selected="selected" value="chapter-1" data-redirect="${pageUrl}">Chapter 1 &amp; Start</option></select>`;

function detail() {
  return `<link rel="canonical" href="${workUrl}"><body class="single-wp-manga postid-42">
    <h1>Sample &amp; Book <span class="manga-title-badges custom">NEW</span></h1>
    <div class="summary_image"><a href="${workUrl}"><img data-src="/uploads/cover.jpg"></a></div>
    <div id="manga-chapters-holder" data-id="42"></div></body>`;
}
function chapters(withDownloads = true) {
  return `<div class="listing-chapters_wrap"><ul class="main version-chap">
    <li class="wp-manga-chapter"><a href="${workUrl}chapter-2/">Chapter 2</a>${withDownloads ? download('102') : ''}</li>
    <li class="wp-manga-chapter"><a href="${pageUrl}">Chapter 1</a><a class="c-new-tag" href="${pageUrl}">New</a>${withDownloads ? download() : ''}</li>
    </ul></div>`;
}
function reader(site: MadaraSite) {
  return `<link rel="canonical" href="${site.reader === 'catalog-select' ? workUrl : pageUrl}"><body class="single-wp-manga postid-42">
    ${site.reader === 'catalog-select' ? '<h1>Work title, not the chapter title</h1>' : '<h1 id="chapter-heading">Chapter 1 &amp; Start</h1>'}
    ${site.reader === 'ajax-select' ? nav + holder + holder : menu + menu}
    <div class="reading-content">${current}
      <div class="page-break"><img class="wp-manga-chapter-img" id="image-0" src="data:image/gif;base64,placeholder" data-src="/uploads/1.jpg"></div>
      <div class="page-break"><img class="wp-manga-chapter-img" id="image-1" src="/uploads/2.jpg"></div>
    </div></body>`;
}

type Mutation = [name: string, mutate: (html: string) => string];
const invalidDetails: Mutation[] = [
  ['foreign canonical', html => html.replace(`rel="canonical" href="${workUrl}"`, 'rel="canonical" href="/manga/other/"')],
  ['foreign cover', html => html.replace(`<a href="${workUrl}">`, '<a href="/manga/other/">')],
  ['missing title', html => html.replace(/<h1>[\s\S]*?<\/h1>/, '')],
  ['missing body', html => html.replace(/<body\b[^>]*>/, '')],
  ['duplicate body', html => html.replace('<body ', '<body class="postid-42"></body><body ')],
  ['missing post ID', html => html.replace('postid-42', 'single')],
  ['zero post ID', html => html.replace('postid-42', 'postid-0')],
  ['duplicate post ID', html => html.replace('postid-42', 'postid-42 postid-42')],
  ['missing holder', html => html.replace('<div id="manga-chapters-holder" data-id="42"></div>', '')],
  ['duplicate holder', html => html.replace('</body>', '<div id="manga-chapters-holder" data-id="42"></div></body>')],
  ['foreign holder', html => html.replace('id="manga-chapters-holder" data-id="42"', 'id="manga-chapters-holder" data-id="43"')],
];

describe('Madara explicit catalog variants', () => {
  it('validates the detail before one empty-form POST and never requests chapter/download links', async () => {
    const directFetch = vi.fn(() => {throw Error('unexpected direct fetch');});
    vi.stubGlobal('fetch', directFetch);
    const {network} = createMadaraNetwork(ajaxSite);
    const request = vi.fn<SourceNetworkContext['request']>().mockResolvedValueOnce(detail()).mockResolvedValueOnce(chapters());
    const snapshot = await network.catalog(workUrl, {request});
    expect(request.mock.calls).toEqual([[workUrl], [endpoint, {referer: workUrl, form: {}}]]);
    expect(snapshot).toMatchObject({id: 'variants:manga:sample', sourceId: 'variants', title: 'Sample & Book', complete: true,
      cover: {url: ajaxSite.origin + '/uploads/cover.jpg'}, defaultEntryId: 'variants:manga:sample:chapter-1'});
    expect(snapshot.entries.map(entry => [entry.remoteId, entry.title, entry.order])).toEqual([
      ['chapter-1', 'Chapter 1', 0], ['chapter-2', 'Chapter 2', 1],
    ]);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it.each(invalidDetails)('does not POST after %s in the detail', async (_name, mutate) => {
    const request = vi.fn<SourceNetworkContext['request']>().mockResolvedValue(mutate(detail()));
    await expect(createMadaraNetwork(ajaxSite).network.catalog(workUrl, {request})).rejects.toThrow();
    expect(request.mock.calls).toEqual([[workUrl]]);
  });

  it('requires the explicitly configured catalog response and does not fall back to inline markup', async () => {
    const inline = detail().replace('</body>', chapters(false) + '</body>');
    const ajax = createMadaraParsers(ajaxSite), plain = createMadaraNetwork(fixtureSite());
    expect(() => ajax.parseCatalog(inline, workUrl)).toThrow();
    expect(() => ajax.prepareCatalog(inline, workUrl).parse()).toThrow();
    expect(() => ajax.parseCatalog(detail(), workUrl, '')).toThrow();
    expect(() => plain.parseCatalog(inline, workUrl, chapters(false))).toThrow();
    const request = vi.fn<SourceNetworkContext['request']>().mockResolvedValue(inline);
    expect((await plain.network.catalog(workUrl, {request})).entries).toHaveLength(2);
    expect(request.mock.calls).toEqual([[workUrl]]);
    expect(plain.prepareCatalog(inline, workUrl).chapterListUrl).toBeUndefined();
  });

  const invalidLists: Mutation[] = [
    ['foreign work', html => html.replace(pageUrl, otherPageUrl)],
    ['foreign badge', html => html.replace(`class="c-new-tag" href="${pageUrl}"`, `class="c-new-tag" href="${otherPageUrl}"`)],
    ['volume list', html => html.replace('main version-chap', 'main version-chap has-volumn')],
    ['unknown group', html => html.replace('main version-chap', 'main')],
    ['extra group', html => html.replace('</ul>', '</ul><ul><li>Volume 2</li></ul>')],
    ['missing list', _html => '<div class="listing-chapters_wrap"></div>'],
    ['empty list', _html => '<div class="listing-chapters_wrap"><ul class="main version-chap"></ul></div>'],
    ['truncated list', html => html.slice(0, -6)],
    ['foreign download owner', html => html.replace('data-manga_id="42"', 'data-manga_id="43"')],
    ['missing download owner', html => html.replace(' data-manga_id="42"', '')],
    ['download href', html => html.replace('href="#"', 'href="/download/102"')],
    ['invalid download ID', html => html.replace('data-chapter="102"', 'data-chapter="0"')],
    ['missing download ID', html => html.replace(' data-chapter="102"', '')],
    ['duplicate download', html => html.replace(download('102'), download('102') + download('102'))],
  ];
  it.each(invalidLists)('rejects %s without claiming a complete AJAX catalog', (_name, mutate) => {
    expect(() => createMadaraParsers(ajaxSite).parseCatalog(detail(), workUrl, mutate(chapters()))).toThrow();
  });

  const reverseHeader = '<div class="c-blog__heading"><h2>Chapters</h2><a class="btn-reverse-order" href="#">Reverse order</a></div>';
  it('accepts the known sort placeholder and static read-more span without requesting more data', async () => {
    const fragment = reverseHeader + chapters().replace('</ul>', '</ul><div class="c-chapter-readmore"><span class="chapter-readmore">Show more</span></div>');
    const request = vi.fn<SourceNetworkContext['request']>().mockResolvedValueOnce(detail()).mockResolvedValueOnce(fragment);
    const snapshot = await createMadaraNetwork(ajaxSite).network.catalog(workUrl, {request});
    expect(snapshot.complete).toBe(true);
    expect(snapshot.entries.map(entry => entry.remoteId)).toEqual(['chapter-1', 'chapter-2']);
    expect(request.mock.calls).toEqual([[workUrl], [endpoint, {referer: workUrl, form: {}}]]);
  });

  it.each([
    ['outer next-page navigation', `<nav><a rel="next" href="${endpoint}?page=2">Next</a></nav>`],
    ['unknown outer link', `<a href="${pageUrl}">More chapters</a>`],
    ['load-more button', '<button class="chapter-readmore" data-page="2">Load more</button>'],
    ['non-placeholder sort link', reverseHeader.replace('href="#"', `href="${endpoint}?order=asc"`)],
  ])('rejects %s outside the AJAX chapter list without following it', async (_name, extra) => {
    const engine = createMadaraNetwork(ajaxSite), previous = engine.parseCatalog(detail(), workUrl, chapters());
    const retained = structuredClone(previous);
    const request = vi.fn<SourceNetworkContext['request']>().mockResolvedValueOnce(detail()).mockResolvedValueOnce(chapters() + extra);
    await expect(engine.network.catalog(workUrl, {request, previous})).rejects.toThrow();
    expect(request.mock.calls).toEqual([[workUrl], [endpoint, {referer: workUrl, form: {}}]]);
    expect(previous).toEqual(retained);
  });

  it('does not enable download-button semantics in the original static variant', () => {
    const html = detail().replace('</body>', chapters() + '</body>');
    expect(() => createMadaraParsers(fixtureSite()).parseCatalog(html, workUrl)).toThrow();
  });

  it.each([0, 1, 2])('honors cancellation before any request or after catalog request %i', async stop => {
    const controller = new AbortController(), reason = Error('catalog cancelled');
    let calls = 0;
    const request = vi.fn<SourceNetworkContext['request']>(async () => {
      const call = ++calls;
      if (call === stop) controller.abort(reason);
      return call === 1 ? detail() : chapters();
    });
    if (!stop) controller.abort(reason);
    await expect(createMadaraNetwork(ajaxSite).network.catalog(workUrl, {request, signal: controller.signal})).rejects.toBe(reason);
    expect(request).toHaveBeenCalledTimes(stop);
  });

  it('checks cancellation again before POST after detail validation', async () => {
    const controller = new AbortController(), reason = Error('cancelled during validation');
    const site = {...ajaxSite, imageUrl(value: unknown) {controller.abort(reason); return ajaxSite.imageUrl(value);}};
    const request = vi.fn<SourceNetworkContext['request']>().mockResolvedValue(detail());
    await expect(createMadaraNetwork(site).network.catalog(workUrl, {request, signal: controller.signal})).rejects.toBe(reason);
    expect(request.mock.calls).toEqual([[workUrl]]);
  });

  it.each([1, 2])('does not retry request %i or mutate the previous catalog when transport fails', async failedRequest => {
    const engine = createMadaraNetwork(ajaxSite), previous = engine.parseCatalog(detail(), workUrl, chapters());
    const retained = structuredClone(previous), reason = Error('source unavailable'), onCatalogProgress = vi.fn();
    let calls = 0;
    const request = vi.fn<SourceNetworkContext['request']>(async () => {
      if (++calls === failedRequest) throw reason;
      return detail();
    });
    await expect(engine.network.catalog(workUrl, {request, previous, onCatalogProgress})).rejects.toBe(reason);
    expect(request).toHaveBeenCalledTimes(failedRequest);
    expect(previous).toEqual(retained);
    expect(onCatalogProgress).not.toHaveBeenCalled();
  });

  it.each([pageUrl, 'https://other.madara.test/manga/sample/'])('rejects invalid catalog input before requesting %s', async url => {
    const request = vi.fn<SourceNetworkContext['request']>();
    await expect(createMadaraNetwork(ajaxSite).network.catalog(url, {request})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Madara explicitly selected reader navigation', () => {
  it.each([ajaxSite, catalogSite])('reads $reader with one list request and preserves the requested identity', async site => {
    const request = vi.fn<SourceNetworkContext['request']>().mockResolvedValue(reader(site));
    const url = pageUrl + '?style=paged', snapshot = await createMadaraNetwork(site).network.pages(url, {request});
    expect(request.mock.calls).toEqual([[pageUrl + '?style=list']]);
    expect(snapshot).toMatchObject({url, adapter: 'variants', title: 'Chapter 1 & Start', knownTotal: 2, discoveryComplete: true});
    expect(snapshot.items.map(item => item.resource)).toEqual([1, 2].map(page => ({kind: 'http', url: site.origin + `/uploads/${page}.jpg`})));
  });

  const invalidAjaxReaders: Mutation[] = [
    ['missing body', html => html.replace(/<body\b[^>]*>/, '')],
    ['missing post ID', html => html.replace('postid-42', 'single')],
    ['duplicate post IDs', html => html.replace('postid-42', 'postid-42 postid-43')],
    ['invalid post ID', html => html.replace('postid-42', 'postid-0')],
    ['missing nav', html => html.replace(nav, '')],
    ['duplicate nav', html => html.replace(nav, nav + nav)],
    ['foreign nav work', html => html.replace(nav, nav.replace('data-id="42"', 'data-id="43"'))],
    ['foreign nav chapter', html => html.replace(nav, nav.replace('chapter-1', 'chapter-2'))],
    ['one holder', html => html.replace(holder, '')],
    ['four holders', html => html.replace(holder, holder + holder + holder)],
    ['foreign holder work', html => html.replace(holder, holder.replace('data-manga="42"', 'data-manga="43"'))],
    ['foreign holder chapter', html => html.replace(holder, holder.replace('chapter-1', 'chapter-2'))],
    ['holder type', html => html.replace(holder, holder.replace('data-type="manga"', 'data-type="novel"'))],
    ['holder style', html => html.replace(holder, holder.replace('data-style="list"', 'data-style="paged"'))],
    ['holder volume', html => html.replace(holder, holder.replace('data-vol="0"', 'data-vol="1"'))],
    ['unexpected static menu', html => html.replace(nav, nav + menu)],
    ['foreign current chapter', html => html.replace(current, current.replace('chapter-1', 'chapter-2'))],
    ['missing current input', html => html.replace(current, '')],
    ['invalid current ID', html => html.replace(current, current.replace('data-id="101"', 'data-id="0"'))],
    ['work canonical', html => html.replace(`rel="canonical" href="${pageUrl}"`, `rel="canonical" href="${workUrl}"`)],
    ['foreign canonical', html => html.replace(`rel="canonical" href="${pageUrl}"`, `rel="canonical" href="${otherPageUrl}"`)],
    ['missing chapter heading', html => html.replace('id="chapter-heading"', 'id="other-heading"')],
  ];
  it.each(invalidAjaxReaders)('rejects AJAX reader %s rather than guessing navigation', (_name, mutate) => {
    expect(() => createMadaraParsers(ajaxSite).parsePages(mutate(reader(ajaxSite)), pageUrl)).toThrow();
  });

  it('accepts the verified additional breadcrumb picker without another network request', async () => {
    const html = reader(ajaxSite).replace(nav, holder + nav);
    const request = vi.fn<SourceNetworkContext['request']>().mockResolvedValue(html);
    const snapshot = await createMadaraNetwork(ajaxSite).network.pages(pageUrl, {request});
    expect(snapshot).toMatchObject({knownTotal: 2, discoveryComplete: true});
    expect(request.mock.calls).toEqual([[pageUrl + '?style=list']]);
  });

  it.each(['data-manga="42"', 'data-chapter="chapter-1"', 'data-vol="0"', 'data-type="manga"', 'data-style="list"'])(
    'still validates %s on the additional breadcrumb picker', attribute => {
      const extra = holder.replace(attribute, attribute.replace(/="[^"]*"/, '="foreign"'));
      expect(() => createMadaraParsers(ajaxSite).parsePages(reader(ajaxSite).replace(nav, extra + nav), pageUrl)).toThrow();
    });

  const populatedHolder = holder.replace('</div>', menu + '</div>');
  it.each([2, 3])('validates %i server-populated AJAX pickers without fetching their options', async count => {
    const html = reader(ajaxSite).replace(holder + holder, populatedHolder.repeat(count));
    const request = vi.fn<SourceNetworkContext['request']>().mockResolvedValue(html);
    expect(await createMadaraNetwork(ajaxSite).network.pages(pageUrl, {request})).toMatchObject({knownTotal: 2, discoveryComplete: true});
    expect(request.mock.calls).toEqual([[pageUrl + '?style=list']]);
  });
  it.each([
    ['partial population', populatedHolder + holder],
    ['standalone menus', holder + holder + menu + menu],
    ['two menus in one picker', holder.replace('</div>', menu + menu + '</div>') + holder],
    ['foreign selected work', populatedHolder + populatedHolder.replace(pageUrl, otherPageUrl)],
    ['foreign selected chapter', populatedHolder + populatedHolder.replace('selected="selected" value="chapter-1"', 'selected="selected" value="chapter-2"')],
    ['disagreeing labels', populatedHolder + populatedHolder.replace('Chapter 1 &amp; Start', 'Different chapter')],
  ])('rejects %s in server-populated AJAX navigation', (_label, markup) => {
    expect(() => createMadaraParsers(ajaxSite).parsePages(reader(ajaxSite).replace(holder + holder, markup), pageUrl)).toThrow();
  });

  const invalidCatalogReaders: Mutation[] = [
    ['foreign canonical work', html => html.replace(`rel="canonical" href="${workUrl}"`, 'rel="canonical" href="/manga/other/"')],
    ['chapter canonical', html => html.replace(`rel="canonical" href="${workUrl}"`, `rel="canonical" href="${pageUrl}"`)],
    ['missing menus', html => html.replaceAll(menu, '')],
    ['AJAX holder', html => html.replace(menu, menu + holder)],
    ['unselected menu', html => html.replace(' selected="selected"', '')],
    ['two selected options', html => html.replace('option value="chapter-2"', 'option selected="selected" value="chapter-2"')],
    ['foreign selected value', html => html.replace('selected="selected" value="chapter-1"', 'selected="selected" value="chapter-2"')],
    ['foreign selected work', html => html.replace(`data-redirect="${pageUrl}"`, `data-redirect="${otherPageUrl}"`)],
    ['foreign selected chapter', html => html.replace(`data-redirect="${pageUrl}"`, `data-redirect="${workUrl}chapter-2/"`)],
    ['disagreeing selected titles', html => html.replace('Chapter 1 &amp; Start', 'A different title')],
    ['blank selected title', html => html.replace('Chapter 1 &amp; Start', ' ')],
    ['foreign current chapter', html => html.replace(current, current.replace('chapter-1', 'chapter-2'))],
  ];
  it.each(invalidCatalogReaders)('rejects catalog-canonical reader %s', (_name, mutate) => {
    expect(() => createMadaraParsers(catalogSite).parsePages(mutate(reader(catalogSite)), pageUrl)).toThrow();
  });

  it('does not relax the original reader to accept either new variant automatically', () => {
    const original = createMadaraParsers(fixtureSite());
    expect(() => original.parsePages(reader(ajaxSite), pageUrl)).toThrow();
    expect(() => original.parsePages(reader(catalogSite), pageUrl)).toThrow();
    expect(() => createMadaraParsers(ajaxSite).parsePages(reader(fixtureSite()), pageUrl)).toThrow();
  });

  it.each([0, 1])('honors cancellation before/after the single pages request (%i)', async stop => {
    const controller = new AbortController(), reason = Error('pages cancelled');
    const request = vi.fn<SourceNetworkContext['request']>(async () => {controller.abort(reason); return reader(ajaxSite);});
    if (!stop) controller.abort(reason);
    await expect(createMadaraNetwork(ajaxSite).network.pages(pageUrl, {request, signal: controller.signal})).rejects.toBe(reason);
    expect(request).toHaveBeenCalledTimes(stop);
  });
});

describe('Madara explicit AJAX breadcrumb titles', () => {
  const site = fixtureSite({catalog: 'ajax', reader: 'ajax-breadcrumb'}), engine = createMadaraNetwork(site);
  const breadcrumb = `<div class="c-breadcrumb"><ol class="breadcrumb"><li><a href="${site.origin}/">Home</a></li>
    <li><a href="${workUrl}">Sample Book</a></li><li class="active">Chapter 1 &amp; Start</li></ol></div>`;
  const html = reader(ajaxSite).replace(/<h1[^>]*>.*?<\/h1>/, breadcrumb);
  it('uses an owned breadcrumb without relaxing AJAX navigation or adding a request', async () => {
    const request = vi.fn<SourceNetworkContext['request']>().mockResolvedValue(html);
    expect(await engine.network.pages(pageUrl, {request})).toMatchObject({title: 'Chapter 1 & Start', knownTotal: 2, discoveryComplete: true});
    expect(request.mock.calls).toEqual([[pageUrl + '?style=list']]);
    expect(() => createMadaraParsers(ajaxSite).parsePages(html, pageUrl)).toThrow();
    expect(() => engine.parsePages(reader(ajaxSite), pageUrl)).toThrow();
  });
  const invalid: Mutation[] = [
    ['missing wrapper', html => html.replace('class="c-breadcrumb"', 'class="other"')],
    ['duplicate breadcrumb', html => html + breadcrumb],
    ['extra item', html => html.replace('</ol>', '<li>Other</li></ol>')],
    ['nested item', html => html.replace('Sample Book</a>', 'Sample Book</a><li>Other</li>')],
    ['foreign homepage', html => html.replace(`href="${site.origin}/"`, 'href="https://foreign.test/"')],
    ['homepage query', html => html.replace(`href="${site.origin}/"`, `href="${site.origin}/?x=1"`)],
    ['foreign work', html => html.replace(`<a href="${workUrl}">`, '<a href="/manga/other/">')],
    ['chapter as work', html => html.replace(`<a href="${workUrl}">`, `<a href="${pageUrl}">`)],
    ['empty work name', html => html.replace('Sample Book', ' ')],
    ['unmarked current item', html => html.replace('class="active"', '')],
    ['extra active item', html => html.replace('<li>', '<li class="active">')],
    ['empty chapter', html => html.replace('Chapter 1 &amp; Start', ' ')],
    ['linked chapter', html => html.replace('Chapter 1 &amp; Start', `<a href="${pageUrl}">Chapter 1</a>`)],
    ['foreign navigation', html => html.replace('data-manga="42"', 'data-manga="99"')],
    ['foreign page slot owner', html => html.replace(current, current.replace('chapter-1', 'chapter-2'))],
    ['disagreeing prefilled menus', html => html.replaceAll(holder, holder.replace('</div>', menu.replace('Chapter 1 &amp; Start', 'Other') + '</div>'))],
  ];
  it.each(invalid)('rejects %s instead of falling back to a document title', (_label, mutate) => {
    expect(() => engine.parsePages(mutate(html), pageUrl)).toThrow();
  });
});

describe('Madara optional search and shared image syntax', () => {
  it('does not expose unverified search on the network capability object', () => {
    const engine = createMadaraNetwork(ajaxSite), input = {siteId: ajaxSite.id, query: 'sample'};
    expect(Object.hasOwn(engine.network, 'search')).toBe(false);
    expect(engine.network.search).toBeUndefined();
    expect(() => engine.searchUrl(input)).toThrow();
    expect(() => engine.parseSearch('', input)).toThrow();
  });

  it.each([undefined, 0, 1])('uses one search GET and checks cancellation at stage %s', async stop => {
    const engine = createMadaraNetwork(fixtureSite({searchPageSize: 2}));
    const input = {siteId: 'variants', query: 'sample'}, controller = new AbortController(), reason = Error('search cancelled');
    const request = vi.fn<SourceNetworkContext['request']>(async () => {
      if (stop === 1) controller.abort(reason);
      return '<input name="s" class="search-field" value="sample"><p>No matches found. Try a different search...</p>';
    });
    if (stop === 0) controller.abort(reason);
    const result = engine.network.search!(input, {request, signal: controller.signal});
    if (stop === undefined) await expect(result).resolves.toEqual({items: []});
    else await expect(result).rejects.toBe(reason);
    expect(request.mock.calls).toEqual(stop === 0 ? [] : [[ajaxSite.origin + '/?s=sample&post_type=wp-manga']]);
  });

  it('normalizes relative/lazy URLs without claiming site-specific CDN ownership', () => {
    expect(madaraImageUrl(ajaxSite.origin, '\n\t/uploads/1.jpg\n')).toBe(ajaxSite.origin + '/uploads/1.jpg');
    expect(madaraImageUrl(ajaxSite.origin, '//cdn.madara.test/page.jpg')).toBe('https://cdn.madara.test/page.jpg');
    expect(madaraImageUrl(ajaxSite.origin, 'http://cdn.madara.test/page.jpg')).toBe('http://cdn.madara.test/page.jpg');
  });

  it.each([undefined, null, {}, 7, '', ' ', 'a'.repeat(8193), '/a\nb.jpg', '/a\u0000b.jpg', '/a\u007fb.jpg',
    'javascript:alert(1)', 'data:image/png;base64,AAAA', 'blob:https://variants.madara.test/id', 'file:///page.jpg',
    'https://user@cdn.madara.test/page.jpg', 'https://:password@cdn.madara.test/page.jpg', '/page.jpg#fragment'])('rejects unsafe image input %#', value => {
    expect(() => madaraImageUrl(ajaxSite.origin, value)).toThrow();
  });
});
