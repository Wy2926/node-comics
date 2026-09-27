import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseSearch, search, searchUrl} from '../search';
import {describeWork} from '../work';
import {createSourceNetworkContext} from '../../../runtime/http';

vi.mock('../../../runtime/image-headers', () => ({withImageHeaders: async (_url: string, _headers: unknown, _signal: unknown, read: () => Promise<unknown>) => read()}));
afterEach(() => vi.unstubAllGlobals());

const request = {siteId: 'dm5', query: '海 & Love'};
const href = (page: number) => '/search?' + new URLSearchParams({title: request.query, language: '1', page: String(page)});
const card = `<li><div class="mh-item mh-card-wrap"><p class="mh-cover" style="background-image: url(https://images.cdndm5.com/cover.jpg)"></p>
  <h2 class="title"><a href="/manhua-sample/">海 &amp; Love</a></h2><p class="chapter">最新 <a href="/m12/">第2话</a></p></div></li>`;
const html = (rows = card) => `<a id="btnSearch" href="${href(1)}">搜索</a><h1>相近搜索结果（${rows ? 1 : 0}）</h1><ul class="mh-list col7">${rows}</ul>
  <div class="page-pagination pull-right"><a class="active" href="${href(1)}">1</a>${rows ? `<a href="${href(2)}">2</a>` : ''}</div>`;
const missingHtml = `<title>访问页面不存在_在线漫画</title><div class="box404">
  <p class="text-center tip-text">很抱歉，您访问的页面穿越了<br>我们这在努力找回...</p>
  <p><a href="/">转到我们的主页</a><a href="/help-0/">向我们报告错误</a></p></div>
  <section><h1>近期用户喜欢的漫画</h1><ul class="mh-list col7">${card}</ul></section>`;
describe('DM5 search', () => {
  it('encodes keywords, preserves site identities, and does not invent content languages', () => {
    expect(new URL(searchUrl(request).url).search).toBe('?title=%E6%B5%B7%20%26%20Love&page=1');
    expect(new URL(searchUrl(request).url).searchParams.get('title')).toBe(request.query);
    expect(new URL(searchUrl(request).url).searchParams.has('language')).toBe(false);
    const result = parseSearch(html(), request);
    expect(result.items[0]).toMatchObject({catalogId: 'dm5:sample', title: '海 & Love'});
    expect(result.items[0]).not.toHaveProperty('contentLanguages');
    expect(result.items[0].cover?.url).toBe('https://images.cdndm5.com/cover.jpg');
    expect(result.nextCursor).toBe('page:2');
    expect(parseSearch(html(''), request)).toEqual({items: []});
    expect(parseSearch(html().replaceAll('&language=1', ''), request)).toEqual(result);
  });
  it('encodes spaces as %20 and literal plus/percent signs without changing the query or page', () => {
    for(const query of ['One Piece','海 + Love','100% 漫画']){
      const first=new URL(searchUrl({...request,query}).url),next=new URL(searchUrl({...request,query,cursor:'page:2'}).url);
      expect(first.search).not.toContain('+');expect(first.search).toContain('%20');
      expect(first.searchParams.get('title')).toBe(query);expect(next.searchParams.get('title')).toBe(query);
      expect(next.searchParams.get('page')).toBe('2');
    }
  });
  it('rejects foreign results, unrelated query/pagination, challenge pages and arbitrary cursors', () => {
    expect(() => parseSearch(html().replace('/manhua-sample/', 'https://evil.test/manhua-sample/'), request)).toThrow();
    expect(() => parseSearch(html(), {...request, query: 'other'})).toThrow();
    expect(() => parseSearch(html(), {...request, cursor: 'page:2'})).toThrow();
    expect(() => parseSearch('<h1>Verify your browser</h1>', request)).toThrow();
    expect(() => searchUrl({...request, cursor: 'https://evil.test/'})).toThrow();
  });
  it('recognizes the source missing-page response as empty without importing its recommendations', () => {
    expect(parseSearch(missingHtml, request)).toEqual({items: []});
    expect(parseSearch(missingHtml, {...request, cursor: 'page:2'})).toEqual({items: []});
    for (const body of ['<h1>404 Not Found</h1>', missingHtml.replace('box404', 'challenge'),
      missingHtml.replace('访问页面不存在_在线漫画', 'Verify your browser'), missingHtml.replace('很抱歉，您访问的页面穿越了', '请完成验证')])
      expect(() => parseSearch(body, request)).toThrow('SOURCE_SEARCH_INVALID');
  });
  it('accepts the search 404 body through the HTTP transport and still rejects other failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(missingHtml, {status: 404})));
    const context = createSourceNetworkContext('https://www.dm5.com/'), read = vi.spyOn(context, 'request');
    await expect(search(request, context)).resolves.toEqual({items: []});
    expect(read).toHaveBeenCalledWith(searchUrl(request).url, {referer: 'https://www.dm5.com/search', acceptStatuses: [404]});
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<h1>404 Not Found</h1>', {status: 404}));
    await expect(search(request, context)).rejects.toThrow('SOURCE_SEARCH_INVALID');
    for (const status of [403, 429, 500]) {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(missingHtml, {status}));
      await expect(search(request, context)).rejects.toMatchObject({details: {status}});
    }
  });
  it('never sends an aborted search or publishes a response after cancellation', async () => {
    const controller = new AbortController(), read = vi.fn(async () => {controller.abort(); return html();});
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('uses explicit work script metadata and declines chapter title heuristics', () => {
    const doc = {querySelectorAll: () => [{textContent: `var DM5_COMIC_MNAME="作品/正篇";var DM5_COMIC_URL="/manhua-sample/";`}], querySelector: () => null} as unknown as Document;
    expect(describeWork(doc, 'https://www.dm5.com/manhua-sample/')).toMatchObject({status: 'ready', value: {title: '作品/正篇', catalogId: 'dm5:sample'}});
    expect(describeWork(doc, 'https://www.dm5.com/m12/')).toMatchObject({status: 'not-ready'});
    expect(describeWork(doc, 'https://www.dm5.com/manhua-other/')).toMatchObject({status: 'error'});
  });
});
