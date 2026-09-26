import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search, searchUrl} from '../search';
import {describeWork} from '../work';

const request = {siteId: 'dm5', query: '海 & Love'};
const href = (page: number) => '/search?' + new URLSearchParams({title: request.query, language: '1', page: String(page)});
const card = `<li><div class="mh-item mh-card-wrap"><p class="mh-cover" style="background-image: url(https://images.cdndm5.com/cover.jpg)"></p>
  <h2 class="title"><a href="/manhua-sample/">海 &amp; Love</a></h2><p class="chapter">最新 <a href="/m12/">第2话</a></p></div></li>`;
const html = (rows = card) => `<a id="btnSearch" href="${href(1)}">搜索</a><h1>相近搜索结果（${rows ? 1 : 0}）</h1><ul class="mh-list col7">${rows}</ul>
  <div class="page-pagination pull-right"><a class="active" href="${href(1)}">1</a>${rows ? `<a href="${href(2)}">2</a>` : ''}</div>`;
describe('DM5 search', () => {
  it('encodes keywords, preserves site identities, and does not invent content languages', () => {
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
  it('rejects foreign results, unrelated query/pagination, challenge pages and arbitrary cursors', () => {
    expect(() => parseSearch(html().replace('/manhua-sample/', 'https://evil.test/manhua-sample/'), request)).toThrow();
    expect(() => parseSearch(html(), {...request, query: 'other'})).toThrow();
    expect(() => parseSearch(html(), {...request, cursor: 'page:2'})).toThrow();
    expect(() => parseSearch('<h1>Verify your browser</h1>', request)).toThrow();
    expect(() => searchUrl({...request, cursor: 'https://evil.test/'})).toThrow();
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
