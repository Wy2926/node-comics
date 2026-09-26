import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {definition} from '../definition';
import {network, parsePages} from '../network';
import {validateSourceCatalog, discoverEntry, discoverPage, sourceFor} from '../../../index';
import {readSourceCatalog} from '../../../runtime/catalog-reader';
import {importCatalog} from '../../../../comics/application/import-service';
import {applyCatalogRefresh} from '../../../../comics/application/catalog-service';
import {catalog} from '../../../../comics/repositories';

const url = 'https://comic.naver.com/webtoon/list?titleId=123';
const reader = 'https://comic.naver.com/webtoon/detail?titleId=123&no=1';
const image = 'https://image-comic.pstatic.net/webtoon/123/1/page.jpg';
const html = `<meta property="og:title" content="Fixture &amp; title"><script>throw Error('never run')</script>
  <a href="/webtoon/detail?titleId=123&amp;no=1" aria-current="true">Current</a>
  <img id="content_image_99" src="https://evil.test/ad.jpg">
  <div id="sectionContWide" class="wt_viewer"><img src="https://image-comic.pstatic.net/static/agerate/age_15_white.jpg">
  <img src="${image}" id="content_image_0"><img id="content_image_1" src="${image}"></div>`;
const row = (no: number) => ({no, subtitle: `Episode ${no}`, charge: false});
function fixture(rows = [row(1), row(3), row(7)], mutate?: (data: any, page: number) => void) {
  const request = vi.fn(async (target: string) => {
    const u = new URL(target);
    if (u.pathname === '/webtoon/detail') return html;
    if (u.pathname.endsWith('/info')) return JSON.stringify({titleId: 123, webtoonLevelCode: 'WEBTOON', titleName: 'Fixture'});
    const page = Number(u.searchParams.get('page'));
    expect(u.searchParams.get('sort')).toBe('ASC');
    const data = {titleId: 123, webtoonLevelCode: 'WEBTOON', totalCount: rows.length, sort: 'ASC',
      articleList: rows.slice((page - 1) * 2, page * 2),
      pageInfo: {totalRows: rows.length, totalPages: Math.ceil(rows.length / 2), pageSize: 2, page}};
    mutate?.(data, page);
    return JSON.stringify(data);
  });
  return {request};
}
afterEach(() => vi.unstubAllGlobals());
describe('NAVER Webtoon', () => {
  it('prefers the work poster and supports the thumbnail field when no poster is supplied', async () => {
    for (const poster of [true,false]) {
      const context=fixture(),request=async(target:string)=>{
        const raw=await context.request(target);if(!target.includes('/info?'))return raw;
        return JSON.stringify({...JSON.parse(raw),thumbnailUrl:'https://image-comic.pstatic.net/cover.jpg',
          ...(poster?{posterThumbnailUrl:'https://image-comic.pstatic.net/poster.jpg'}:{})});
      };
      const source=validateSourceCatalog(await network.catalog(url,{request}));
      expect(source.cover?.url).toBe('https://image-comic.pstatic.net/'+(poster?'poster':'cover')+'.jpg');
      expect(source.entries).toHaveLength(3);
    }
  });
  it('uses stable title and episode identity and rejects forged/ambiguous URLs', () => {
    expect(definition.identify(new URL(url + '&tab=mon&page=3'))?.pageKey).toBe('naver:webtoon:123');
    expect(definition.identify(new URL(reader + '&week=mon'))?.pageKey).toBe('naver:webtoon:123:episode:1');
    for (const invalid of [url.replace('comic.naver.com', 'comic.naver.com.evil.test'), url.replace('https:', 'http:'), url.replace('comic.', 'user:secret@comic.')])
      expect(definition.identify(new URL(invalid))).toBeNull();
    for (const invalid of [url + '&titleId=456', reader + '&no=2', url.replace('123', '0'), url.replace('/webtoon/', '/unknown/'), url + '&no=1'])
      expect(definition.identify(new URL(invalid))?.kind).toBe('other');
    expect(definition.installation.requiredOrigins).toEqual([]);
    expect(definition.installation.autoContentMatches).toEqual([]);
    expect(sourceFor(url).definition.catalogSync?.intervalMinutes).toBe(720);
  });
  it.each(['bestChallenge', 'challenge'])('keeps %s namespace and verifies reader ownership before using upload paths', section => {
    const target = reader.replace('/webtoon/', '/' + section + '/');
    expect(definition.identify(new URL(target))?.pageKey).toBe('naver:' + section + ':123:episode:1');
    const sample = html.replace('id="sectionContWide" ', '').replace('/webtoon/detail', '/' + section + '/detail')
      .replaceAll(image, 'https://image-comic.pstatic.net/user_contents_data/challenge_comic/2026/09/23/12345/upload.jpeg');
    expect(parsePages(sample, target).items).toHaveLength(2);
    expect(() => parsePages(sample.replace('titleId=123', 'titleId=456'), target)).toThrow();
  });
  it('reads every catalog page and retains stable identities across new releases', async () => {
    const context = fixture(), first = validateSourceCatalog(await network.catalog(url, context));
    expect(context.request).toHaveBeenCalledTimes(4);
    expect(first.entries.map(entry => entry.remoteId)).toEqual(['1', '3', '7']);
    expect(first.groups[0].entryIds).toEqual(first.entries.map(entry => entry.id));
    const next = await network.catalog(url, {...fixture([row(1), row(3), row(7), row(9)]), previous: first});
    expect(next.entries.slice(0, 3)).toEqual(first.entries);
  });
  it.each(['partial', 'duplicate', 'foreign', 'level', 'total', 'page', 'sort', 'empty', 'page-size'])('rejects %s catalogs', async mode => {
    const context = fixture(undefined, (data, page) => {
      if (page !== 2) return;
      if (mode === 'partial' || mode === 'empty') data.articleList = [];
      if (mode === 'duplicate') data.articleList[0] = row(1);
      if (mode === 'foreign') data.titleId++;
      if (mode === 'level') data.webtoonLevelCode = 'CHALLENGE';
      if (mode === 'total') data.totalCount++;
      if (mode === 'page') data.pageInfo.page = 1;
      if (mode === 'sort') data.sort = 'DESC';
      if (mode === 'page-size') data.pageInfo.pageSize++;
    });
    await expect(network.catalog(url, context)).rejects.toThrow();
  });
  it('rejects a publication arriving during pagination', async () => {
    let firstReads = 0;
    await expect(network.catalog(url, fixture(undefined, (data, page) => {
      if (page === 1 && ++firstReads === 2) data.totalCount++;
    }))).rejects.toThrow('读取期间');
  });
  it('preserves ordered duplicate URLs, excludes notices/ads, and decodes title entities', () => {
    const pages = parsePages(html, reader);
    expect(pages).toMatchObject({title: 'Fixture & title', knownTotal: 2, discoveryComplete: true, direction: 'ltr'});
    expect(pages.items.map(item => item.id)).toEqual(['page-0', 'page-1']);
    expect(pages.items.map(item => item.resource)).toEqual([{kind: 'http', url: image}, {kind: 'http', url: image}]);
  });
  it.each([
    html.replace('content_image_1', 'content_image_2'), html.replace('content_image_1', 'content_image_0'),
    html.replaceAll('/123/1/', '/456/1/'), html.replaceAll('/123/1/', '/123/2/'),
    html.replaceAll('image-comic.pstatic.net/webtoon', 'image-comic.pstatic.net.evil.test/webtoon'),
    html.replaceAll(image, 'javascript:alert(1)'), html.replace('</div>', ''),
    html.replace('class="wt_viewer"', 'class="ad"'), '<html>Login required</html>',
  ])('rejects incomplete or foreign readers', value => expect(() => parsePages(value, reader)).toThrow());
  it('runs import, refresh and page discovery without opening any source tab; aborts never publish', async () => {
    const records: Record<string, unknown> = {}, create = vi.fn(() => {throw Error('must not open a tab');});
    vi.stubGlobal('chrome', {runtime: {id: 'test'}, permissions:{contains:vi.fn(async()=>true)}, tabs: {create}, storage: {local: {
      get: async (key: string) => ({[key]: records[key]}), set: async (values: object) => Object.assign(records, values),
    }}});
    const context = fixture();
    vi.stubGlobal('fetch', vi.fn(async (target: string, init: RequestInit) => {
      expect(init.credentials).toBe('include');
      expect(init.redirect).toBe('error');
      return new Response(await context.request(String(target)));
    }));
    const source = await readSourceCatalog(url), progress = vi.fn(), signal = new AbortController().signal;
    const manifest = await discoverEntry(source, source.entries[0].id, signal, progress);
    expect(manifest.pageContext).toBeUndefined();
    expect(records['manifest:' + manifest.id]).toEqual(manifest);
    await readSourceCatalog(url, {previous: source});
    await discoverPage(reader, signal, progress);
    expect(create).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(network.catalog(url, {...context, signal: controller.signal})).rejects.toThrow();
    await expect(network.pages(reader, {...context, signal: controller.signal})).rejects.toThrow();
  });
  it('adds updates once, preserves old entry state and leaves the accepted directory on failed refresh', async () => {
    const first = await network.catalog(url, fixture()), comic = await importCatalog(first);
    const oldEntries = await catalog.list('entries', {index: 'comicId', range: comic.id});
    const next = await network.catalog(url, {...fixture([row(1), row(3), row(7), row(9)]), previous: first});
    await applyCatalogRefresh(comic.id, comic.source.generation, next);
    await applyCatalogRefresh(comic.id, comic.source.generation, next);
    expect((await catalog.get('comics', comic.id))?.catalogUpdates?.count).toBe(1);
    for (const old of oldEntries) expect(await catalog.get('entries', old.id)).toEqual(old);
    await expect(network.catalog(url, fixture(undefined, data => {data.totalCount++;}))).rejects.toThrow();
    expect((await catalog.get('catalogs', first.id))?.entries).toEqual(next.entries);
  });
});
