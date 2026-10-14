import {describe, expect, it, vi} from 'vitest';
import {catalogKey, comicLocation, definition, readerKey} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {catalogData, cover, image, pagesData, reader, slug, url} from './fixtures';

describe('nHentai.com source contract', () => {
  it('recognizes locale URLs and page links as the same book, without claiming nhentai.net', () => {
    for (const locale of ['en', 'zh', 'id', 'fr', 'es', 'de', 'ru', 'hi', 'pt', 'ar']) {
      const book = url.replace('/es/', `/${locale}/`);
      expect(definition.identify(new URL(book))).toMatchObject({kind: 'catalog', pageKey: catalogKey(slug)});
      for (const suffix of ['/reader', '/reader/', '/reader/1', '/reader/9/'])
        expect(definition.identify(new URL(book + suffix))).toMatchObject({kind: 'reader', pageKey: readerKey(slug),
          catalog: {key: catalogKey(slug), url: book}});
    }
    expect(definition.inlineRecognition).toBe('generic');
    expect(definition.embeddedEntry).toBe('floating');
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
    expect(definition.installation.optionalContentMatches).toEqual(['https://nhentai.com/*']);
    expect(network.pageTransport).toEqual(['catalog', 'pages']);
    expect(definition.sites![0]).not.toHaveProperty('search');
  });

  it.each(['https://nhentai.net', 'https://nhentai.com.evil.test', 'https://cdn.nhentai.com',
    'https://nhentai.com@evil.test', 'https://user@nhentai.com', 'http://nhentai.com', 'ftp://nhentai.com',
    'https://nhentai.com:444'])('rejects foreign origins and credentials: %s', base => {
    expect(definition.identify(new URL(base + `/es/comic/${slug}/reader`))).toBeNull();
  });

  it.each(['/es/comic/../other', '/xx/comic/sample', '/es/comic/a%2Fb', '/es/comic/a%3Fb',
    '/es/comic/a%00', '/es/comic/a/reader/0', '/es/comic/a/reader/01', '/es/comic/a/reader/1501',
    '/es/comic/a/chapter/1', '/g/123', `/es/comic/${'a'.repeat(513)}`, '/es/latest'])('does not import unsupported paths: %s', path => {
    expect(comicLocation(new URL('https://nhentai.com' + path))).toBeNull();
    expect(definition.identify(new URL('https://nhentai.com' + path))?.kind).toBe('other');
  });

  it.each(['?id=other', '#page-2'])('does not discard unrecognized URL state: %s', suffix => {
    expect(comicLocation(new URL(url + suffix))).toBeNull();
  });

  it('returns a single full-book entry, dedicated cover and actual content language', () => {
    const snapshot = validateCatalog(parseCatalog(JSON.stringify(catalogData()), url), [definition]);
    expect(snapshot).toMatchObject({id: catalogKey(slug), title: 'Sample Comic', complete: true, cover: {url: cover},
      defaultEntryId: readerKey(slug), groups: [{entryIds: [readerKey(slug)], complete: true}],
      entries: [{id: readerKey(slug), url: url + '/reader', remoteId: '123', contentLanguage: 'ja', rawTypes: ['Doujinshi']}]});
    expect(snapshot.entries).toHaveLength(1);
    for (const slug of ['unknown', 'constructor', '__proto__']) {
      const unknown = {...catalogData(), language: {slug}};
      expect(parseCatalog(JSON.stringify(unknown), url).entries[0].contentLanguage).toBeUndefined();
    }
  });

  it('sorts explicit source page numbers, retains repeated image URLs and uses durable image IDs', () => {
    const data = pagesData(); data.images[1].source_url = data.images[0].source_url; data.images.reverse();
    const snapshot = validatePages(parsePages(JSON.stringify(data), reader), definition.identify(new URL(reader))!);
    expect(snapshot).toMatchObject({url: reader, discoveryComplete: true, knownTotal: 3,
      items: [{id: 'image-101', order: 0}, {id: 'image-102', order: 1}, {id: 'image-103', order: 2}]});
    expect(snapshot.items.map(item => item.resource)).toEqual([image(1), image(1), image(3)].map(url => ({kind: 'http', url})));
  });

  it.each<(d: ReturnType<typeof pagesData>) => void>([
    d => {d.comic.slug = 'other';},
    d => {d.comic.id = 456;}, d => {d.comic.pages = 4;}, d => {d.images.pop();},
    d => {d.images[1].id = d.images[0].id;}, d => {d.images[1].page = 1;},
    d => {d.images[1].page = 0;}, d => {d.images[1].page = 4;},
    d => {d.images[1].source_url = d.images[1].thumbnail_url;},
    d => {d.images[1].source_url = image(2).replace('/123/', '/456/');},
    d => {d.images[1].source_url = image(2).replace('cdn.nhentai.com', 'cdn.nhentai.com.evil.test');},
    d => {d.images[1].source_url = image(2) + '?token=unverified';},
  ])('rejects mismatched, duplicate, missing and foreign pages', change => {
    const data = pagesData(); change(data);
    expect(() => parsePages(JSON.stringify(data), reader)).toThrow();
  });

  it('rejects unsupported chapter structures instead of declaring a partial book complete', () => {
    const data = catalogData(); data.chapters_count = 1;
    expect(() => parseCatalog(JSON.stringify(data), url)).toThrow('分章');
    expect(() => parsePages(JSON.stringify({...pagesData(), chapter: {id: 1}}), reader)).toThrow();
    expect(() => parsePages(JSON.stringify({...pagesData(), next_chapter: {id: 2}}), reader)).toThrow();
    expect(() => parseCatalog(JSON.stringify({...catalogData(), first_chapter: {id: 1}}), url)).toThrow();
  });

  it.each([0, 1501, -1, 3.5, null, '3'])('rejects invalid total %s', pages => {
    expect(() => parseCatalog(JSON.stringify({...catalogData(), pages}), url)).toThrow();
  });

  it('rejects a foreign or thumbnail cover and unexpected work identity', () => {
    for (const image_url of [image(1), cover.replace('/comics/', '/comics/thumbs/'), cover.replace('/123.', '/456.'),
      cover.replace('cdn.nhentai.com', 'evil.test'), cover.replace('https://', 'https://user@')])
      expect(() => parseCatalog(JSON.stringify({...catalogData(), image_url}), url)).toThrow();
    expect(() => parseCatalog(JSON.stringify({...catalogData(), slug: 'other'}), url)).toThrow();
    expect(() => parseCatalog(JSON.stringify({...catalogData(), title: ''}), url)).toThrow();
  });

  it('rejects challenges, wrong operations and pages outside the declared total', () => {
    expect(() => parseCatalog('<title>Just a moment...</title>', url)).toThrow('验证');
    expect(() => parsePages('{}', reader)).toThrow();
    expect(() => parseCatalog(JSON.stringify(catalogData()), reader)).toThrow();
    expect(() => parsePages(JSON.stringify(pagesData()), url)).toThrow();
    expect(() => parsePages(JSON.stringify(pagesData()), url + '/reader/4')).toThrow();
  });

  it('uses one bounded API call per operation with a same-origin catalog referer', async () => {
    const request = vi.fn().mockResolvedValueOnce(JSON.stringify(catalogData())).mockResolvedValueOnce(JSON.stringify(pagesData()));
    await network.catalog(url, {request}); await network.pages(reader, {request});
    expect(request.mock.calls).toEqual([
      [`https://nhentai.com/api/comics/${slug}?lang=es&nsfw=false`, {referer: url}],
      [`https://nhentai.com/api/comics/${slug}/images?lang=es&nsfw=false`, {referer: url}],
    ]);
  });

  it('does not fetch after cancellation, return late responses, retry failures or mutate previous state', async () => {
    const previous = parseCatalog(JSON.stringify(catalogData()), url), before = structuredClone(previous);
    const controller = new AbortController(); controller.abort(Error('cancelled'));
    const request = vi.fn();
    await expect(network.catalog(url, {request, signal: controller.signal, previous})).rejects.toThrow('cancelled');
    expect(request).not.toHaveBeenCalled();
    const late = new AbortController();
    await expect(network.pages(reader, {signal: late.signal, request: async () => {
      late.abort(Error('navigation')); return JSON.stringify(pagesData());
    }})).rejects.toThrow('navigation');
    request.mockRejectedValue(Error('unavailable'));
    await expect(network.catalog(url, {request, previous})).rejects.toThrow('unavailable');
    expect(request).toHaveBeenCalledTimes(1); expect(previous).toEqual(before);
  });
});
