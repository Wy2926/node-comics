import {describe, expect, it, vi} from 'vitest';
import {definition, catalogUrl, location, origin} from '../definition';
import {network, parseCatalog, parsePages, chapterUrl} from '../network';
import {asset, embedded} from '../protocol';
import {parseSearch, searchUrl} from '../search';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';

const work = {id: 42, slug: 'fixture-work', title: 'Fixture Work', chapter_count: 3,
  default_thumbnail: 'https://cdn1.comicknew.pictures/fixture-work/covers/abcd.webp'};
const rows = [
  {id: 1, hid: 'First', chap: '1', vol: '1', title: null, lang: 'en', group_name: ['Group A']},
  {id: 2, hid: 'Second', chap: '1', vol: '1', title: 'Beginning', lang: 'pt-br', group_name: ['Group B']},
  {id: 3, hid: 'Third', chap: '1.5', vol: '1', title: 'Extra', lang: 'en', group_name: []},
];
const url = catalogUrl(work.slug), reader = chapterUrl(work.slug, rows[0]);
const image = 'https://cdn1.comicknew.pictures/fixture-work/1_1/en/abcdef/0.webp';
const chapter = {...rows[0], external_type: null, comic: work, images: [{url: image, w: 800, h: 1200}, {url: image, w: 800, h: 1200}]};
const script = (id: string, value: unknown) => `<script type="application/json" id="${id}">${JSON.stringify(value)}</script>`;
const pageHtml = (value = chapter) => script('sv-data', {chapter: value});
const batch = (page: number, entries: unknown[], overrides = {}) => JSON.stringify({data: entries,
  pagination: {current_page: page, total: 3, per_page: 2, last_page: 2, ...overrides}});
function context() {
  return {request: vi.fn(async (target: string) => target === url ? script('comic-data', work) :
    target.endsWith('page=1') ? batch(1, rows.slice(0, 2)) : batch(2, rows.slice(2)))};
}

