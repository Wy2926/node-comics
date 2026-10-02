import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search, searchUrl} from '../search';
import {byClass} from '../html';
import {searchHtml, url} from './fixtures';
const request = {siteId: 'rawotaku', query: 'Work'};
describe('RawOtaku name search', () => {
  it('returns only lightweight main results, explicit language, cover and source latest label', () => {
    expect(parseSearch(searchHtml(), request)).toMatchObject({items: [{catalogUrl: url, title: 'Work & Name', contentLanguages: ['ja'], latestLabel: '第1話'}]});
    expect(parseSearch(searchHtml(), request).nextCursor).toBeUndefined();
    const next = parseSearch(searchHtml('Work', true), request).nextCursor!;
    expect(searchUrl({...request, cursor: next})).toBe('https://rawotaku.com/?q=Work&page=2');
  });
  it('recognizes a source-declared empty result', () => {
    const html = '<link rel="canonical" href="/?q=Work"><div id="main-content"><div class="notice">データなし！</div></div>';
    expect(parseSearch(html, request)).toEqual({items: []});
    expect(() => parseSearch(html.replace('データなし！', 'Verification required'), request)).toThrow();
  });
  it('deduplicates the source listing repeating the same stable catalog link', () => {
    const html = searchHtml(), card = `<div class="flw-item">${byClass(html, 'div', 'flw-item')}</div>`;
    expect(parseSearch(html.replace('<div class="pre-pagination">', card + '<div class="pre-pagination">'), request).items).toHaveLength(1);
  });
  it.each(['https://evil.test/?q=Work&page=2', '/?q=Other&page=2', '/?q=Work&page=0', '/?q=Work&page=2&page=3', '/?q=Work&page=2&token=x', '/read/work-raw/?q=Work&page=2'])
    ('rejects unbound cursor %s', cursor => expect(() => searchUrl({...request, cursor})).toThrow());
  it('rejects substituted query, catalog identity and language', () => {
    expect(() => parseSearch(searchHtml('Other'), request)).toThrow();
    expect(() => parseSearch(searchHtml().replaceAll('rawotaku.com/read/', 'rawotaku.com.evil.test/read/'), request)).toThrow();
    expect(() => parseSearch(searchHtml().replace('>JA<', '>invalid_tag<'), request)).toThrow();
  });
  it('encodes multilingual names and cancellation never issues additional requests', async () => {
    expect(new URL(searchUrl({...request, query: 'Work & 日本語'})).searchParams.get('q')).toBe('Work & 日本語');
    expect(new URL(searchUrl({...request, query: '📚'.repeat(256)})).searchParams.get('q')).toBe('📚'.repeat(256));
    expect(() => searchUrl({...request, query: '📚'.repeat(257)})).toThrow();
    const controller = new AbortController(), requestHttp = vi.fn(async () => {controller.abort(); return searchHtml();});
    await expect(search(request, {request: requestHttp, signal: controller.signal})).rejects.toThrow();
    expect(requestHttp).toHaveBeenCalledTimes(1);
  });
});
