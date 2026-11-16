import {afterEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {definition, mangagoLocation, chapterUrl} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {decodeImageList, imageUrl} from '../protocol';
import {image} from '../image';
import {imageProcessing, tileOrder} from '../tiles';
import {parseSearch, searchUrl} from '../search';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {catalogHtml, cover, encrypt, origin, plain, reader, readerHtml, routes, scrambled, searchHtml, title, url, work} from './fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('Mangago source identity and catalogs', () => {
  it.each([
    ['uu/br_chapter-42/pg-9/', 'uu/br_chapter-42/pg-1/'],
    ['mr/mk_v-8-chapter-2.5/pg-2/', 'mr/mk_v-8-chapter-2.5/pg-1/'],
    ['mdx/d_chapter-0/2/', 'mdx/d_chapter-0/'],
    ['mdx/br_chapter-42/pg-2/', 'mdx/br_chapter-42/pg-1/'],
    ['mr/fixture-work/1/2/', 'mr/fixture-work/1/'],
    ['mr/fixture-work/1/pg-2/', 'mr/fixture-work/1/'],
    ['mr/vTBD/c100.5/pg-2/', 'mr/vTBD/c100.5/pg-1/'],
  ])('normalizes %s while retaining its chapter identity', (path, canonical) => {
    const first = definition.identify(new URL(url + path + '?from=web#page=9'))!;
    expect(first.kind).toBe('reader'); expect(first.catalog?.url).toBe(url);
    expect(chapterUrl(mangagoLocation(new URL(url + path))!)).toBe(url + canonical);
    expect(definition.identify(new URL(url + canonical))?.pageKey).toBe(first.pageKey);
  });
  it.each(['http://www.mangago.me', 'https://mangago.me', 'https://www.mangago.me.evil.test', 'https://www.mangago.me:444', 'https://u:p@www.mangago.me'])
    ('rejects unclaimed origin %s', host => expect(definition.identify(new URL(host + '/read-manga/fixture_work/'))).toBeNull());
  it.each(['uu/br_chapter-42/pg-0/', 'uu/br_chapter-42/pg-1501/', 'uu/br_chapter-42/extra/', '%2fother/', 'list/'])
    ('does not import malformed route %s', route => expect(definition.identify(new URL(url + route))?.kind).toBe('other'));
  it('imports the complete oldest-first catalog and preserves refresh inputs', async () => {
    const request = vi.fn(async () => catalogHtml());
    const previous = validateCatalog(await network.catalog(url, {request}), [definition]), before = structuredClone(previous);
    expect(request).toHaveBeenCalledExactlyOnceWith(url);
    expect(previous).toMatchObject({complete: true, title, cover: {url: cover}});
    expect(previous.entries.map(e => e.url)).toEqual([...routes].reverse().map(r => url + r));
    expect(previous.groups[0].entryIds).toEqual(previous.entries.map(e => e.id));
    for (const entry of previous.entries) expect(definition.identify(new URL(entry.url))?.pageKey).toBe(entry.id);
    await expect(network.catalog(url, {previous, request: async () => 'Just a moment...'})).rejects.toThrow();
    expect(previous).toEqual(before);
  });
  it.each(['owner', 'duplicate', 'truncated', 'cover', 'start', 'canonical'])
    ('rejects %s catalog evidence', mode => {
      let html = catalogHtml();
      if (mode === 'owner') html = html.replace(url + routes[0], url.replace(work, 'other') + routes[0]);
      if (mode === 'duplicate') html = html.replace(routes[1], routes[0]);
      if (mode === 'truncated') html = html.replace('</table>', '');
      if (mode === 'cover') html = html.replace('i3.mangapicgallery.com', 'evil.test');
      if (mode === 'start') html = html.replace(url + routes[2], reader);
      if (mode === 'canonical') html = html.replace(`href="${url}"`, 'href="https://evil.test/"');
      expect(() => parseCatalog(html, url)).toThrow();
    });
  it('collapses identical directory duplicates without losing reading order', () => {
    const html = catalogHtml(), duplicate = html.match(/<tr>[\s\S]*?<\/tr>/)![0];
    const result = parseCatalog(html.replace(duplicate, duplicate + duplicate), url);
    expect(result.entries.map(e => e.order)).toEqual([0, 1, 2]);
    expect(result.entries.map(e => e.url)).toEqual([...routes].reverse().map(r => url + r));
  });
});
describe('Mangago encrypted page acquisition', () => {
  it('decodes independent AES zero-padded vectors, including a complete block', async () => {
    for (const clear of ['abcdefghijklmnop', plain, [plain, scrambled].join(',')])
      expect(await decodeImageList(encrypt(clear))).toEqual(clear.split(','));
    for (const value of ['', 'not base64', 'AAAA', encrypt(plain).slice(1)]) await expect(decodeImageList(value)).rejects.toThrow();
  });
  it('retains repeated image slots and binds scrambled originals to decoding', async () => {
    const target = reader.replace('/uu/', '/mdx/'), selected = target.replace('pg-1', 'pg-2') + '?from=web#page=2';
    const request = vi.fn(async () => readerHtml(undefined, target));
    const result = validatePages(await network.pages(selected, {request}), definition.identify(new URL(selected))!);
    expect(request).toHaveBeenCalledExactlyOnceWith(target);
    expect(result).toMatchObject({url: selected, discoveryComplete: true, knownTotal: 3, title: title + ' Ch.3'});
    expect(result.items.map(x => x.id)).toEqual(['page-0', 'page-1', 'page-2']);
    expect(result.items[0].resource).toEqual(result.items[2].resource);
    expect(result.items[1].resource).toMatchObject({processing: 'mangago-tiles:e2169a4bfd805e9aa21d3112d498d68c'});
    expect((await parsePages(readerHtml([plain, '2'], reader, 1), reader)).items).toHaveLength(1);
  });
  it('reads the server manifest before its page menu is populated', async () => {
    const html = readerHtml().replace(/(<ul id="dropdown-menu-page">)[\s\S]*?<\/ul>/, '$1</ul>');
    expect(await parsePages(html, reader)).toMatchObject({knownTotal: 3, discoveryComplete: true});
    await expect(parsePages(html.replace('total_pages=3', 'total_pages=1501'), reader)).rejects.toThrow();
    await expect(parsePages(html.replace('total_pages=3', 'total_pages=2'), reader)).rejects.toThrow();
  });
  it.each(['count', 'pager', 'owner', 'identity', 'total', 'cipher', 'foreign', 'trailer'])
    ('fails closed for %s reader evidence', async mode => {
      let html = readerHtml();
      if (mode === 'count') html = readerHtml([plain], reader, 3);
      if (mode === 'pager') html = html.replace('page 2 of 3', 'page 3 of 3');
      if (mode === 'owner') html = html.replace(`id="series" href="${url}"`, `id="series" href="${url.replace(work, 'other')}"`);
      if (mode === 'identity') html = html.replace(`pcurl = "${reader}"`, `pcurl = "${reader.replace('-42', '-43')}"`);
      if (mode === 'total') html = html.replace('total_pages=3', 'total_pages=4');
      if (mode === 'cipher') html = html.replace('var imgsrcs', 'var unrelated');
      if (mode === 'foreign') html = readerHtml([plain.replace(work, 'other')]);
      if (mode === 'trailer') html = readerHtml([plain, '2', 'unexpected'], reader, 1);
      await expect(parsePages(html, reader)).rejects.toThrow();
    });
  it.each(['http:', 'https://evil.test/a.jpg', plain.replace('.com/', '.com.evil.test/'), plain + '#x', plain + '?token=secret', plain.replace('https://', 'https://u:p@')])
    ('rejects invalid inline image %s', value => expect(() => image.decodeInline!(new Blob(), new Headers(), value)).toThrow());
  it('normalizes the source transport marker and refuses script execution', async () => {
    const marked = scrambled.replace('aaaaaa', 'aaaaaaz');
    expect(imageUrl(marked, work)).toBe(scrambled);
    expect((await parsePages(readerHtml() + '<script>throw Error("must stay inert")</script>', reader)).knownTotal).toBe(3);
  });
  it('honors cancellation before requests and after each response', async () => {
    for (const operation of ['catalog', 'pages', 'search'] as const) for (const before of [true, false]) {
      const controller = new AbortController(), request = vi.fn(async () => {controller.abort(); return readerHtml();});
      if (before) controller.abort();
      const context = {request, signal: controller.signal};
      const promise = operation === 'catalog' ? network.catalog(url, context) : operation === 'pages' ? network.pages(reader, context)
        : network.search({siteId: 'mangago', query: 'Fixture'}, context);
      await expect(promise).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(before ? 0 : 1);
    }
  });
});
describe('Mangago image restoration', () => {
  it('ships complete permutations and selects both legacy special mappings', () => {
    const source = readFileSync(new URL('../tiles.ts', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/'([a-f0-9]{32})':/g)].map(m => m[1]);
    expect(keys).toHaveLength(23);
    for (const key of keys) {
      const processing = imageProcessing(scrambled.replace('e2169a4bfd805e9aa21d3112d498d68c', key))!;
      expect(processing).toBe('mangago-tiles:' + key);
      expect([...tileOrder(processing)].sort((a, b) => a - b)).toEqual(Array.from({length: 81}, (_, i) => i));
    }
    expect(imageProcessing(plain)).toBeUndefined(); expect(() => tileOrder('mangago-tiles:__proto__')).toThrow();
  });
  it('moves source tiles to the verified row-major destinations, retains dimensions and closes bitmap', async () => {
    const drawImage = vi.fn(), close = vi.fn(), output = new Blob(['decoded'], {type: 'image/png'});
    const bitmap = {width: 837, height: 1206, close};
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(width: number, height: number) {expect([width, height]).toEqual([837, 1206]);}
      getContext() {return {drawImage};}
      convertToBlob() {return Promise.resolve(output);}
    });
    expect(await image.decodeInline!(new Blob(['source']), new Headers(), scrambled)).toBe(output);
    expect(drawImage).toHaveBeenCalledTimes(81);
    expect(drawImage.mock.calls[0]).toEqual([bitmap, 0, 0, 93, 134, 0, 804, 93, 134]);
    expect(close).toHaveBeenCalledTimes(1);
    const original = new Blob(['plain']); expect(await image.decode!(original, new Headers(), undefined)).toBe(original);
    const controller = new AbortController(); controller.abort();
    await expect(image.decode!(original, new Headers(), imageProcessing(scrambled), controller.signal)).rejects.toThrow();
  });
});
describe('Mangago name search', () => {
  const request = {siteId: 'mangago', query: 'Fixture'};
  it('returns source covers, follows verified pagination and handles explicit empty results', async () => {
    expect(await network.search(request, {request: async () => searchHtml()}))
      .toMatchObject({items: [{catalogId: 'mangago:' + work, catalogUrl: url, title, cover: {url: cover}}], nextCursor: 'page:2'});
    const next = {...request, cursor: 'page:2'};
    expect(new URL(searchUrl(next).url).searchParams.get('page')).toBe('2');
    expect(parseSearch(searchHtml('Fixture', 2), next).nextCursor).toBeUndefined();
    expect(parseSearch(searchHtml('Fixture', 1, 1, true), request)).toEqual({items: []});
    for (const query of ['?acc=fixture-signature&exp=1700000000&4', '?v=1700000000&4']) {
      const signed = cover.replace('?4', query);
      expect(parseSearch(searchHtml().replace(cover, signed), request).items[0].cover?.url).toBe(signed);
    }
  });
  it.each(['echo', 'pager', 'host', 'empty', 'truncated', 'duplicate'])('rejects %s search evidence', mode => {
    let html = searchHtml();
    if (mode === 'echo') html = searchHtml('Other');
    if (mode === 'pager') html = html.replace('page=2', 'page=3');
    if (mode === 'host') html = html.replaceAll(url, 'https://evil.test/read-manga/fixture_work/');
    if (mode === 'empty') html = searchHtml('Fixture', 1, 1, true).replace('Total: 0', '');
    if (mode === 'truncated') html = html.replace('</ul>', '');
    if (mode === 'duplicate') html = html.replace('</ul>', html.match(/<li>[\s\S]*?<\/li>/)![0] + '</ul>');
    expect(() => parseSearch(html, request)).toThrow();
  });
  it('rejects forged cursors and mismatched sites before network requests', () => {
    expect(() => searchUrl({...request, cursor: origin})).toThrow();
    expect(() => searchUrl({...request, siteId: 'other'})).toThrow();
  });
});
