import {afterEach, describe, expect, it, vi} from 'vitest';
import type {MadaraLocation, MadaraSite} from '../config';
import {createMadaraParsers} from '../index';

afterEach(() => vi.unstubAllGlobals());

function fixtureSite(id: string, path: string, searchPageSize: number, direction: 'ltr' | 'rtl') {
  const origin = `https://${id}.madara.test`, imageOrigin = `https://images-${id}.madara.test`;
  const pattern = new RegExp(`^/${path}/([a-z0-9-]+)(?:/([a-z0-9.-]+))?/?$`);
  const catalogKey = (slug: string) => `${id}:${path}:${slug}`;
  const catalogUrl = (slug: string) => `${origin}/${path}/${slug}/`;
  return {
    id, name: `Fixture ${id}`, origin, direction, searchPageSize, imageOrigin,
    location(url: URL): MadaraLocation | null {
      if (url.origin !== origin || url.username || url.password || url.hash || url.search) return null;
      const match = pattern.exec(url.pathname);
      return match ? {slug: match[1], ...(match[2] ? {chapter: match[2]} : {})} : null;
    },
    catalogKey, catalogUrl,
    chapterKey: (loc: MadaraLocation) => `${catalogKey(loc.slug)}:${loc.chapter}`,
    chapterUrl: (loc: MadaraLocation) => `${catalogUrl(loc.slug)}${loc.chapter}/`,
    imageUrl(value: unknown) {
      if (typeof value !== 'string' || !value.trim()) throw Error('fixture image missing');
      const url = new URL(value.trim(), origin);
      if (url.origin !== imageOrigin || url.username || url.password || url.hash) throw Error('fixture image policy');
      return url.href;
    },
  } satisfies MadaraSite & {imageOrigin: string};
}

const sites = [fixtureSite('alpha', 'manga', 2, 'ltr'), fixtureSite('beta', 'comics', 3, 'rtl')];
type FixtureSite = typeof sites[number];
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const chapterUrl = (site: MadaraSite, chapter = 'chapter-1', slug = 'sample') => site.chapterUrl({slug, chapter});
const coverHtml = (site: FixtureSite, slug = 'sample') => `<a href="${site.catalogUrl(slug)}"><img src="${site.imageOrigin}/cover.jpg"></a>`;
const chapterRow = (site: MadaraSite, chapter: string, slug = 'sample', title = chapter) =>
  `<li class="wp-manga-chapter"><a href="${chapterUrl(site, chapter, slug)}">${escape(title)}</a></li>`;
function catalogHtml(site: FixtureSite, chapters = ['chapter-2.5', 'chapter-1', '0']) {
  return `<link rel="canonical" href="${site.catalogUrl('sample')}"><h1>Sample &amp; Book</h1>
    <div class="summary_image">${coverHtml(site)}</div><div class="listing-chapters_wrap">
    <ul class="main no-volumn">${chapters.map(id => chapterRow(site, id)).join('')}</ul></div>`;
}
function readerHtml(site: FixtureSite, images = Array(2).fill(site.imageOrigin + '/page.jpg') as string[]) {
  const url = chapterUrl(site);
  return `<link rel="canonical" href="${url}"><h1 id="chapter-heading">Chapter 1</h1>
    <select class="single-chapter-select"><option value="chapter-1" selected="selected" data-redirect="${url}">Chapter 1</option></select>
    <div class="reading-content"><input id="wp-manga-current-chap" data-id="42" value="chapter-1">
    ${images.map((image, i) => `<div class="page-break"><img class="wp-manga-chapter-img" id="image-${i}" src="${escape(image)}"></div>`).join('')}</div>`;
}
function searchHtml(site: FixtureSite, total = site.searchPageSize + 1, page = 1, query = 'a & b', singular = false) {
  const start = (page - 1) * site.searchPageSize, end = Math.min(total, page * site.searchPageSize);
  const items = Array.from({length: Math.max(0, end - start)}, (_, offset) => {
    const id = `sample-${start + offset}`;
    return `<div class="c-tabs-item__content"><div class="post-title"><a href="${site.catalogUrl(id)}">Sample &amp; ${start + offset}</a></div>
      <div class="tab-thumb">${coverHtml(site, id)}</div></div>`;
  }).join('');
  const next = site.origin + `/page/${page + 1}/?` + new URLSearchParams({s: query, post_type: 'wp-manga'});
  return `<input name="s" class="search-field" value="${escape(query)}">
    <h1 class="h4">${total} ${singular ? 'result' : 'results'} for &quot;${escape(query)}&quot;</h1>${items}
    ${total > site.searchPageSize ? `<div class="wp-pagenavi"><span class="current">${page}</span>${end < total ? `<a rel="next" href="${escape(next)}">Next</a>` : ''}</div>` : ''}`;
}

