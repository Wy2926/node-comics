import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search} from '../search';
import {searchHtml} from './fixtures';

describe('Baozi source search', () => {
  const query = {siteId: 'baozimh', query: 'fixture'};
  it('returns source titles, authors, cover and verified empty results without inventing language/latest fields', async () => {
    const result = await parseSearch(searchHtml(), query);
    expect(result.items[0]).toMatchObject({title: 'Bao fixture & work', authors: ['Author & Co']});
    expect(result.items[0].latestLabel).toBeUndefined(); expect(result.items[0].contentLanguages).toBeUndefined();
    expect((await parseSearch(searchHtml('fixture', 0), query)).items).toEqual([]);
  });
  it('paginates the complete result and expires the cursor if source ordering or query changes', async () => {
    const html = searchHtml('fixture', 90), first = await parseSearch(html, query);
    expect(first.items).toHaveLength(50);
    const last = await parseSearch(html, {...query, cursor: first.nextCursor}); expect(last.items).toHaveLength(40); expect(last.nextCursor).toBeUndefined();
    await expect(parseSearch(searchHtml('fixture', 89), {...query, cursor: first.nextCursor})).rejects.toThrow('SOURCE_SEARCH_CURSOR_EXPIRED');
    await expect(parseSearch(searchHtml('other', 90), {...query, query: 'other', cursor: first.nextCursor})).rejects.toThrow('SOURCE_SEARCH_CURSOR_EXPIRED');
  });
  it.each(['unknown', 'default_cover.png'])('retains all results when a source cover is %s', async placeholder => {
    // The real search for 斗破 contains a /cover/unknown poster among 90 valid works.
    const html = searchHtml('斗破', 90).replace('/cover/example-23.jpg', '/cover/' + placeholder);
    const request = {...query, query: '斗破'}, first = await parseSearch(html, request);
    const last = await parseSearch(html, {...request, cursor: first.nextCursor});
    expect([...first.items, ...last.items]).toHaveLength(90);
    expect(first.items[23]).toMatchObject({catalogId: 'baozimh:example-23', title: 'Work 23', authors: ['Author & Co']});
    expect(first.items[23].cover).toBeUndefined();
    expect(first.items[24].cover?.url).toContain('/cover/example-24.jpg');
  });
  it('allows an absent poster image while still rejecting foreign or mismatched artwork', async () => {
    const html = searchHtml().replace(/<amp-img\b[\s\S]*<\/amp-img>/, '');
    expect((await parseSearch(html, query)).items[0].cover).toBeUndefined();
    for (const invalid of [searchHtml().replaceAll('static-tw.baozimh.com', 'evil.test'),
      searchHtml().replace('/cover/example-author.jpg', '/cover/another-work.jpg')])
      await expect(parseSearch(invalid, query)).rejects.toThrow();
  });
  it.each(['query', 'count', 'owner', 'duplicate', 'html', 'cursor'])('rejects malformed %s', async mode => {
    let html = searchHtml('fixture', 2);
    if (mode === 'query') html = html.replace('value="fixture"', 'value="other"');
    if (mode === 'count') html = html.replace('结果(2)', '结果(3)');
    if (mode === 'owner') html = html.replaceAll('href="/comic/', 'href="https://evil.test/comic/');
    if (mode === 'duplicate') html = html.replaceAll('example-1', 'example-author');
    if (mode === 'html') html = '<html>请完成验证</html>';
    await expect(parseSearch(html, {...query, ...(mode === 'cursor' ? {cursor: 'https://evil.test'} : {})})).rejects.toThrow();
  });
  it('encodes queries, stays in search scope, rejects unsupported site IDs and cancels late responses', async () => {
    const request = vi.fn(async () => searchHtml('a & b'));
    await search({...query, query: 'a & b'}, {request}); expect(request).toHaveBeenCalledWith('https://cn.baozimh.com/search?q=a+%26+b');
    await expect(search({...query, siteId: 'unknown'}, {request})).rejects.toThrow();
    const abort = new AbortController();
    await expect(search(query, {signal: abort.signal, request: async () => {abort.abort(); return searchHtml();}})).rejects.toThrow();
  });
});
