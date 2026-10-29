import {describe, expect, it, vi} from 'vitest';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {catalogKey, definition, galleryLocation, readerKey} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {cover, gallery, id, image, reader, readerHtml, url} from './fixtures';

describe('nHentai.to gallery source', () => {
  it('normalizes HTTP links while retaining one work and one reader identity across pages', () => {
    for (const scheme of ['http:', 'https:']) {
      const base = url.replace('https:', scheme);
      expect(definition.identify(new URL(base))).toMatchObject({kind: 'catalog', pageKey: catalogKey(id), catalog: {url}});
      for (const page of [1, 2, 1500]) expect(definition.identify(new URL(base + page + '/')))
        .toMatchObject({kind: 'reader', pageKey: readerKey(id), catalog: {key: catalogKey(id), url}});
    }
    expect(definition.inlineRecognition).toBe('generic');
    expect(definition.embeddedEntry).toBe('floating');
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
    expect(definition.sites![0]).toMatchObject({isAdult: true, pricing: 'free'});
    expect(definition.sites![0]).not.toHaveProperty('search');
    expect(network).not.toHaveProperty('search');
    expect(network).not.toHaveProperty('pageTransport');
    expect(definition.installation.optionalContentMatches).toEqual(['http://nhentai.to/*', 'https://nhentai.to/*']);
  });
  it.each(['https://nhentai.com', 'https://nhentai.net', 'https://www.nhentai.to', 'https://nhentai.to.evil.test',
    'https://user@nhentai.to', 'https://nhentai.to:444', 'ftp://nhentai.to', 'https://supercdn.site'])('rejects a foreign origin: %s', origin => {
    expect(definition.identify(new URL(origin + '/g/12345/1/'))).toBeNull();
  });
  it.each(['/g/0/', '/g/01/', '/g/12345/0/', '/g/12345/01/', '/g/12345/1501/', '/g/12345/read/',
    '/g/12345/1/extra', '/g/123%2F45/', '/g/1234567890123/', '/g/12345/?page=2', '/g/12345/#2', '/go'])('does not import unsupported state: %s', path => {
    expect(galleryLocation(new URL('https://nhentai.to' + path))).toBeNull();
    expect(definition.identify(new URL('https://nhentai.to' + path))?.kind).toBe('other');
  });
  it('builds a single complete entry, dedicated cover and explicit source language', () => {
    const snapshot = validateCatalog(parseCatalog(readerHtml(), url), [definition]);
    expect(snapshot).toMatchObject({id: catalogKey(id), url, title: 'Sample Gallery', cover: {url: cover}, complete: true,
      defaultEntryId: readerKey(id), groups: [{entryIds: [readerKey(id)], complete: true}],
      entries: [{id: readerKey(id), catalogId: catalogKey(id), remoteId: id, url: reader,
        rawTypes: ['doujinshi'], contentLanguage: 'en', order: 0}]});
    expect(snapshot.entries).toHaveLength(1);
    for (const name of ['translated', 'constructor', '__proto__', 'unknown']) {
      const data = gallery(); data.tags = [{type: 'language', name}];
      expect(parseCatalog(readerHtml(data), url).entries[0].contentLanguage).toBeUndefined();
    }
    const data = gallery(); data.tags.push({type: 'language', name: 'japanese'});
    expect(parseCatalog(readerHtml(data), url).entries[0].contentLanguage).toBeUndefined();
  });
  it('uses the verified reader recipe and preserves the whole book when entered through a later page', () => {
    const data = gallery(); data.num_pages = 4;
    data.images.pages = ['j', 'p', 'g', 'w'].map(t => ({t, w: 800, h: 1200}));
    const target = url + '3/';
    const snapshot = validatePages(parsePages(readerHtml(data, 3), target), definition.identify(new URL(target))!);
    expect(snapshot).toMatchObject({url: target, discoveryComplete: true, knownTotal: 4});
    expect(snapshot.items.map(item => [item.id, item.order, item.resource])).toEqual(['jpg', 'png', 'gif', 'webp'].map((ext, i) =>
      [`page-${i + 1}`, i, {kind: 'http', url: image(i + 1, ext)}]));
    expect(snapshot.items.every(item => item.width === 800 && item.height === 1200)).toBe(true);
  });
  it.each<(data: ReturnType<typeof gallery>) => void>([
    d => {d.id++;}, d => {d.media_id = '999';}, d => {d.media_id = '../67890';},
    d => {d.num_pages = 0;}, d => {d.num_pages = 1501;}, d => {d.num_pages = 2.5;},
    d => {d.images.pages.pop();}, d => {d.images.pages[0].t = 'x';},
    d => {d.images.pages[0].w = 0;}, d => {d.images.pages[0].h = 1.5;},
    d => {d.images.cover.t = 'unknown';}, d => {d.title.pretty = d.title.english = '';},
  ])('rejects incomplete or mismatched data instead of guessing pages', change => {
    const data = gallery(); change(data);
    expect(() => parseCatalog(readerHtml(data), url)).toThrow();
    expect(() => parsePages(readerHtml(data), reader)).toThrow();
  });
  it('rejects detail-page objects, wrong selected pages, duplicate configuration and forged CDN paths', () => {
    const body = readerHtml();
    for (const changed of [body.replace('N.reader', 'N.gallery'), body.replace('start_page: 1', 'start_page: 2'),
      body.replace(`href="${reader}"`, 'href="https://nhentai.to/g/999/1/"'),
      body.replace('https://supercdn.site/', 'https://supercdn.site.evil.test/'),
      body.replace('https://supercdn.site/', 'https://user@supercdn.site/'),
      body.replace('/1.webp', '/1t.webp'), body.replace('/1.webp', '/cover.webp'),
      body.replace('</body>', body.match(/<script>[\s\S]*?<\/script>/)![0] + '</body>'),
      body.replace('"pages":[', '"pages":(()=>['), '<title>Just a moment...</title>'])
      expect(() => parsePages(changed, reader)).toThrow();
    expect(() => parseCatalog(body, reader)).toThrow();
    expect(() => parsePages(body, url)).toThrow();
    expect(() => parsePages(readerHtml(gallery(), 4), url + '4/')).toThrow();
  });
  it('only parses literal reader data and ignores inert or external script copies', () => {
    const data = gallery(); data.title.pretty = 'Sample {\"quoted\"} title, }';
    const body = readerHtml(data), script = body.match(/<script>[\s\S]*?<\/script>/)![0];
    const withCopies = body.replace('</body>', `<!--${script}--><template>${script}</template><noscript>${script}</noscript><script src="/external.js">${script.slice(8, -9)}</script></body>`);
    expect(parsePages(withCopies, reader).title).toBe(data.title.pretty);
    expect(parsePages(body.replace(',}, start_page', '}, start_page'), reader).items).toHaveLength(3);
  });
  it('uses one HTTPS reader request per operation, with no search, thumbnails or per-page crawl', async () => {
    const request = vi.fn().mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(readerHtml(gallery(), 2));
    await network.catalog(url.replace('https:', 'http:'), {request});
    await network.pages(url + '2/', {request});
    expect(request.mock.calls).toEqual([[reader, {referer: url}], [url + '2/', {referer: url}]]);
  });
  it('honors cancellation and failed refreshes without mutating previous data or retrying', async () => {
    const previous = parseCatalog(readerHtml(), url), before = structuredClone(previous), request = vi.fn();
    const controller = new AbortController(); controller.abort(Error('cancelled'));
    await expect(network.catalog(url, {request, previous, signal: controller.signal})).rejects.toThrow('cancelled');
    expect(request).not.toHaveBeenCalled();
    const late = new AbortController();
    await expect(network.pages(reader, {signal: late.signal, request: async () => {late.abort(Error('navigation')); return readerHtml();}})).rejects.toThrow('navigation');
    request.mockRejectedValue(Error('unavailable'));
    await expect(network.catalog(url, {request, previous})).rejects.toThrow('unavailable');
    expect(request).toHaveBeenCalledOnce(); expect(previous).toEqual(before);
  });
});
