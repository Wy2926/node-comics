import {afterEach, describe, expect, it, vi} from 'vitest';
import {createMangaThemesiaNetwork} from '../network';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {canonical, catalogHtml, chapter, chapterRow, coverUrl, envelope, fixtureDefinition, pageUrl, readerData, readerHtml, searchCard, searchHtml, sites, work} from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('MangaThemesia shared protocol without concrete hosts', () => {
  it.each(sites)('retains $id identities, native chapter order and declared direction', site => {
    const engine = createMangaThemesiaNetwork(site), definition = fixtureDefinition(site), url = site.catalogUrl(work);
    const catalog = validateCatalog(engine.parseCatalog(catalogHtml(site), url), [definition]);
    expect(catalog).toMatchObject({id: site.catalogKey(work), sourceId: site.id, url, title: 'Sample & Book', complete: true, cover: {url: coverUrl(site)}});
    expect(catalog.entries.map(entry => [entry.id, entry.order, entry.url])).toEqual([
      [site.chapterKey(chapter), 0, site.chapterUrl(chapter, work)],
      [site.chapterKey('sample-chapter-2.5'), 1, site.chapterUrl('sample-chapter-2.5', work)],
    ]);
    expect(catalog.groups[0]).toMatchObject({complete: true, entryIds: catalog.entries.map(entry => entry.id)});
    expect(catalog.defaultEntryId).toBe(catalog.entries[0].id);
    expect(catalog.entries.every(entry => !entry.contentLanguage && entry.sequenceId === catalog.id)).toBe(true);
    const reader = site.chapterUrl(chapter, work), pages = validatePages(engine.parsePages(readerHtml(site), reader), definition.identify(new URL(reader))!);
    expect(pages).toMatchObject({adapter: site.id, url: reader, title: 'Sample Chapter 1', direction: site.direction, discoveryComplete: true, knownTotal: 2});
    expect(pages.items.map(item => item.order)).toEqual([0, 1]);
    expect(new Set(pages.items.map(item => item.id)).size).toBe(2);
    expect(pages.items.map(item => item.resource)).toEqual(Array(2).fill({kind: 'http', url: pageUrl(site)}));
  });

  it('keeps same-slug works isolated and never assumes another configured origin', () => {
    const [alpha, beta] = sites, engine = createMangaThemesiaNetwork(alpha);
    expect(alpha.catalogKey(work)).not.toBe(beta.catalogKey(work));
    expect(alpha.chapterKey(chapter)).not.toBe(beta.chapterKey(chapter));
    expect(() => engine.parseCatalog(catalogHtml(beta), alpha.catalogUrl(work))).toThrow();
    expect(() => engine.parsePages(readerHtml(beta), alpha.chapterUrl(chapter, work))).toThrow();
    expect(() => engine.parseSearch(searchHtml(beta), {siteId: alpha.id, query: 'a & 日本語'})).toThrow();
  });

  it('ignores the hidden local history panel and does not require one work-details wrapper', () => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), url = site.catalogUrl(work);
    const expected = engine.parseCatalog(catalogHtml(site), url);
    const history = `<div class="bixbox bxcl" id="series-history" style="display:none"><ul><li><a href="${site.chapterUrl('other-chapter-90')}">Local history</a></li></ul></div>`;
    const html = catalogHtml(site).replace('<div class="postbody">', `<div class="postbody">${history}`)
      .replace('class="bigcontent"', 'class="site-details-wrapper"');
    const actual = engine.parseCatalog(html, url);
    expect(actual).toMatchObject({id: expected.id, complete: true, title: expected.title, cover: expected.cover,
      entries: expected.entries, groups: expected.groups, defaultEntryId: expected.defaultEntryId});
  });

  it.each(['chapter', 'pagination'])('rejects an unparsed %s link inside a chapter row', kind => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), row = chapterRow(site, chapter);
    const extra = kind === 'chapter' ? `<a href="${site.chapterUrl('sample-chapter-3')}">Chapter 3</a>` : '<a href="?page=2">More</a>';
    const html = catalogHtml(site).replace(row, row.replace('</div></div></li>', `</div>${extra}</div></li>`));
    expect(engine.parseCatalog(catalogHtml(site), site.catalogUrl(work)).entries).toHaveLength(2);
    expect(() => engine.parseCatalog(html, site.catalogUrl(work))).toThrow();
  });

  it('requires neither browser/DOM globals nor source-script execution', () => {
    const never = vi.fn(() => {throw Error('unexpected browser or script execution');});
    for (const name of ['fetch', 'DOMParser', 'eval']) vi.stubGlobal(name, never);
    for (const name of ['document', 'window', 'chrome', 'browser']) vi.stubGlobal(name, undefined);
    const site = sites[0], engine = createMangaThemesiaNetwork(site);
    engine.parseCatalog(catalogHtml(site), site.catalogUrl(work));
    engine.parsePages(readerHtml(site), site.chapterUrl(chapter, work));
    engine.parseSearch(searchHtml(site), {siteId: site.id, query: 'a & 日本語'});
    expect(never).not.toHaveBeenCalled();
  });

  it('passes every original and cover through the supplied image policy without deduplicating pages', () => {
    const site = sites[0], imageUrl = vi.fn(site.imageUrl), engine = createMangaThemesiaNetwork({...site, imageUrl});
    engine.parseCatalog(catalogHtml(site), site.catalogUrl(work));
    expect(imageUrl).toHaveBeenCalledWith(coverUrl(site));
    imageUrl.mockClear();
    expect(engine.parsePages(readerHtml(site), site.chapterUrl(chapter)).items).toHaveLength(2);
    expect(imageUrl.mock.calls.filter(call => call[0] === pageUrl(site))).toHaveLength(2);
    expect(() => engine.parsePages(readerHtml(site, ['https://foreign.invalid/page.jpg']), site.chapterUrl(chapter))).toThrow();
  });

  it('ignores noscript image mirrors and unrelated optional reader settings', () => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), data = readerData(site);
    const html = readerHtml(site).replace('<div id="readerarea"></div>',
      `<div id="readerarea"><noscript><img src="${pageUrl(site)}"><img src="${pageUrl(site)}"></noscript></div>`)
      .replace(JSON.stringify(data), JSON.stringify({...data, lazyload: false, prevUrl: '', nextUrl: '', noimagehtml: '<img src="not-a-page.jpg">'}));
    const pages = engine.parsePages(html, site.chapterUrl(chapter));
    expect(pages.items.map(item => item.resource)).toEqual(Array(2).fill({kind: 'http', url: pageUrl(site)}));
    expect(pages.knownTotal).toBe(2);
  });

  it.each(['img', 'iframe', 'canvas', 'video'])('rejects active %s alongside the supported JSON reader', tag => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site);
    const html = readerHtml(site).replace('<div id="readerarea"></div>', `<div id="readerarea"><${tag} src="${pageUrl(site)}"></${tag}></div>`);
    expect(() => engine.parsePages(html, site.chapterUrl(chapter))).toThrow();
  });

  it.each(['canonical', 'foreign', 'bound-owner', 'duplicate', 'empty', 'truncated', 'nested-list', 'extra-link', 'missing-directory-marker', 'missing-title', 'unsafe-cover'] as const)('rejects %s catalog evidence', kind => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), url = site.catalogUrl(work);
    let html = catalogHtml(site);
    if (kind === 'canonical') html = html.replace(canonical(url), canonical(site.catalogUrl('other')));
    if (kind === 'foreign') html = html.replace(site.chapterUrl(chapter), sites[1].chapterUrl(chapter));
    if (kind === 'bound-owner') html = html.replace(site.chapterUrl(chapter), site.chapterUrl(chapter, 'other'));
    if (kind === 'duplicate') html = html.replace(chapterRow(site, 'sample-chapter-2.5'), chapterRow(site, chapter, 'Conflicting title'));
    if (kind === 'empty') html = html.replace(/<li\b[\s\S]*?<\/li>/g, '');
    if (kind === 'truncated') html = html.slice(0, -7);
    if (kind === 'nested-list') html = html.replace('</ul>', '<ul></ul></ul>');
    if (kind === 'extra-link') html = html.replace('</ul>', '<a href="?page=2">More</a></ul>');
    if (kind === 'missing-directory-marker') html = html.replace('class="bixbox bxcl epcheck"', 'class="bixbox bxcl"');
    if (kind === 'missing-title') html = html.replace('class="entry-title"', 'class="other-title"');
    if (kind === 'unsafe-cover') html = html.replace(coverUrl(site), 'javascript:alert(1)');
    expect(() => engine.parseCatalog(html, url)).toThrow();
  });

  it.each(['canonical', 'owner', 'duplicate-owner', 'missing-owner', 'bound-owner', 'empty', 'truncated', 'wrong-reader-section', 'missing-readerarea', 'duplicate-readerarea'] as const)('rejects %s reader ownership or completeness', kind => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site);
    let html = readerHtml(site), target = site.chapterUrl(chapter, work);
    if (kind === 'canonical') html = html.replace(canonical(site.chapterUrl(chapter)), canonical(site.chapterUrl('other-chapter-1')));
    if (kind === 'owner') html = html.replace(site.catalogUrl(work), sites[1].catalogUrl(work));
    if (kind === 'duplicate-owner') html = html.replace('All chapters</a>', `All chapters</a><a href="${site.catalogUrl('other')}">Other</a>`);
    if (kind === 'missing-owner') html = html.replace('class="allc"', 'class="not-allc"');
    if (kind === 'bound-owner') target = site.chapterUrl(chapter, 'other');
    if (kind === 'empty') html = readerHtml(site, []);
    if (kind === 'truncated') html = html.slice(0, -7);
    if (kind === 'wrong-reader-section') html = html.replace('class="chapterbody"', 'class="postbody"');
    if (kind === 'missing-readerarea') html = html.replace('id="readerarea"', 'id="other"');
    if (kind === 'duplicate-readerarea') html = html.replace('<div id="readerarea"></div>', '<div id="readerarea"></div><div id="readerarea"></div>');
    expect(() => engine.parsePages(html, target)).toThrow();
  });

  it.each(['protected', 'missing-access', 'novel', 'token', 'mode', 'contentmode', 'post-id', 'empty-source', 'multiple-sources', 'mismatched-default', 'missing-image', 'non-string-image', 'unsafe-image'] as const)('rejects unsupported %s JSON rather than filtering pages', kind => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), data: Record<string, unknown> = readerData(site);
    if (kind === 'protected') data.protected = true;
    if (kind === 'missing-access') delete data.protected;
    if (kind === 'novel') data.is_novel = true;
    if (kind === 'token') data.unlock_token = 'not-a-free-public-reader';
    if (kind === 'mode') data.mode = 'single';
    if (kind === 'contentmode') data.contentmode = 'basic';
    if (kind === 'post-id') data.post_id = 0;
    if (kind === 'empty-source') data.sources = [];
    if (kind === 'multiple-sources') data.sources = [...readerData(site).sources, {source: 'Server 2', images: [pageUrl(site, 1)]}];
    if (kind === 'mismatched-default') data.defaultSource = 'Unknown';
    if (kind === 'missing-image') data.sources = [{source: 'Server 1', images: [pageUrl(site), '']}];
    if (kind === 'non-string-image') data.sources = [{source: 'Server 1', images: [pageUrl(site), null]}];
    if (kind === 'unsafe-image') data.sources = [{source: 'Server 1', images: ['javascript:alert(1)']}];
    const html = readerHtml(site).replace(JSON.stringify(readerData(site)), JSON.stringify(data));
    expect(() => engine.parsePages(html, site.chapterUrl(chapter))).toThrow();
  });

  it.each(['object-literal', 'expression', 'duplicate-call', 'two-calls-one-script', 'comment-only', 'template-only', 'noscript-only', 'style-only', 'textarea-only', 'string-only', 'wrapped-call', 'trailing-expression', 'external-script', 'empty-external-script', 'non-executable-script'] as const)('does not execute or accept %s script as a JSON list', kind => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), script = `<script>ts_reader.run(${JSON.stringify(readerData(site))});</script>`;
    let replacement = script;
    if (kind === 'object-literal') replacement = script.replace('"protected":false', 'protected:false');
    if (kind === 'expression') replacement = script.replace('ts_reader.run(', 'ts_reader.run(globalThis.__unexpected = ');
    if (kind === 'duplicate-call') replacement = script + script;
    if (kind === 'two-calls-one-script') replacement = script.replace('</script>', `ts_reader.run(${JSON.stringify(readerData(site))});</script>`);
    if (kind === 'comment-only') replacement = `<!--${script}-->`;
    if (kind === 'template-only') replacement = `<template>${script}</template>`;
    if (kind === 'noscript-only') replacement = `<noscript>${script}</noscript>`;
    if (kind === 'style-only') replacement = `<style>${script}</style>`;
    if (kind === 'textarea-only') replacement = `<textarea>${script}</textarea>`;
    if (kind === 'string-only') replacement = `<script>const example = ${JSON.stringify(`ts_reader.run(${JSON.stringify(readerData(site))});`)};</script>`;
    if (kind === 'wrapped-call') replacement = script.replace('<script>', '<script>function later(){').replace('</script>', '}</script>');
    if (kind === 'trailing-expression') replacement = script.replace('</script>', 'globalThis.__unexpected = true;</script>');
    if (kind === 'external-script') replacement = script.replace('<script>', '<script src="https://untrusted.invalid/code.js">');
    if (kind === 'empty-external-script') replacement = script.replace('<script>', '<script src="">');
    if (kind === 'non-executable-script') replacement = script.replace('<script>', '<script type="application/json">');
    expect(() => engine.parsePages(readerHtml(site).replace(script, replacement), site.chapterUrl(chapter))).toThrow();
  });

  it.each(['missing', 'malformed'])('does not fall back to valid static images when the JSON list is %s', kind => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site);
    const script = `<script>ts_reader.run(${JSON.stringify(readerData(site))});</script>`;
    const html = readerHtml(site).replace('<div id="readerarea"></div>', `<div id="readerarea"><img src="${pageUrl(site)}"></div>`)
      .replace(script, kind === 'missing' ? '' : '<script>ts_reader.run({not-json});</script>');
    expect(() => engine.parsePages(html, site.chapterUrl(chapter))).toThrow();
  });

  it('searches only lightweight cards and preserves the query across the next-page URL', async () => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), input = {siteId: site.id, query: 'a & 日本語'};
    const result = engine.parseSearch(searchHtml(site, 2, 1, true), input);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({catalogId: site.catalogKey('sample-0'), catalogUrl: site.catalogUrl('sample-0'), cover: {url: coverUrl(site)}});
    expect(result.items[0].contentLanguages).toBeUndefined();
    expect(result.nextCursor).toBe('page:2');
    expect(engine.searchUrl({...input, cursor: result.nextCursor})).toBe(site.searchUrl(input.query, 2));
    expect(engine.parseSearch(searchHtml(site, 1, 2), {...input, cursor: result.nextCursor}).nextCursor).toBeUndefined();
    const request = vi.fn(async () => searchHtml(site));
    await engine.network.search!(input, {request});
    expect(request).toHaveBeenCalledExactlyOnceWith(site.searchUrl(input.query, 1));
  });

  it.each(['foreign-next', 'changed-query', 'skipped-next', 'duplicate-next', 'current', 'duplicate-card', 'foreign-card', 'missing-cover', 'verification', 'truncated'] as const)('rejects invalid %s search evidence', kind => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), input = {siteId: site.id, query: 'a & 日本語'};
    let html = searchHtml(site, 2, 1, true);
    if (kind === 'foreign-next') html = html.replace(site.searchUrl(input.query, 2).replaceAll('&', '&amp;'), sites[1].searchUrl(input.query, 2).replaceAll('&', '&amp;'));
    if (kind === 'changed-query') html = html.replace('?s=a+', '?s=other+');
    if (kind === 'skipped-next') html = html.replace('/page/2/', '/page/3/');
    if (kind === 'duplicate-next') html = html.replace('Next »</a>', `Next »</a><a class="next" href="${site.searchUrl(input.query, 2)}">More</a>`);
    if (kind === 'current') html = html.replace('aria-current="page">1', 'aria-current="page">3');
    if (kind === 'duplicate-card') html = html.replace(searchCard(site, 'sample-1'), searchCard(site, 'sample-0'));
    if (kind === 'foreign-card') html = html.replace(site.catalogUrl('sample-0'), sites[1].catalogUrl('sample-0'));
    if (kind === 'missing-cover') html = html.replace(`<img src="${coverUrl(site)}">`, '');
    if (kind === 'verification') html = envelope('<title>Just a moment...</title>');
    if (kind === 'truncated') html = html.slice(0, -7);
    expect(() => engine.parseSearch(html, input)).toThrow();
  });

  it('accepts only the explicit empty-result marker and binds the search heading', () => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), input = {siteId: site.id, query: 'a & 日本語'};
    const empty = searchHtml(site, 0);
    expect(engine.parseSearch(empty, input)).toEqual({items: []});
    expect(() => engine.parseSearch(empty.replace('<center><h3>Not Found</h3></center>', ''), input)).toThrow();
    expect(() => engine.parseSearch(searchHtml(site).replace("Search 'a &amp; 日本語'", "Search 'other'"), input)).toThrow();
    expect(engine.parseSearch(searchHtml(site).replace("Search '", "Buscar '"), input).items).toHaveLength(2);
  });

  it('accepts an empty single-page pager but not a lost next link or pagination container', () => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), input = {siteId: site.id, query: 'a & 日本語'};
    const onePage = searchHtml(site, 1).replace('<span class="page-numbers current" aria-current="page">1</span>', '');
    expect(engine.parseSearch(onePage, input).nextCursor).toBeUndefined();
    expect(() => engine.parseSearch(searchHtml(site, 1, 1, true).replace('class="next page-numbers"', 'class="page-numbers"'), input)).toThrow();
    expect(() => engine.parseSearch(onePage.replace('<div class="pagination"></div>', ''), input)).toThrow();
  });

  it.each([{siteId: 'other', query: 'x'}, {siteId: 'alpha', query: ''}, {siteId: 'alpha', query: 'x\n'},
    {siteId: 'alpha', query: 'x'.repeat(257)}, {siteId: 'alpha', query: 'x', cursor: 'https://evil.test'},
    {siteId: 'alpha', query: 'x', cursor: 'page:0'}, {siteId: 'alpha', query: 'x', cursor: 'page:10000'}])('rejects malformed search input $cursor', input => {
    expect(() => createMangaThemesiaNetwork(sites[0]).searchUrl(input)).toThrow();
  });

  it('resolves a bare chapter and performs one read-only GET for each operation', async () => {
    const site = sites[0], {network} = createMangaThemesiaNetwork(site);
    const request = vi.fn().mockResolvedValueOnce(readerHtml(site)).mockResolvedValueOnce(catalogHtml(site)).mockResolvedValueOnce(readerHtml(site));
    expect(await network.resolveCatalog!(site.chapterUrl(chapter), {request})).toBe(site.catalogUrl(work));
    await network.catalog!(site.catalogUrl(work), {request});
    await network.pages!(site.chapterUrl(chapter, work), {request});
    expect(request.mock.calls).toEqual([[site.chapterUrl(chapter)], [site.catalogUrl(work)], [site.chapterUrl(chapter)]]);
    await expect(network.resolveCatalog!(site.catalogUrl(work), {request})).rejects.toThrow();
    await expect(network.pages!(site.catalogUrl(work), {request})).rejects.toThrow();
    await expect(network.catalog!(site.chapterUrl(chapter), {request})).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('preserves previous catalog state on failure and checks cancellation before and after HTTP', async () => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), {network} = engine;
    const previous = engine.parseCatalog(catalogHtml(site), site.catalogUrl(work)), saved = structuredClone(previous);
    const request = vi.fn().mockRejectedValue(Error('unavailable'));
    await expect(network.catalog!(site.catalogUrl(work), {request, previous})).rejects.toThrow('unavailable');
    expect(previous).toEqual(saved);
    for (const operation of [network.catalog!.bind(null, site.catalogUrl(work)), network.pages!.bind(null, site.chapterUrl(chapter, work)),
      network.resolveCatalog!.bind(null, site.chapterUrl(chapter)), network.search!.bind(null, {siteId: site.id, query: 'sample'})]) {
      const before = new AbortController(); before.abort(Error('cancelled')); request.mockClear();
      await expect(operation({request, signal: before.signal})).rejects.toThrow('cancelled');
      expect(request).not.toHaveBeenCalled();
      const after = new AbortController(); request.mockImplementation(async () => {after.abort(Error('cancelled')); return readerHtml(site);});
      await expect(operation({request, signal: after.signal})).rejects.toThrow('cancelled');
    }
  });

  it('accepts 10000 chapter rows and rejects an additional row', () => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), chapters = Array.from({length: 10000}, (_, index) => `sample-chapter-${10000 - index}`);
    const catalog = engine.parseCatalog(catalogHtml(site, chapters), site.catalogUrl(work));
    expect(catalog.entries).toHaveLength(10000);
    expect(catalog.entries[0].remoteId).toBe(chapter);
    expect(() => engine.parseCatalog(catalogHtml(site, [...chapters, 'sample-chapter-10001']), site.catalogUrl(work))).toThrow();
  });

  it('accepts 1500 duplicate-URL page slots and rejects one additional slot', () => {
    const site = sites[0], engine = createMangaThemesiaNetwork(site), images = Array(1500).fill(pageUrl(site)) as string[];
    const pages = engine.parsePages(readerHtml(site, images), site.chapterUrl(chapter));
    expect(pages.knownTotal).toBe(1500);
    expect(pages.items.at(-1)?.order).toBe(1499);
    expect(new Set(pages.items.map(item => item.id)).size).toBe(1500);
    expect(() => engine.parsePages(readerHtml(site, [...images, pageUrl(site)]), site.chapterUrl(chapter))).toThrow();
  });
});
