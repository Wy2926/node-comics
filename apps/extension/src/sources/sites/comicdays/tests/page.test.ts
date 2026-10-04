import {afterEach, describe, expect, it, vi} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {definitions} from '../../../registry/definitions';
import {pageFactories} from '../../../registry/pages';
import {definition} from '../definition';
import {parsePages} from '../pages';
import {image} from '../image';
import {pageUrl} from '../urls';
import {episodeUrl, imageUrl, readerData} from './fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('Comic DAYS engine binding', () => {
  it('claims only its own HTTPS host and keeps catalog/import separate from GigaViewer inline recognition', () => {
    expect(definitions.find(d => d.id === 'comicdays')).toBe(definition);
    expect(definition.identify(new URL(episodeUrl() + '#'))).toMatchObject({sourceId: 'comicdays', kind: 'reader', pageKey: 'comicdays:episode:11'});
    expect(definition.capabilities).toEqual({importable: true, pages: true, inline: true, catalog: true, completePageList: true});
    expect(definition.inlineRecognition).toBeUndefined();
    expect(pageFactories.comicdays).toBeTypeOf('function');
    expect(definition.embeddedEntry).toBe('floating');
    expect(definition.catalogSync).toEqual({intervalMinutes: 720});
    expect(definition.sites).toMatchObject([{id: 'comicdays', primaryLanguages: ['ja'], contentTags: ['manga']}]);
    for (const url of ['http://comic-days.com/episode/11', 'https://comic-days.com.evil.test/episode/11',
      'https://x@comic-days.com/episode/11', 'https://comic-days.com:8443/episode/11']) expect(definition.identify(new URL(url))).toBeNull();
    for (const path of ['/', '/episode/0', '/episode/11.json', '/episode/no', '/episode/11/extra'])
      expect(definition.identify(new URL('https://comic-days.com' + path))?.kind).toBe('other');
  });
  it('uses the common engine schema while checking episode, permalink and CDN ownership', () => {
    const snapshot = parsePages(readerData(), episodeUrl());
    expect(snapshot.items.map(p => [p.id, p.order])).toEqual([['page-0', 0], ['page-2', 1]]);
    expect(snapshot.items[0].resource).toEqual({kind: 'http', url: imageUrl, processing: 'gigaviewer-baku:1125:1600'});
    expect(() => parsePages(readerData('12'), episodeUrl())).toThrow();
    const wrong = readerData(); wrong.readableProduct.permalink = 'https://www.sunday-webry.com/episode/11';
    expect(() => parsePages(wrong, episodeUrl())).toThrow();
    for (const url of ['https://cdn-img.comic-days.com.evil.test/public/page/2/900-abcdef',
      'https://cdn-img.www.sunday-webry.com/public/page/2/900-abcdef',
      'https://x@cdn-img.comic-days.com/public/page/2/900-abcdef',
      'http://cdn-img.comic-days.com/public/page/2/900-abcdef', 'https://cdn-img.comic-days.com/private/page/2/900-abcdef'])
      expect(() => pageUrl(url)).toThrow();
  });
  it('maps tainted canvases to verified HTTP originals without reading pixels, and invalidates stale bindings', async () => {
    let data: unknown = readerData();
    const first = {width: 1125, height: 1600, isConnected: true,
      toBlob: vi.fn(() => {throw Error('SecurityError');})};
    const second = {...first, width: 0, height: 0};
    let areas = [first, second].map(element => ({querySelector: () => element}));
    const doc = {title: 'chapter', querySelector: () => ({getAttribute: () => JSON.stringify(data)}),
      querySelectorAll: () => areas} as unknown as Document;
    const navigation = createSourceNavigation(doc), session = navigation.get(episodeUrl()).session;
    expect(session.inlineTargets().map(t => t.url)).toEqual([imageUrl]);
    expect(first.toBlob).not.toHaveBeenCalled();
    Object.assign(second, {width: 1125, height: 1600});
    const targets = session.inlineTargets();
    expect(targets).toHaveLength(2); expect(targets[0].key).not.toBe(targets[1].key);
    expect(targets.every(t => !t.read)).toBe(true);
    areas = areas.slice(0, 1); expect(session.inlineTargets()).toEqual([]);
    areas = [first, second].map(element => ({querySelector: () => element}));
    data = {}; expect(session.inlineTargets()).toEqual([]);
    data = readerData('12'); expect(session.inlineTargets()).toEqual([]);
    data = readerData(); expect(session.inlineTargets()).toHaveLength(2);
    expect(session.snapshot().items).toEqual([]);
    expect(await session.discoverPages()).toEqual({status: 'unsupported', code: 'SOURCE_PAGE_UNSUPPORTED'});
    navigation.get(episodeUrl('12')); expect(() => session.inlineTargets()).toThrow(); navigation.dispose();
  });
  it.each(['mode', 'cdn', 'dimensions'])('does not fall back to generic images for invalid %s metadata', issue => {
    const data = readerData();
    if (issue === 'mode') data.readableProduct.pageStructure.choJuGiga = 'future-format';
    if (issue === 'cdn') data.readableProduct.pageStructure.pages[0].src = 'https://foreign.example/page';
    if (issue === 'dimensions') data.readableProduct.pageStructure.pages[0].width = 0;
    const doc = {title: 'chapter', querySelector: () => ({getAttribute: () => JSON.stringify(data)}),
      querySelectorAll: vi.fn(() => [])} as unknown as Document;
    const navigation = createSourceNavigation(doc);
    expect(navigation.get(episodeUrl()).session.inlineTargets()).toEqual([]);
    expect(doc.querySelectorAll).not.toHaveBeenCalled();
    navigation.dispose();
  });
  it('uses the shared decoder for HTTP page recipes and inline originals, rejecting foreign recipes and URLs', async () => {
    const bitmap = {width: 1125, height: 1600, close: vi.fn()}, drawImage = vi.fn(), output = new Blob(['restored']);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.stubGlobal('OffscreenCanvas', class {getContext() {return {drawImage};} async convertToBlob() {return output;}});
    expect(await image.decode!(new Blob(), new Headers(), 'gigaviewer-baku:1125:1600')).toBe(output);
    expect(drawImage).toHaveBeenCalledTimes(17); expect(bitmap.close).toHaveBeenCalledOnce();
    expect(await image.decodeInline!(new Blob(), new Headers(), imageUrl)).toBe(output);
    expect(drawImage).toHaveBeenCalledTimes(34); expect(bitmap.close).toHaveBeenCalledTimes(2);
    await expect(image.decodeInline!(new Blob(), new Headers(), 'https://evil.test/image')).rejects.toThrow();
    await expect(image.decodeInline!(new Blob(), new Headers(), 'https://cdn-img.www.sunday-webry.com/public/page/2/900-abcdef')).rejects.toThrow();
    await expect(image.decode!(new Blob(), new Headers(), 'webry-baku:1125:1600')).rejects.toThrow();
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
  });
});
