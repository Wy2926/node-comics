import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search, searchUrl} from '../search';
import {catalogKey, catalogUrl} from '../definition';
import {cover, slug, url} from './fixtures';

const query = {siteId: 'rawlazy', query: 'Work & Name'};
const card = () => `<div class="entry-tag"><a class="thumb" href="${url}"><img src="${cover}"></a>
  <h2 class="name"><a href="${url}">Work &amp; Name</a></h2><h4>第15話</h4></div>`;
const html = () => `<p class="font-15x">Search: Work &amp; Name</p><div class="row-of-mangas">${card()}</div>
  <aside><div class="entry-tag">Recommended artwork must not enter results</div></aside>`;
describe('RawLazy name search', () => {
  it('queries the source name search and keeps special characters in one encoded field', () => {
    const target = new URL(searchUrl(query));
    expect(target.origin).toBe('https://rawlazy.io'); expect(target.searchParams.get('s_manga')).toBe(query.query);
    expect([...target.searchParams.keys()]).toEqual(['s_manga']);
  });
  it('returns lightweight source candidates and dedicated covers without guessing language or authors', () => {
    expect(parseSearch(html(), query)).toEqual({items: [{catalogId: catalogKey(slug), catalogUrl: url,
      title: 'Work & Name', cover: {url: cover}, latestLabel: '第15話'}]});
  });
  it('only treats the explicit source no-results notice as an empty result', () => {
    expect(parseSearch('<p class="text-danger">Sorry, no manga found!</p>', query)).toEqual({items: []});
    expect(() => parseSearch('<p>Challenge required</p>', query)).toThrow();
    expect(() => parseSearch('<div class="row-of-mangas"></div>', query)).toThrow();
  });
  it.each(['site', 'empty', 'length', 'cursor', 'control'])('rejects invalid %s search requests', kind => {
    const request = {...query};
    if (kind === 'site') request.siteId = 'other';
    if (kind === 'empty') request.query = ' ';
    if (kind === 'length') request.query = 'x'.repeat(257);
    if (kind === 'control') request.query += '\n';
    expect(() => searchUrl(kind === 'cursor' ? {...request, cursor: 'https://evil.test/'} : request)).toThrow();
  });
  it.each(['label', 'owner', 'poster', 'duplicate', 'closure'])('rejects invalid %s response evidence', kind => {
    let body = html();
    if (kind === 'label') body = body.replace('Search: Work &amp; Name', 'Search: Other');
    if (kind === 'owner') body = body.replaceAll(url, 'https://rawlazy.io.evil.test/manga-lazy/one/');
    if (kind === 'poster') body = body.replace(`class="thumb" href="${url}"`, `class="thumb" href="${catalogUrl('other')}"`);
    if (kind === 'duplicate') body = body.replace(card(), card() + card());
    if (kind === 'closure') body = body.replace('</div>\n  <aside>', '\n  <aside>');
    expect(() => parseSearch(body, query)).toThrow();
  });
  it('uses one request and honors cancellation before and after the request', async () => {
    const request = vi.fn(async () => html());
    expect((await search(query, {request})).items).toHaveLength(1); expect(request).toHaveBeenCalledTimes(1);
    const cancelled = new AbortController(); cancelled.abort(); request.mockClear();
    await expect(search(query, {request, signal: cancelled.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(request).not.toHaveBeenCalled();
    const during = new AbortController(); request.mockImplementationOnce(async () => {during.abort(); return html();});
    await expect(search(query, {request, signal: during.signal})).rejects.toMatchObject({name: 'AbortError'});
  });
});
