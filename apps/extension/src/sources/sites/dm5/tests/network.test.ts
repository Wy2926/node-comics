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
const accessKey = 'a'.repeat(32);
function imageResponse(paths: string[], prefix = 'https://images.cdndm5.com/99/98761/1836194') {
  const program = `var cid=1836194;var key='${accessKey}';var pix=${JSON.stringify(prefix)};var pvalue=${JSON.stringify(paths)};for(var i=0;i<pvalue.length;i++){pvalue[i]=pix+pvalue[i]+'?cid=1836194&key=${accessKey}'};`;
  return `eval(function(p,a,c,k,e,d){}(${JSON.stringify(program)},2,1,''.split('|'),0,{}))`;
}
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
  it('resolves bare chapters through the same validated reader identity without requesting images', async () => {
    const read=vi.fn(async()=>readerHtml);
    expect(await network.resolveCatalog!(reader(false),{request:read})).toBe(url);
    expect(read).toHaveBeenCalledExactlyOnceWith(reader(false));
    await expect(network.resolveCatalog!(reader(true).replace('=fixture','=foreign'),{request:read})).rejects.toThrow();
    await expect(network.resolveCatalog!(reader(false),{request:async()=>readerHtml.replace('DM5_CID=1836194','DM5_CID=1')})).rejects.toThrow();
    const controller=new AbortController();read.mockImplementationOnce(async()=>{controller.abort();return readerHtml;});
    await expect(network.resolveCatalog!(reader(false),{request:read,signal:controller.signal})).rejects.toThrow();
    read.mockClear();await expect(network.resolveCatalog!(reader(false),{request:read,signal:controller.signal})).rejects.toThrow();expect(read).not.toHaveBeenCalled();
  });
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
    const urls = imageUrls(packed, '1836194');
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]).pathname).toBe('/99/98761/1836194/1_8334.jpg');
    expect(new URL(urls[1]).pathname).toBe('/99/98761/1836194/2_7876.jpg');
    expect(typeof image.headers === 'function' && image.headers(urls[0])).toEqual({referer: 'https://www.dm5.com/m1836194/'});
    expect(() => imageUrls(packed, '1')).toThrow('归属');
    expect(() => unpackImages('globalThis.executed=true')).toThrow();
    expect(() => unpackImages(packed + ';globalThis.executed=true')).toThrow();
    expect(() => unpackImages(packed.replace(',30,30,', ',63,30,'))).toThrow();
  });
  it('accepts DM5 reused storage paths and uses the signed current chapter as Referer', () => {
    const urls = imageUrls(imageResponse(['/18.jpg'], 'https://images.cdndm5.com/zszj/21/20802/225202'), '1836194');
    expect(new URL(urls[0]).pathname).toBe('/zszj/21/20802/225202/18.jpg');
    expect(typeof image.headers === 'function' && image.headers(urls[0])).toEqual({referer: 'https://www.dm5.com/m1836194/'});
    for (const url of [
      `https://images.cdndm5.com/zszj/21/20802/225202/18.jpg?cid=123&key=${accessKey}`,
      `https://images.cdndm5.com/99/98761/1836194/18.jpg?cid=1836194&cid=123&key=${accessKey}`,
      `https://images.cdndm5.com/99/98761/1836194/18.jpg?cid=1836194&key=${'b'.repeat(32)}`,
      `https://images.cdndm5.com.evil.test/99/98761/1836194/18.jpg?cid=1836194&key=${accessKey}`,
    ]) expect(() => imageUrls(imageResponse([url]), '1836194')).toThrow();
  });
  it('advances through variable-sized batches without missing or renumbering page slots', async () => {
    const requested: number[] = [];
    const snapshot = await network.pages!(reader(true), {request: async target => {
      if (!target.includes('chapterfun')) return readerHtml.replace('DM5_IMAGE_COUNT=2', 'DM5_IMAGE_COUNT=6');
      const page = Number(new URL(target).searchParams.get('page')); requested.push(page);
      return imageResponse((page === 1 ? [1, 2, 3] : page === 4 ? [4] : [5, 6]).map(n => `/${n}.jpg`));
    }});
    expect(requested).toEqual([1, 4, 5]);
    expect(snapshot.knownTotal).toBe(6);
    expect(snapshot.items.map(item => [item.id, item.order, item.resource.kind === 'http' && new URL(item.resource.url).pathname.split('/').at(-1)]))
      .toEqual(Array.from({length: 6}, (_, n) => ['page-' + n, n, `${n + 1}.jpg`]));
  });
  it.each(['', imageResponse([])])('retries a temporary empty list and preserves already discovered pages (%#)', async empty => {
    const queries: URLSearchParams[] = [];
    const snapshot = await network.pages!(reader(true), {request: async target => {
      if (!target.includes('chapterfun')) return readerHtml;
      queries.push(new URL(target).searchParams);
      return queries.length === 1 ? imageResponse(['/1.jpg']) : queries.length === 2 ? empty : imageResponse(['/2.jpg']);
    }});
    expect(queries.map(q => q.get('page'))).toEqual(['1', '2', '2']);
    expect(queries[2].has('_')).toBe(true);
    expect(snapshot.items).toHaveLength(2);
  });
  it('limits empty-list retries across the whole chapter and never returns a partial manifest', async () => {
    let calls = 0;
    await expect(network.pages!(reader(true), {request: async target => {
      if (!target.includes('chapterfun')) return readerHtml;
      calls++;
      return calls === 2 ? imageResponse(['/1.jpg']) : imageResponse([]);
    }})).rejects.toThrow('暂未返回');
    expect(calls).toBe(4); // two empty retries total, even when the cursor advances
  });
  it('does not retry protocol/ownership failures or requests cancelled after an empty response', async () => {
    for (const response of ['not the image protocol', imageResponse(['/1.jpg'], 'https://evil.test/1/2/3')]) {
      let calls = 0;
      await expect(network.pages!(reader(true), {request: async target => {
        if (!target.includes('chapterfun')) return readerHtml;
        calls++; return response;
      }})).rejects.toThrow();
      expect(calls).toBe(1);
    }
    const controller = new AbortController(); let calls = 0;
    await expect(network.pages!(reader(true), {signal: controller.signal, request: async target => {
      if (!target.includes('chapterfun')) return readerHtml;
      calls++; controller.abort(); return '';
    }})).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('recognizes the paid-chapter page without requesting its image list', async () => {
    const request = vi.fn(async () => '<script>var DM5_CID=1836194;</script><div class="view-pay-form">付费章节</div>');
    await expect(network.pages!(reader(true), {request})).rejects.toThrow('购买');
    expect(request).toHaveBeenCalledOnce();
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
    vi.stubGlobal('chrome', {runtime: {id: 'fixture', getURL: () => 'chrome-extension://fixture/'}, permissions:{contains:vi.fn(async()=>true)}, tabs,
      storage: {local: {get: async (key: string) => ({[key]: storage[key]}), set: async (value: object) => Object.assign(storage, value)}}});
    vi.stubGlobal('fetch', vi.fn(async (target: string) => new Response(await request(String(target)))));
    const source = await readSourceCatalog(url); expect(source.entries).toHaveLength(2);
    // Request headers use the separately tested DNR path; assert transport selection by
    // rejecting there, before any source tab could be created.
    await expect(discoverEntry(source, source.entries[0].id, new AbortController().signal, vi.fn())).rejects.toThrow('请求规则');
    expect(tabs.create).not.toHaveBeenCalled();
  });
  it('checks updates with one catalog request and no chapter/image requests', async () => {
    const previous = parseCatalog(html([1836194]), url), reads = vi.fn(async () => html());
    const next = await network.catalog!(url, {previous, request: reads});
    expect(next.entries).toHaveLength(2);
    expect(reads).toHaveBeenCalledExactlyOnceWith(url);
  });
});
