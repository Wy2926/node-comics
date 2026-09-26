import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search, searchUrl} from '../search';
import {describeWork} from '../work';

const request = {siteId: 'guazimanhua', query: '海 & Love'};
const url = 'https://www.guazimanhua.com/comic.php?id=123';
function html(empty = false) {
  const list = empty ? [] : [{'@type': 'ListItem', position: 1, name: '作品', url}];
  return `<script type="application/ld+json">${JSON.stringify({'@type': 'CollectionPage', name: '搜索：' + request.query + '漫画', mainEntity: {'@type': 'ItemList', numberOfItems: list.length, itemListElement: list}})}</script>
    ${empty ? '<div class="empty">暂无漫画</div>' : '<article class="card"><a href="/comic.php?id=123"><img class="cover" src="https://img.guazicdn.com/cover.jpg"></a><h3><a href="/comic.php?id=123">作品</a></h3><div class="meta">作者甲 · 连载</div></article>'}
    <nav class="pager"><a class="on" href="/category.php?keyword=${encodeURIComponent(request.query)}">1</a>${empty ? '' : `<a href="/category.php?keyword=${encodeURIComponent(request.query)}&amp;page=2">2</a>`}</nav>`;
}
describe('Guazi search', () => {
  it('cross-checks visible results with page JSON-LD and omits unavailable language data', () => {
    expect(new URL(searchUrl(request).url).searchParams.get('keyword')).toBe(request.query);
    expect(parseSearch(html(), request)).toMatchObject({nextCursor: 'page:2', items: [{catalogId: 'guazimanhua:123', title: '作品', authors: ['作者甲']}]});
    expect(parseSearch(html(), request).items[0]).not.toHaveProperty('contentLanguages');
    expect(parseSearch(html(true), request)).toEqual({items: []});
  });
  it('rejects missing rows, wrong identity, wrong query, page replay and forged cursors', () => {
    expect(() => parseSearch(html().replace('<article', '<removed'), request)).toThrow();
    expect(() => parseSearch(html().replace('https://www.guazimanhua.com/comic.php?id=123', 'https://evil.test/comic.php?id=123'), request)).toThrow();
    expect(() => parseSearch(html(), {...request, query: 'other'})).toThrow();
    expect(() => parseSearch(html(), {...request, cursor: 'page:2'})).toThrow();
    expect(() => searchUrl({...request, cursor: 'https://evil.test'})).toThrow();
  });
  it('discards an in-flight cancelled result', async () => {
    const controller = new AbortController(), read = vi.fn(async () => {controller.abort(); return html();});
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('takes the chapter parent work name, never the chapter headline', () => {
    const data = {'@type': 'Article', url: 'https://www.guazimanhua.com/chapter.php?id=456', headline: '第9话', isPartOf: {'@type': 'ComicStory', name: '原作品', url}};
    const doc = {querySelectorAll: () => [{textContent: JSON.stringify(data)}]} as unknown as Document;
    expect(describeWork(doc, data.url)).toMatchObject({status: 'ready', value: {title: '原作品', catalogId: 'guazimanhua:123'}});
    expect(describeWork(doc, data.url + '#nodelane-guazimanhua=999')).toMatchObject({status: 'error'});
  });
});
