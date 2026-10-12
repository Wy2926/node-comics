import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {definition, location, origin} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {parseReader, parseWork} from '../protocol';
import {parseSearch} from '../search';
import {chapterToken} from '../token';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {batch, chapter, cover, hit, image, pagesBody, readerHtml, readerUrl, workHtml, workUrl} from './fixtures';

describe('MangaTaro', () => {
  it('claims works/readers with parent identity and generic inline recognition', () => {
    expect(definition.identify(new URL(workUrl))).toMatchObject({kind: 'catalog', catalog: {url: workUrl}});
    expect(definition.identify(new URL(readerUrl))).toMatchObject({kind: 'reader', pageKey: 'mangataro:chapter:11', catalog: {url: workUrl}});
    expect(definition.inlineRecognition).toBe('generic'); expect(definition.embeddedEntry).toBe('floating');
    expect(definition.catalogSync).toEqual({intervalMinutes: 720});
    expect(definition.installation.optionalContentMatches).toEqual([origin + '/*']);
    expect(location(new URL(origin + '/read/sample/ch19-5-22'))).toEqual({slug: 'sample', chapter: '19.5', id: '22'});
    expect(location(new URL(workUrl + '?utm_source=test#chapters'))?.slug).toBe('sample');
  });
  it.each(['http://mangataro.org', 'https://mangataro.org.evil.test', 'https://user:pass@mangataro.org', 'ftp://mangataro.org', 'https://mangataro.org:444'])('rejects forged origin %s', base => {
    expect(definition.identify(new URL(base + '/manga/sample'))).toBeNull();
  });
  it.each(['/browse', '/read/sample', '/manga/sample/ch1-11', '/read/sample/ch1-x', '/manga/sample%2fother', '/manga/sample%252fother', '/manga/%FF', '/manga/a%5cb'])('does not import unsupported path %s', path => {
    expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
  });
  it.each(['2026-10-12T00:00:00.000Z', '2026-10-12T23:59:59.999Z', '2026-11-01T00:00:00.001Z'])('matches native public checksum at %s', date => {
    const now = Date.parse(date), result = chapterToken(now), hour = date.slice(0, 13).replace(/[-T]/g, '');
    expect(result).toEqual({_ts: String(Math.floor(now / 1000)),
      _t: createHash('md5').update(Math.floor(now / 1000) + 'mng_ch_' + hour).digest('hex').slice(0, 16)});
  });
  it('parses dedicated cover and stable publication slots without dropping alternatives or text chapters', () => {
    const result = validateCatalog(parseCatalog(parseWork(workHtml(), workUrl), [chapter(),
      chapter(12, '1', {language: 'pt-br', group_name: 'Team B'}), chapter(13, '2.5', {chapter_type: 'text'})]), [definition]);
    expect(result).toMatchObject({complete: true, title: 'Sample & Book', cover: {url: cover}});
    expect(result.entries.map(e => e.order)).toEqual([0, 0, 2]);
    expect(result.entries[0].readingSlotId).toBe(result.entries[1].readingSlotId);
    expect(result.entries[1]).toMatchObject({contentLanguage: 'pt-BR', rawTypes: ['Team B']});
    expect(result.entries[2].readable).toBe(false);
    expect(result.defaultEntryId).toBe(result.entries[0].id);
  });
  it.each(['canonical', 'owner', 'body', 'cover', 'duplicate', 'inert'])('rejects invalid work metadata: %s', kind => {
    let html = workHtml();
    if (kind === 'canonical') html = html.replace('href="' + workUrl, 'href="' + origin + '/manga/foreign');
    if (kind === 'owner') html = html.replace('data-manga-url="' + workUrl, 'data-manga-url="' + origin + '/manga/foreign');
    if (kind === 'body') html = html.replace('<body data-manga-id="7"', '<body data-manga-id="8"');
    if (kind === 'cover') html = html.replace(cover, 'javascript:alert(1)');
    if (kind === 'duplicate') html += '<div class="chapter-list" data-manga-id="7"></div>';
    if (kind === 'inert') html = '<template>' + html + '</template>';
    expect(() => parseWork(html, workUrl)).toThrow();
  });
  it.each([{id: '12'}, {url: readerUrl.replace('/sample/', '/other/')}, {chapter: '2'}, {language: 'bad_tag'}, {chapter_type: 'external'}])('rejects mismatched publication %j', extra => {
    expect(() => parseCatalog(parseWork(workHtml(), workUrl), [chapter(11, '1', extra)])).toThrow();
  });
  it('rejects duplicate publication IDs', () => {
    expect(() => parseCatalog(parseWork(workHtml(), workUrl), [chapter(), chapter()])).toThrow();
  });
  it('reads all 501 entries in two sequential batches with exact offsets', async () => {
    const rows = Array.from({length: 501}, (_, i) => chapter(i + 1, String(i + 1)));
    const request = vi.fn().mockResolvedValueOnce(workHtml()).mockResolvedValueOnce(batch(rows.slice(0, 500), {total: 501, has_more: true}))
      .mockResolvedValueOnce(batch(rows.slice(500), {total: 501, offset: 500}));
    const result = validateCatalog(await network.catalog(workUrl, {request}), [definition]);
    expect(result.entries).toHaveLength(501); expect(request).toHaveBeenCalledTimes(3);
    expect(new URL(request.mock.calls[1][0]).searchParams.get('offset')).toBe('0');
    expect(new URL(request.mock.calls[2][0]).searchParams.get('offset')).toBe('500');
    expect(new URL(request.mock.calls[2][0]).searchParams.get('order')).toBe('ASC');
  });
  it.each([{total: 2}, {offset: 1}, {limit: 100}, {has_more: true}, {success: false}, {total: 10001}])('rejects incomplete catalog batch %j', extra => {
    const request = vi.fn().mockResolvedValueOnce(workHtml()).mockResolvedValueOnce(batch([chapter()], extra));
    return expect(network.catalog(workUrl, {request})).rejects.toThrow();
  });
  it('rejects changed totals and transport failure without mutating the previous snapshot', async () => {
    const previous = parseCatalog(parseWork(workHtml(), workUrl), [chapter()]), before = structuredClone(previous);
    const rows = Array.from({length: 500}, (_, i) => chapter(i + 1, String(i + 1)));
    for (const failure of [false, true]) {
      const request = vi.fn().mockResolvedValueOnce(workHtml()).mockResolvedValueOnce(batch(rows, {total: 501, has_more: true}));
      if (failure) request.mockRejectedValueOnce(Error('HTTP 503'));
      else request.mockResolvedValueOnce(batch([chapter(501, '501'), chapter(502, '502')], {total: 502, offset: 500}));
      await expect(network.catalog(workUrl, {request, previous})).rejects.toThrow();
      expect(previous).toEqual(before); expect(request).toHaveBeenCalledTimes(3);
    }
  });
  it('accepts a source-confirmed empty directory', async () => {
    const request = vi.fn().mockResolvedValueOnce(workHtml()).mockResolvedValueOnce(batch([]));
    expect(await network.catalog(workUrl, {request})).toMatchObject({entries: [], complete: true, defaultEntryId: undefined});
  });
  it('keeps repeated image URLs as independent ordered slots', async () => {
    const request = vi.fn().mockResolvedValueOnce(readerHtml()).mockResolvedValueOnce(pagesBody());
    const result = validatePages(await network.pages(readerUrl, {request}), definition.identify(new URL(readerUrl))!);
    expect(result).toMatchObject({knownTotal: 2, discoveryComplete: true, direction: 'ltr'});
    expect(result.items.map(p => p.resource)).toEqual([{kind: 'http', url: image}, {kind: 'http', url: image}]);
    expect(result.items.map(p => p.id)).toEqual(['page-0', 'page-1']);
    expect(request.mock.calls[1]).toEqual([origin + '/auth/chapter-content?chapter_id=11', {referer: readerUrl}]);
  });
  it.each(['canonical', 'owner', 'id', 'number', 'reader'])('rejects mismatched reader %s before requesting images', async kind => {
    let html = readerHtml();
    if (kind === 'canonical') html = html.replace(readerUrl, readerUrl.replace('ch1-11', 'ch2-12'));
    if (kind === 'owner') html = html.replace(workUrl, workUrl + '-other');
    if (kind === 'id') html = html.replace('data-chapter-id="11"', 'data-chapter-id="12"');
    if (kind === 'number') html = html.replace('data-chapter-number="1"', 'data-chapter-number="2"');
    if (kind === 'reader') html = html.replace('id="reader-media"', 'id="not-reader"');
    const request = vi.fn().mockResolvedValue(html);
    await expect(network.pages(readerUrl, {request})).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([{success: false}, {chapter_id: 12}, {chapter_type: 'text'}, {total: 3}, {images: []}, {images: [image, 'javascript:alert(1)']}])('rejects invalid/inaccessible images %j', extra => {
    expect(() => parsePages(pagesBody(extra), parseReader(readerHtml(), readerUrl), readerUrl)).toThrow();
  });
  it('preserves permission failure without alternate requests', async () => {
    const request = vi.fn().mockResolvedValueOnce(readerHtml()).mockRejectedValueOnce(Error('HTTP 403'));
    await expect(network.pages(readerUrl, {request})).rejects.toThrow('403'); expect(request).toHaveBeenCalledTimes(2);
  });
  it('cancels before and after a response without publishing late results', async () => {
    const controller = new AbortController(); controller.abort(Error('stop'));
    const request = vi.fn(); await expect(network.catalog(workUrl, {request, signal: controller.signal})).rejects.toThrow('stop');
    expect(request).not.toHaveBeenCalled();
    const pending = new AbortController(), late = vi.fn(async () => {pending.abort(Error('stop')); return workHtml();});
    await expect(network.catalog(workUrl, {request: late, signal: pending.signal})).rejects.toThrow('stop'); expect(late).toHaveBeenCalledTimes(1);
  });
  it('uses lightweight form search and follows native pagination until an empty page', async () => {
    const input = {siteId: 'mangataro', query: ' Sample '};
    const request = vi.fn().mockResolvedValueOnce(JSON.stringify([hit()])).mockResolvedValueOnce('[]');
    const first = await network.search(input, {request});
    expect(first.items[0]).toMatchObject({title: 'Sample', catalogUrl: workUrl, cover: {url: cover}});
    expect(first.items[0].contentLanguages).toBeUndefined();
    expect(await network.search({...input, cursor: first.nextCursor}, {request})).toEqual({items: []});
    expect(request.mock.calls[0]).toEqual([origin + '/wp-json/manga/v1/load', {referer: origin + '/browse', form: {
      page: '1', search: 'Sample', years: '[]', genres: '[]', types: '[]', statuses: '[]', sort: 'latest', genreMatchMode: 'AND'}}]);
  });
  it('rejects forged search targets, duplicate hits and cross-query cursors', () => {
    const input = {siteId: 'mangataro', query: 'sample'};
    for (const rows of [[hit({url: 'https://evil.test/manga/sample'})], [hit(), hit()], [hit({cover: 'file:///x'})], [hit({url: readerUrl})]]) {
      expect(() => parseSearch(JSON.stringify(rows), input)).toThrow();
    }
    expect(() => parseSearch('[]', {...input, cursor: JSON.stringify({query: 'other', page: 2})})).toThrow();
    expect(() => parseSearch('[]', {...input, siteId: 'other'})).toThrow();
    expect(() => parseSearch('{"success":false}', input)).toThrow();
  });
});