describe('ComicK ownership and metadata', () => {
  it('claims only the configured host, preserves chapter identity and parent, and explicitly reuses generic inline recognition', () => {
    expect(definition.identify(new URL(reader + '?page=2#images'))).toMatchObject({kind: 'reader', pageKey: 'comickz:chapter:First', catalog: {key: 'comickz:fixture-work', url}});
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'catalog', pageKey: 'comickz:fixture-work'});
    expect(definition.identify(new URL(reader.replace('First-chapter', 'A_b-C-chapter')))?.pageKey).toBe('comickz:chapter:A_b-C');
    expect(definition).toMatchObject({inlineRecognition: 'generic', embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720},
      capabilities: {importable: true, pages: true, catalog: true, completePageList: true, inline: true}});
    expect(definition.installation.optionalContentMatches).toEqual([origin + '/*']);
    expect(definition.sites![0]).toMatchObject({url: origin + '/home', search: true, adaptedOn: '2026-10-09', primaryLanguages: ['en']});
    expect(definition.sites![0].isFree).toBeUndefined();
  });
  it.each(['https://comickz.co.uk.evil.test', 'http://comickz.co.uk', 'ftp://comickz.co.uk', 'https://comickz.co.uk:444', 'https://u:p@comickz.co.uk', 'https://comick.io'])
    ('rejects unrelated origin %s', host => expect(definition.identify(new URL(host + '/comic/fixture-work'))).toBeNull());
  it.each(['/comic/', '/comic/%66ixture-work', '/comic/fixture-work/extra', '/comic/fixture-work/First-chapter-1-en/extra', '/search?q=fixture'])
    ('does not import unsupported path %s', path => expect(definition.identify(new URL(origin + path))?.kind).toBe('other'));
  it('does not execute scripts or accept duplicate embedded identities', () => {
    expect(() => embedded('<script id="sv-data">alert(1)</script>', 'sv-data')).toThrow();
    expect(() => embedded(pageHtml() + pageHtml(), 'sv-data')).toThrow();
    expect(() => embedded(script('sv-data', null), 'sv-data')).toThrow();
  });
});
describe('ComicK complete multilingual catalog', () => {
  it('reads every ascending page without a language filter and keeps releases, volume labels and shared slots', async () => {
    const ctx = context(), catalog = validateCatalog(await network.catalog(url, ctx), [definition]);
    expect(ctx.request.mock.calls.map(call => call[0])).toEqual([url, origin + '/api/comics/fixture-work/chapter-list?chapOrder=asc&page=1', origin + '/api/comics/fixture-work/chapter-list?chapOrder=asc&page=2']);
    expect(catalog.entries).toHaveLength(3);
    expect(catalog.entries.map(e => e.order)).toEqual([0, 0, 2]);
    expect(catalog.entries.map(e => e.contentLanguage)).toEqual(['en', 'pt-BR', 'en']);
    expect(catalog.entries[0].readingSlotId).toBe(catalog.entries[1].readingSlotId);
    expect(catalog.entries[1].rawTypes).toEqual(['Group B']);
    expect(catalog.groups[0].entryIds).toHaveLength(3);
    expect(catalog.cover?.url).toBe(work.default_thumbnail);
    expect(catalog.complete).toBe(true);
  });
  it('does not merge missing chapter numbers or identical chapter labels across volumes', () => {
    const catalog = parseCatalog(work, [rows[0], {...rows[1], vol: '2'}, {...rows[2], chap: null}], url);
    expect(catalog.entries[0].readingSlotId).not.toBe(catalog.entries[1].readingSlotId);
    expect(catalog.entries[0].sequenceId).not.toBe(catalog.entries[1].sequenceId);
    expect(catalog.entries[2].readingSlotId).toBeUndefined();
  });
  it.each(['short', 'total', 'page', 'size', 'last', 'duplicate', 'owner'])('fails closed for %s catalog corruption', async mode => {
    const ctx = context();
    ctx.request.mockImplementation(async target => {
      if (target === url) return script('comic-data', {...work, ...(mode === 'owner' ? {slug: 'other'} : {})});
      if (target.endsWith('page=1')) return batch(1, rows.slice(0, 2));
      return batch(2, mode === 'short' ? [] : mode === 'duplicate' ? [rows[0]] : rows.slice(2),
        mode === 'total' ? {total: 4} : mode === 'page' ? {current_page: 1} : mode === 'size' ? {per_page: 1} : mode === 'last' ? {last_page: 3} : {});
    });
    await expect(network.catalog(url, ctx)).rejects.toThrow();
  });
  it('rejects duplicate numeric IDs even if the public chapter token differs', () => {
    expect(() => parseCatalog(work, [rows[0], {...rows[1], id: 1}, rows[2]], url)).toThrow();
  });
  it('does not reuse old data after a failure and never modifies previous', async () => {
    const previous = parseCatalog(work, rows, url), before = structuredClone(previous), ctx = context();
    ctx.request.mockRejectedValue(Error('HTTP 503'));
    await expect(network.catalog(url, {...ctx, previous})).rejects.toThrow('503');
    expect(previous).toEqual(before);
  });
  it('honors cancellation before requests and between pagination responses', async () => {
    const controller = new AbortController(), ctx = context(); controller.abort();
    await expect(network.catalog(url, {...ctx, signal: controller.signal})).rejects.toThrow();
    expect(ctx.request).not.toHaveBeenCalled();
    const next = new AbortController();
    ctx.request.mockImplementation(async () => {next.abort(); return script('comic-data', work);});
    await expect(network.catalog(url, {...ctx, signal: next.signal})).rejects.toThrow();
    expect(ctx.request).toHaveBeenCalledTimes(1);
  });
  it('bounds catalog concurrency to three requests and retains source page order', async () => {
    const entries = Array.from({length: 10}, (_, i) => ({...rows[0], id: i + 1, hid: 'H' + i, chap: String(i + 1)}));
    let active = 0, peak = 0;
    const ctx = {request: vi.fn(async (target: string) => {
      if (target === url) return script('comic-data', {...work, chapter_count: 10});
      const page = Number(new URL(target).searchParams.get('page'));
      active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
      return batch(page, entries.slice((page - 1) * 2, page * 2), {total: 10, last_page: 5});
    })};
    const result = validateCatalog(await network.catalog(url, ctx), [definition]);
    expect(peak).toBe(3); expect(result.entries.map(e => e.remoteId)).toEqual(entries.map(e => e.hid));
  });
});
describe('ComicK chapter pages', () => {
  it('uses the complete ordered JSON list and retains separate slots for duplicate images', () => {
    const pages = validatePages(parsePages(pageHtml(), reader), definition.identify(new URL(reader))!);
    expect(pages.knownTotal).toBe(2); expect(pages.discoveryComplete).toBe(true);
    expect(pages.items.map(p => [p.id, p.order])).toEqual([['page-0', 0], ['page-1', 1]]);
    expect(asset(image.replace('/1_1/', '/1_1.0/'), 'fixture-work', '1_1/en')).toContain('/1_1.0/');
  });
  it.each(['work', 'hid', 'chap', 'lang', 'external', 'empty', 'size'])('rejects %s mismatch', mode => {
    const value = structuredClone(chapter);
    if (mode === 'work') value.comic.slug = 'other';
    if (mode === 'hid') value.hid = 'Other';
    if (mode === 'chap') value.chap = '2';
    if (mode === 'lang') value.lang = 'fr';
    if (mode === 'external') Object.assign(value, {external_type: 'external'});
    if (mode === 'empty') value.images = [];
    if (mode === 'size') value.images[0].w = -1;
    expect(() => parsePages(pageHtml(value), reader)).toThrow();
  });
  it.each([image.replace('/fixture-work/', '/other/'), image.replace('/1_1/', '/1_2/'), image.replace('/en/', '/fr/'), image.replace('.pictures/', '.pictures.evil.test/'), image.replace('https:', 'http:'), image.replace('https://', 'https://u:p@'), image + '?token=secret', image + '#page', image.replace('.webp', '.html')])
    ('rejects foreign image %s', url => expect(() => asset(url, 'fixture-work', '1_1/en')).toThrow());
  it('does not fetch non-reader routes and strips UI parameters from source requests', async () => {
    const ctx = {request: vi.fn(async () => pageHtml())};
    await expect(network.pages(url, ctx)).rejects.toThrow(); expect(ctx.request).not.toHaveBeenCalled();
    await network.pages(reader + '?page=2#images', ctx); expect(ctx.request).toHaveBeenCalledWith(reader);
    expect(location(new URL(reader))?.hid).toBe('First');
  });
});
describe('ComicK name search', () => {
  const input = {siteId: 'comickz', query: 'Fixture'};
  const body = (next: string | null = 'opaque-token') => JSON.stringify({data: [{...work, lang: 'ja', lang_list: '{en,pt-br,es-419}'}], next_cursor: next});
  it('uses explicit available languages, a dedicated cover and query-bound opaque pagination', () => {
    const result = parseSearch(body(), input);
    expect(result.items[0].contentLanguages).toEqual(['en', 'pt-BR', 'es-419']);
    expect(result.items[0].catalogId).toBe('comickz:fixture-work');
    expect(searchUrl({...input, cursor: result.nextCursor})).toBe(origin + '/api/search?q=Fixture&cursor=opaque-token');
    expect(parseSearch(body(null), input).nextCursor).toBeUndefined();
    expect(() => searchUrl({...input, query: 'Other', cursor: result.nextCursor})).toThrow();
    expect(parseSearch(body().replace('cdn1.', 'cdn2.'), input).items[0].cover?.url).toContain('cdn2.');
    expect(parseSearch(body('new-encrypted-token'), {...input, cursor: result.nextCursor})).toEqual({items: []});
  });
  it('rejects forged cursors, duplicate candidates and invalid languages', () => {
    expect(() => searchUrl({...input, cursor: 'https://evil.test'})).toThrow();
    expect(() => searchUrl({...input, siteId: 'other'})).toThrow();
    expect(() => parseSearch(JSON.stringify({data: [work, work]}), input)).toThrow();
    expect(() => parseSearch(JSON.stringify({data: [{...work, lang_list: '{unknown_language}'}]}), input)).toThrow();
    expect(parseSearch(JSON.stringify({data: [work], next_cursor: null}), input).items[0].contentLanguages).toBeUndefined();
  });
});
