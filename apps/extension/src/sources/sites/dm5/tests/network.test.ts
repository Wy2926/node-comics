import 'fake-indexeddb/auto';
import {readFileSync} from 'node:fs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {definition} from '../definition';
import {parseCatalog} from '../catalog';
import {network} from '../network';
import {imageUrls, unpackImages} from '../protocol';
import {image} from '../image';
import {validateSourceCatalog} from '../../..';
import {catalog} from '../../../../comics/repositories';
import {importCatalog, importManifest} from '../../../../comics/application/import-service';
import {applyCatalogRefresh} from '../../../../comics/application/catalog-service';
import {readSourceCatalog} from '../../../runtime/catalog-reader';
import {discoverEntry} from '../../../runtime/client';

const url = 'https://www.dm5.com/manhua-fixture/';
const reader = (bound: boolean) => `https://www.dm5.com/m1836194/${bound ? '#nodelane-dm5=fixture' : ''}`;
const packed = readFileSync(new URL('./images.txt', import.meta.url), 'utf8');
function html(ids = [1836194, 1836195], sort = 1) {
  return `<script>var DM5_COMIC_MID=98761;var DM5_COMIC_URL='/manhua-fixture/';var DM5_COMIC_MNAME='测试作品';var DM5_COMIC_SORT=${sort};</script>
    <div class="detail-list-title"><a onclick="titleSelect(this, 'detail-list-select', 'detail-list-select-1');">连载<span>（${ids.length}）</span></a></div>
    <div id="chapterlistload"><ul id="detail-list-select-1">${ids.map((id, i) => `<li><a href="/m${id}/">第${i+1}话 <span>（2P）</span></a></li>`).join('')}</ul></div>`;
}
const readerHtml = `<script>var DM5_CID=1836194;var DM5_CURL='/m1836194/';var DM5_ISNEED='False';var DM5_MID=98761;var DM5_IMAGE_COUNT=2;var DM5_VIEWSIGN_DT='2026-01-01 00:00:00';var DM5_VIEWSIGN='fixture';var DM5_CTITLE='第一话';</script><a class="back" href="/manhua-fixture/">返回</a>`;
const request = vi.fn(async(target: string, options?: {referer: string}) => {
  if (target.includes('chapterfun.ashx')) {expect(options?.referer).toBe('https://www.dm5.com/m1836194/'); return packed;}
  return target.includes('/manhua-') ? html() : readerHtml;
});
afterEach(() => {vi.unstubAllGlobals();vi.clearAllMocks();});
describe('DM5 HTTP adapter', () => {
  it('takes only the main cover, ignoring backgrounds and recommended thumbnails', () => {
    const artwork='<img class="banner_detail_bg" src="/blur.jpg"><div class="banner_detail_form"><div class="cover"><img src="https://mhfm5tel.cdndm5.com/1/98761/cover.jpg?width=450&amp;height=600"></div></div><img src="/recommendation.jpg">';
    const source=validateSourceCatalog(parseCatalog(artwork+html(),url));
    expect(source.cover).toEqual({url:'https://mhfm5tel.cdndm5.com/1/98761/cover.jpg?width=450&height=600'});
    expect(source.entries).toHaveLength(2);
    expect(image.coverHeaders).toEqual({referer:'https://www.dm5.com/'});
    expect(parseCatalog(html(),url).cover).toBeUndefined();
  });
  it('claims exact HTTPS hosts, chapters, source binding and stable page identities', () => {
    expect(definition.identify(new URL(url))?.catalog?.key).toBe('dm5:fixture');
    expect(definition.identify(new URL(reader(true)))?.catalog?.key).toBe('dm5:fixture');
    expect(definition.identify(new URL(reader(false)))?.pageKey).toBe('dm5:chapter:1836194');
    expect(definition.identify(new URL('https://www.dm5.com/m1836194-p2/#ipg2'))?.pageKey).toBe('dm5:chapter:1836194');
    for (const value of ['https://www.dm5.com.evil.test/manhua-fixture/', 'http://www.dm5.com/manhua-fixture/', 'https://u@www.dm5.com/manhua-fixture/', 'https://www.dm5.com:8443/manhua-fixture/']) expect(definition.identify(new URL(value))).toBeNull();
    expect(definition.identify(new URL('https://www.dm5.com/m1836194/#nodelane-dm5=bad%2Fpath'))?.kind).toBe('other');
    expect(definition.installation.requiredOrigins).toEqual([]); expect(definition.catalogSync?.intervalMinutes).toBe(720);
  });
  it('checks advertised counts and preserves source groups and ascending reading order', () => {
    const source = validateSourceCatalog(parseCatalog(html([1836195, 1836194], 2), url));
    expect(source.entries.map(e => e.remoteId)).toEqual(['1836194', '1836195']);
    expect(source.entries[0].title).toBe('第2话');
    expect(source.groups[0]).toMatchObject({title: '连载', complete: true});
    expect(source.entries[0].rawTypes).toEqual(['连载']);
    expect(source.entries[0].url).toBe(reader(true));
    const altered = structuredClone(source); altered.entries[0].url = reader(false);
    expect(() => validateSourceCatalog(altered)).toThrow();
  });
  it.each(['missing', 'duplicate', 'foreign', 'wrong-comic', 'no-catalog'])('rejects %s catalogs before publishing any update', mode => {
    let value = html();
    if (mode === 'missing') value = value.replace('（2）', '（3）');
    if (mode === 'duplicate') value = html([1836194, 1836194]);
    if (mode === 'foreign') value = value.replace('href="/m1836194/"', 'href="https://evil.test/m1836194/"');
    if (mode === 'wrong-comic') value = value.replace("'/manhua-fixture/'", "'/manhua-another/'");
    if (mode === 'no-catalog') value = value.replace('detail-list-title', 'removed-catalog');
    expect(() => parseCatalog(value, url)).toThrow();
  });
  it('decodes observed packed data without eval and checks image ownership', () => {
    const urls = imageUrls(packed, '1836194', 98761);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]).pathname).toBe('/99/98761/1836194/1_8334.jpg');
    expect(new URL(urls[1]).pathname).toBe('/99/98761/1836194/2_7876.jpg');
    expect(typeof image.headers === 'function' && image.headers(urls[0])).toEqual({referer: 'https://www.dm5.com/m1836194/'});
    expect(() => imageUrls(packed, '1', 98761)).toThrow('归属');
    expect(() => imageUrls(packed, '1836194', 1)).toThrow('归属');
    expect(() => unpackImages('globalThis.executed=true')).toThrow();
    expect(() => unpackImages(packed + ';globalThis.executed=true')).toThrow();
    expect(() => unpackImages(packed.replace(',30,30,', ',63,30,'))).toThrow();
  });
  it('reads complete page slots, including duplicate URLs, and rejects cross-comic bindings', async () => {
    const snapshot = await network.pages!(reader(true), {request});
    expect(snapshot).toMatchObject({knownTotal: 2, discoveryComplete: true});
    expect(snapshot.items.map(i => [i.id, i.order])).toEqual([['page-0', 0], ['page-1', 1]]);
    const duplicate = packed.replace('2_7876', '1_8334');
    const repeated = await network.pages!(reader(true), {request: async u => u.includes('chapterfun') ? duplicate : readerHtml});
    expect(repeated.items[0].resource).toEqual(repeated.items[1].resource); expect(repeated.items[0].id).not.toBe(repeated.items[1].id);
    await expect(network.pages!(reader(true).replace('=fixture', '=other'), {request})).rejects.toThrow('不属于');
    await expect(network.pages!(reader(true), {request: async () => readerHtml.replace("'False'", "'True'")})).rejects.toThrow('购买');
  });
  it('rejects cancellation and empty/partial image responses without returning partial manifests', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(network.pages!(reader(true), {request, signal: controller.signal})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(network.pages!(reader(true), {request: async u => u.includes('chapterfun') ? '' : readerHtml})).rejects.toThrow();
    await expect(network.pages!(reader(true), {request: async u => u.includes('chapterfun') ? packed : readerHtml.replace('DM5_IMAGE_COUNT=2', 'DM5_IMAGE_COUNT=1')})).rejects.toThrow('不完整');
  });
  it('publishes updates idempotently and preserves materialized pages, positions and the old catalog on failure', async () => {
    const first = parseCatalog(html([1836194]), url), comic = await importCatalog(first);
    const snapshot = await network.pages!(reader(true), {request});
    const imported = await importManifest({...snapshot, id: 'dm5-test', revision: 1,
      items: snapshot.items.map(({resource, ...item}) => ({...item, url: resource.kind === 'http' ? resource.url : ''}))});
    const entry = (await catalog.get('entries', imported.id))!, pages = await catalog.listPages(entry.contentId);
    expect((await catalog.listEntries(comic.id)).length).toBe(1);
    expect(entry.sourceEntryId).toBe(first.entries[0].id);
    const position = {id: entry.id, entryId: entry.id, comicId: comic.id, contentId: entry.contentId, pageId: pages[0].pageId, relativeOffset: .4, updatedAt: 1};
    await catalog.savePosition(position);
    const next = parseCatalog(html(), url); await applyCatalogRefresh(comic.id, 1, next); await applyCatalogRefresh(comic.id, 1, next);
    expect((await catalog.get('comics', comic.id))?.catalogUpdates?.count).toBe(1);
    expect(await catalog.get('positions', entry.id)).toEqual(position); expect(await catalog.listPages(entry.contentId)).toEqual(pages);
    await expect(network.catalog!(url, {previous: next, request: async () => html().replace('（2）', '（3）')})).rejects.toThrow();
    expect((await catalog.get('catalogs', next.id))?.entries).toEqual(next.entries);
  });
  it('uses the common network path with zero source tabs', async () => {
    const storage: Record<string, unknown> = {}, tabs = {create: vi.fn(() => {throw Error('must not create a tab');})};
    vi.stubGlobal('chrome', {runtime: {id: 'fixture', getURL: () => 'chrome-extension://fixture/'}, tabs,
      storage: {local: {get: async (key: string) => ({[key]: storage[key]}), set: async (value: object) => Object.assign(storage, value)}}});
    vi.stubGlobal('fetch', vi.fn(async (target: string) => new Response(await request(String(target)))));
    const source = await readSourceCatalog(url); expect(source.entries).toHaveLength(2);
    // Request headers use the separately tested DNR path; assert transport selection by
    // rejecting there, before any source tab could be created.
    await expect(discoverEntry(source, source.entries[0].id, new AbortController().signal, vi.fn())).rejects.toThrow('请求规则');
    expect(tabs.create).not.toHaveBeenCalled();
  });
});