describe('Madara shared parsers without a concrete site', () => {
  it.each(sites)('uses $id identity, work paths, native order and reading direction', site => {
    const engine = createMadaraParsers(site), catalog = engine.parseCatalog(catalogHtml(site), site.catalogUrl('sample'));
    const id = site.catalogKey('sample'), pages = engine.parsePages(readerHtml(site), chapterUrl(site));
    expect(catalog).toMatchObject({id, sourceId: site.id, url: site.catalogUrl('sample'), title: 'Sample & Book', complete: true,
      cover: {url: site.imageOrigin + '/cover.jpg'}, defaultEntryId: site.chapterKey({slug: 'sample', chapter: '0'})});
    expect(catalog.entries.map(entry => [entry.remoteId, entry.order, entry.id, entry.catalogId, entry.sequenceId, entry.url])).toEqual(
      ['0', 'chapter-1', 'chapter-2.5'].map((chapter, order) => [chapter, order, site.chapterKey({slug: 'sample', chapter}), id, id, chapterUrl(site, chapter)]));
    expect(catalog.groups).toEqual([{id: 'chapters', title: 'Chapters', complete: true, entryIds: catalog.entries.map(entry => entry.id)}]);
    expect(pages).toMatchObject({adapter: site.id, direction: site.direction, discoveryComplete: true, knownTotal: 2});
    expect(pages.items.map(item => [item.id, item.order, item.resource])).toEqual([0, 1].map(order =>
      [`image-${order}`, order, {kind: 'http', url: site.imageOrigin + '/page.jpg'}]));
  });

  it('keeps same-slug works isolated and rejects the other configured source', () => {
    const [first, second] = sites, a = createMadaraParsers(first), b = createMadaraParsers(second);
    const aCatalog = a.parseCatalog(catalogHtml(first), first.catalogUrl('sample'));
    const bCatalog = b.parseCatalog(catalogHtml(second), second.catalogUrl('sample'));
    expect(aCatalog.id).not.toBe(bCatalog.id);
    expect(aCatalog.entries[0].id).not.toBe(bCatalog.entries[0].id);
    expect(() => a.parseCatalog(catalogHtml(second), second.catalogUrl('sample'))).toThrow();
    expect(() => a.parseCatalog(catalogHtml(second), first.catalogUrl('sample'))).toThrow();
    expect(() => b.parsePages(readerHtml(first), chapterUrl(second))).toThrow();
    expect(() => a.searchUrl({siteId: second.id, query: 'sample'})).toThrow();
  });

  it.each(sites)('uses $id search page size and validates one result versus results', site => {
    const engine = createMadaraParsers(site), input = {siteId: site.id, query: 'a & b'};
    const first = engine.parseSearch(searchHtml(site), input);
    expect(first.items).toHaveLength(site.searchPageSize);
    expect(first.nextCursor).toBe('page:2');
    expect(first.items[0]).toEqual({catalogId: site.catalogKey('sample-0'), catalogUrl: site.catalogUrl('sample-0'), title: 'Sample & 0',
      cover: {url: site.imageOrigin + '/cover.jpg'}});
    expect(engine.parseSearch(searchHtml(site, site.searchPageSize + 1, 2), {...input, cursor: 'page:2'})).toMatchObject({items: [{catalogId: site.catalogKey(`sample-${site.searchPageSize}`)}]});
    for (const singular of [true, false]) expect(engine.parseSearch(searchHtml(site, 1, 1, input.query, singular), input).items).toHaveLength(1);
    expect(engine.parseSearch(searchHtml(site, 0), input)).toEqual({items: []});
    expect(engine.searchUrl(input)).toBe(site.origin + '/?s=a+%26+b&post_type=wp-manga');
    expect(engine.searchUrl({...input, cursor: 'page:2'})).toBe(site.origin + '/page/2/?s=a+%26+b&post_type=wp-manga');
  });

  it('has no DOM/browser dependency or network request while parsing every operation', () => {
    for (const name of ['window', 'document', 'DOMParser', 'chrome', 'browser']) vi.stubGlobal(name, undefined);
    const fetch = vi.fn(() => {throw Error('unexpected network request');}); vi.stubGlobal('fetch', fetch);
    for (const site of sites) {
      const engine = createMadaraParsers(site);
      expect(engine.parseCatalog(catalogHtml(site), site.catalogUrl('sample')).complete).toBe(true);
      expect(engine.parsePages(readerHtml(site), chapterUrl(site)).discoveryComplete).toBe(true);
      expect(engine.parseSearch(searchHtml(site, 1), {siteId: site.id, query: 'a & b'}).items).toHaveLength(1);
      expect(engine.searchUrl({siteId: site.id, query: 'a & b'})).toContain('post_type=wp-manga');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('delegates every original and cover to the supplied image policy without deduplicating pages', () => {
    const site = sites[0], imageUrl = vi.fn(site.imageUrl), engine = createMadaraParsers({...site, imageUrl});
    const cover = site.imageOrigin + '/cover.jpg', original = site.imageOrigin + '/page.jpg';
    const lazyCover = catalogHtml(site).replace(`<img src="${cover}">`, `<img src="data:image/gif;base64,placeholder" data-src="${site.imageOrigin}/wrong.jpg" data-lazy-src="${cover}"><noscript><img src="${cover}"></noscript>`);
    expect(engine.parseCatalog(lazyCover, site.catalogUrl('sample')).cover).toEqual({url: cover});
    const lazyPages = readerHtml(site).replaceAll(`src="${original}"`, `src="data:image/gif;base64,placeholder" data-src="\n\t${original}\n"`);
    expect(engine.parsePages(lazyPages, chapterUrl(site)).items.map(item => item.resource)).toEqual(Array(2).fill({kind: 'http', url: original}));
    engine.parseSearch(searchHtml(site, 1), {siteId: site.id, query: 'a & b'});
    expect(imageUrl.mock.calls).toEqual([[cover], [`\n\t${original}\n`], [`\n\t${original}\n`], [cover]]);
    expect(() => engine.parsePages(readerHtml(site, ['https://untrusted.madara.test/a.jpg']), chapterUrl(site))).toThrow('fixture image policy');
    expect(() => engine.parseCatalog(catalogHtml(site).replace(cover, 'https://untrusted.madara.test/cover.jpg'), site.catalogUrl('sample'))).toThrow('fixture image policy');
  });

  it('deduplicates only identical chapter labels and keeps recent-release badges out of titles', () => {
    const site = sites[0], engine = createMadaraParsers(site), url = chapterUrl(site);
    const html = catalogHtml(site, ['chapter-1', 'chapter-1', '0']).replace(`>chapter-1</a>`, `>chapter-1</a><a class="c-new-tag" href="${url}">New</a>`);
    expect(engine.parseCatalog(html, site.catalogUrl('sample')).entries.map(entry => [entry.remoteId, entry.title, entry.order])).toEqual([
      ['0', '0', 0], ['chapter-1', 'chapter-1', 1]]);
    expect(() => engine.parseCatalog(html.replace('>chapter-1</a>', '>conflicting title</a>'), site.catalogUrl('sample'))).toThrow();
    expect(() => engine.parseCatalog(html.replace(`class="c-new-tag" href="${url}"`, `class="c-new-tag" href="${chapterUrl(site, 'chapter-2')}"`), site.catalogUrl('sample'))).toThrow();
  });

  it.each(['empty', 'volume', 'extra-list', 'extra-link', 'truncated', 'foreign-chapter', 'foreign-cover', 'canonical', 'duplicate-cover'] as const)('rejects %s catalog rather than claiming completeness', kind => {
    const site = sites[0], engine = createMadaraParsers(site), url = site.catalogUrl('sample');
    let html = catalogHtml(site);
    if (kind === 'empty') html = catalogHtml(site, []);
    if (kind === 'volume') html = html.replace('no-volumn', 'has-volumn');
    if (kind === 'extra-list') html = html.replace('</ul>', '</ul><ul><li>Unrecognized volume</li></ul>');
    if (kind === 'extra-link') html = html.replace('</ul>', '<a href="?page=2">More</a></ul>');
    if (kind === 'truncated') html = html.slice(0, -6);
    if (kind === 'foreign-chapter') html = html.replace(chapterUrl(site), chapterUrl(site, 'chapter-1', 'another-work'));
    if (kind === 'foreign-cover') html = html.replace(coverHtml(site), coverHtml(site, 'another-work'));
    if (kind === 'canonical') html = html.replace(`rel="canonical" href="${url}"`, `rel="canonical" href="${site.catalogUrl('another-work')}"`);
    if (kind === 'duplicate-cover') html = html.replace('</a></div>', `<img src="${site.imageOrigin}/extra.jpg"></a></div>`);
    expect(() => engine.parseCatalog(html, url)).toThrow();
  });

  it.each(['empty', 'missing-slot', 'truncated', 'selected', 'current', 'canonical', 'video', 'extra-image'] as const)('rejects %s reader without inventing pages', kind => {
    const site = sites[1], engine = createMadaraParsers(site), url = chapterUrl(site);
    let html = readerHtml(site);
    if (kind === 'empty') html = readerHtml(site, []);
    if (kind === 'missing-slot') html = html.replace('id="image-1"', 'id="image-2"');
    if (kind === 'truncated') html = html.slice(0, -6);
    if (kind === 'selected') html = html.replace(`data-redirect="${url}"`, `data-redirect="${chapterUrl(site, 'chapter-2')}"`);
    if (kind === 'current') html = html.replace('data-id="42" value="chapter-1"', 'data-id="42" value="chapter-2"');
    if (kind === 'canonical') html = html.replace(`rel="canonical" href="${url}"`, `rel="canonical" href="${chapterUrl(site, 'chapter-2')}"`);
    if (kind === 'video') html = html.replace('class="reading-content">', 'class="reading-content"><video src="movie.mp4"></video>');
    if (kind === 'extra-image') html = html.replace('class="reading-content">', `class="reading-content"><img src="${site.imageOrigin}/ad.jpg">`);
    expect(() => engine.parsePages(html, url)).toThrow();
  });

  it.each(['script', 'style', 'template', 'comment'] as const)('ignores %s markup and refuses to use it as source evidence', kind => {
    const site = sites[0], engine = createMadaraParsers(site);
    const wrap = (html: string) => kind === 'comment' ? `<!--${html}-->` : `<${kind}>${html}</${kind}>`;
    const catalog = catalogHtml(site), reader = readerHtml(site), search = searchHtml(site, 1), input = {siteId: site.id, query: 'a & b'};
    expect(engine.parseCatalog(wrap(catalog) + catalog, site.catalogUrl('sample')).entries).toHaveLength(3);
    expect(engine.parsePages(wrap(reader) + reader, chapterUrl(site)).items).toHaveLength(2);
    expect(engine.parseSearch(wrap(search) + search, input).items).toHaveLength(1);
    expect(() => engine.parseCatalog(wrap(catalog), site.catalogUrl('sample'))).toThrow();
    expect(() => engine.parsePages(wrap(reader), chapterUrl(site))).toThrow();
    expect(() => engine.parseSearch(wrap(search), input)).toThrow();
  });

  it.each(['count', 'current', 'foreign-next', 'next-query', 'duplicate', 'verification'] as const)('rejects %s search pagination and ownership', kind => {
    const site = sites[1], engine = createMadaraParsers(site), input = {siteId: site.id, query: 'a & b'};
    let html = searchHtml(site);
    if (kind === 'count') html = html.replace('4 results', '3 results');
    if (kind === 'current') html = html.replace('class="current">1<', 'class="current">2<');
    if (kind === 'foreign-next') html = html.replace(site.origin + '/page/2/', sites[0].origin + '/page/2/');
    if (kind === 'next-query') html = html.replace('s=a+%26+b', 's=other');
    if (kind === 'duplicate') html = html.replaceAll('/sample-1/', '/sample-0/');
    if (kind === 'verification') html = '<title>Just a moment...</title>';
    expect(() => engine.parseSearch(html, input)).toThrow();
  });

  it.each([0, -1, 1.5, 101, NaN, Infinity])('rejects invalid search page size %s', searchPageSize => {
    expect(() => createMadaraParsers({...sites[0], searchPageSize})).toThrow();
  });

  it('accepts the bounded 1500-page list and refuses an additional page', () => {
    const site = sites[0], engine = createMadaraParsers(site), images = Array(1500).fill(site.imageOrigin + '/page.jpg') as string[];
    const pages = engine.parsePages(readerHtml(site, images), chapterUrl(site));
    expect(pages.knownTotal).toBe(1500);
    expect(pages.items.at(-1)).toMatchObject({id: 'image-1499', order: 1499});
    expect(() => engine.parsePages(readerHtml(site, [...images, images[0]]), chapterUrl(site))).toThrow();
  });

  it('accepts the bounded 10000-chapter list and refuses additional chapter rows', () => {
    const site = sites[1], engine = createMadaraParsers(site), chapters = Array.from({length: 10000}, (_, i) => `chapter-${9999 - i}`);
    const catalog = engine.parseCatalog(catalogHtml(site, chapters), site.catalogUrl('sample'));
    expect(catalog.entries).toHaveLength(10000);
    expect(catalog.entries[0]).toMatchObject({remoteId: 'chapter-0', order: 0});
    expect(catalog.entries.at(-1)).toMatchObject({remoteId: 'chapter-9999', order: 9999});
    expect(() => engine.parseCatalog(catalogHtml(site, [...chapters, 'chapter-10000']), site.catalogUrl('sample'))).toThrow();
  });
});
