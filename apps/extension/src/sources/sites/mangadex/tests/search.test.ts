import {describe, expect, it, vi} from 'vitest';
import {parseSearch, search, searchUrl} from '../search';
import {describeWork} from '../work';

const mangaId = '42f40118-dff5-4f23-acbf-e54e89f026bd';
const request = {siteId: 'mangadex', query: 'Okaeri & Love'};
const row = {id: mangaId, type: 'manga', attributes: {title: {'ja-ro': 'Okaeri'}, originalLanguage: 'ja', contentRating: 'safe', availableTranslatedLanguages: ['en', 'zh-hk']}, relationships: []};
const body = (data: unknown[] = [row], extra = {}) => JSON.stringify({result: 'ok', response: 'collection', data, total: data.length, limit: 12, offset: 0, ...extra});
describe('MangaDex search', () => {
  it('limits name searches to supported ratings without filtering chapter or original languages', () => {
    const url = new URL(searchUrl(request).url);
    expect(url.searchParams.get('title')).toBe(request.query);
    expect(url.searchParams.getAll('contentRating[]')).toEqual(['safe', 'suggestive']);
    expect(url.searchParams.has('availableTranslatedLanguage[]')).toBe(false);
    expect(url.searchParams.has('originalLanguage[]')).toBe(false);
  });
  it('requires a supported rating in each result before exposing the page', () => {
    for (const contentRating of ['safe', 'suggestive'])
      expect(parseSearch(body([{...row, attributes: {...row.attributes, contentRating}}]), request).items).toHaveLength(1);
    for (const contentRating of [undefined, null, '', 'unsupported'])
      expect(() => parseSearch(body([{...row, attributes: {...row.attributes, contentRating}}]), request)).toThrow('内容分级');
  });
  it('takes body languages from available chapters rather than title/original language', () => {
    expect(parseSearch(body(), request).items[0]).toMatchObject({catalogId: 'mangadex:' + mangaId, title: 'Okaeri', contentLanguages: ['en', 'zh-HK']});
    expect(parseSearch(body([]), request)).toEqual({items: []});
  });
  it('returns a Japanese name result whose actual content is only English and Chinese', async () => {
    const japanese = {...request, query: 'キン肉マンII世 究極の超人タッグ編'};
    const value = {...row, id: 'af857779-a400-46ef-917a-3b3a248e2221', attributes: {...row.attributes, title: {ja: japanese.query}}};
    const read = vi.fn(async (target: string) => {
      const url = new URL(target);
      expect(url.searchParams.get('title')).toBe(japanese.query);
      expect(url.searchParams.has('availableTranslatedLanguage[]')).toBe(false);
      return body([value]);
    });
    expect((await search(japanese, {request: read})).items[0]).toMatchObject({catalogId: 'mangadex:' + value.id, title: japanese.query, contentLanguages: ['en', 'zh-HK']});
  });
  it('accepts absent content-language data and does not substitute originalLanguage', () => {
    for (const availableTranslatedLanguages of [undefined, null, []]) {
      const result = parseSearch(body([{...row, attributes: {...row.attributes, availableTranslatedLanguages}}]), request);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).not.toHaveProperty('contentLanguages');
    }
  });
  it('validates pagination and work/cover identity and does not emit cancelled results', async () => {
    expect(() => parseSearch(body(), {...request, cursor: 'offset:12'})).toThrow();
    expect(() => parseSearch(body([{...row, type: 'chapter'}]), request)).toThrow();
    expect(() => parseSearch(body([row, row]), request)).toThrow();
    expect(() => searchUrl({...request, cursor: 'https://evil.test/'})).toThrow();
    const controller = new AbortController(), read = vi.fn(async () => {controller.abort(); return body();});
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    await expect(search(request, {request: read, signal: controller.signal})).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('requires the OpenGraph work identity to match the current route, including SPA transitions', () => {
    const url = 'https://mangadex.org/title/' + mangaId;
    const doc = {querySelectorAll: (selector: string) => [{getAttribute: () => selector.includes('og:url') ? url : 'Okaeri - MangaDex'}]} as unknown as Document;
    expect(describeWork(doc, url)).toMatchObject({status: 'ready', value: {title: 'Okaeri', catalogId: 'mangadex:' + mangaId}});
    expect(describeWork(doc, 'https://mangadex.org/title/12345678-1234-1234-1234-123456789abc')).toMatchObject({status: 'error'});
    expect(describeWork(doc, 'https://mangadex.org/chapter/' + mangaId)).toMatchObject({status: 'not-ready'});
  });
});
