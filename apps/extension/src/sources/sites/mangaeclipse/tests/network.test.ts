import {describe, expect, it, vi} from 'vitest';
import {catalogKey, chapterKey, definition, eclipseLocation} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {catalog, catalogHtml, chapterIds, cover, first, image, origin, reader, readerHtml, slug} from './fixtures';

describe('Manga Eclipse', () => {
  it('registers only verified reading capabilities and uses direct HTTP without opening source pages', () => {
    expect(definition.identify(new URL(catalog))).toMatchObject({kind: 'catalog', catalog: {key: catalogKey(slug), url: catalog}});
    expect(definition.identify(new URL(reader))).toMatchObject({kind: 'reader', pageKey: chapterKey({slug, chapter: first})});
    expect(definition).toMatchObject({embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720}});
    expect(definition.installation).toEqual({autoContentMatches: [], optionalContentMatches: [origin + '/*']});
    expect(definition.sites![0]).toMatchObject({adaptedOn: '2026-10-15', primaryLanguages: ['en'], pricing: 'unknown', isRaw: false});
    expect(definition.sites![0].search).toBe(true);
    expect(network.search).toBeTypeOf('function');
    expect(network).not.toHaveProperty('pageTransport');
  });
  it.each(['http://mangaeclipse.com', 'https://www.mangaeclipse.com', 'https://mangaeclipse.com.evil.test',
    'https://mangaeclipse.com:444', 'https://secret@mangaeclipse.com', 'https://webtoonscan.com'])('isolates origin %s', host => {
    expect(definition.identify(new URL(host + '/manga/fixture-book/'))).toBeNull();
  });
  it.each(['chapter-01', '1-trap-part-one', 'chapter-2.5', 'chapter-2-3', '0'])('retains opaque chapter identity %s', chapter => {
    expect(eclipseLocation(new URL(catalog + chapter + '/?style=paged'))).toEqual({slug, chapter});
    expect(definition.identify(new URL(catalog + chapter + '/?style=list'))?.pageKey).toBe(chapterKey({slug, chapter}));
  });
  it.each(['/manhwa/a/', '/manga/a%2fb/', '/manga/a%252fb/', '/manga/a%5cb/', '/manga/a/chapter-1/extra/',
    '/manga/a/?token=x', '/manga/a/chapter-1/?style=unknown', '/manga/a/chapter-1/?style=list&style=paged', '/manga/a/chapter-1/#other'])('does not import unsupported path %s', path => {
    expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
  });
  it('reads the complete static flat version-chap list and removes the title badge', () => {
    const result = validateCatalog(parseCatalog(catalogHtml(), catalog), [definition]);
    expect(result).toMatchObject({id: catalogKey(slug), sourceId: 'mangaeclipse', title: 'Fixture & Book', complete: true, cover: {url: cover}});
    expect(result.entries.map(entry => entry.remoteId)).toEqual([...chapterIds].reverse());
    expect(result.groups[0].entryIds).toEqual(result.entries.map(entry => entry.id));
  });
  it('uses catalog canonical plus exact selected/current chapter identity without h1', () => {
    const result = validatePages(parsePages(readerHtml(), reader), definition.identify(new URL(reader))!);
    expect(result).toMatchObject({adapter: 'mangaeclipse', title: '1 - Trap Part One', discoveryComplete: true, knownTotal: 2});
    expect(result.items.map(item => [item.id, item.order, item.resource])).toEqual([0, 1].map(order =>
      [`image-${order}`, order, {kind: 'http', url: image}]));
  });
  it.each(['canonical', 'cross-site', 'cross-work', 'grouped', 'empty', 'extra-list', 'extra-link'])('rejects %s catalog without claiming completeness', kind => {
    let html = catalogHtml();
    if (kind === 'canonical') html = html.replace(`rel="canonical" href="${catalog}"`, `rel="canonical" href="${reader}"`);
    if (kind === 'cross-site') html = html.replaceAll(origin, 'https://webtoonscan.com');
    if (kind === 'cross-work') html = html.replace(reader, origin + '/manga/other/' + first + '/');
    if (kind === 'grouped') html = html.replace('main version-chap', 'main version-chap has-volumn');
    if (kind === 'empty') html = catalogHtml([]);
    if (kind === 'extra-list') html = html.replace('</ul>', '</ul><ul><li>Unknown volume</li></ul>');
    if (kind === 'extra-link') html = html.replace('</ul>', '<a href="?page=2">More</a></ul>');
    expect(() => parseCatalog(html, catalog)).toThrow();
  });
  it.each(['catalog-canonical', 'chapter-canonical', 'selected-url', 'selected-value', 'current', 'missing-selected',
    'conflicting-title', 'non-contiguous', 'empty', 'unsafe-image', 'credential-image', 'hash-image', 'extra-image'])('rejects %s chapter evidence', kind => {
    let html = readerHtml();
    if (kind === 'catalog-canonical') html = html.replace(`rel="canonical" href="${catalog}"`, `rel="canonical" href="${origin}/manga/other/"`);
    if (kind === 'chapter-canonical') html = html.replace(`rel="canonical" href="${catalog}"`, `rel="canonical" href="${reader}"`);
    if (kind === 'selected-url') html = html.replace(`data-redirect="${reader}"`, `data-redirect="${catalog}chapter-14/"`);
    if (kind === 'selected-value') html = html.replace(`value="${first}" data-redirect`, 'value="chapter-14" data-redirect');
    if (kind === 'current') html = html.replace(`data-id="42" value="${first}"`, 'data-id="42" value="chapter-14"');
    if (kind === 'missing-selected') html = html.replace(' selected="selected"', '');
    if (kind === 'conflicting-title') html = html.replace('>1 - Trap Part One</option>', '>Different chapter title</option>');
    if (kind === 'non-contiguous') html = html.replace('id="image-1"', 'id="image-2"');
    if (kind === 'empty') html = readerHtml([]);
    if (kind === 'unsafe-image') html = html.replace(image, 'javascript:alert(1)');
    if (kind === 'credential-image') html = html.replace(image, 'https://secret@images.example/page.jpg');
    if (kind === 'hash-image') html = html.replace(image, image + '#fragment');
    if (kind === 'extra-image') html = html.replace('class="reading-content">', `class="reading-content"><img src="${image}">`);
    expect(() => parsePages(html, reader)).toThrow();
  });
  it('uses one read per operation, requests list style and preserves previous data on failure', async () => {
    const request = vi.fn().mockResolvedValueOnce(catalogHtml()).mockResolvedValueOnce(readerHtml());
    const previous = parseCatalog(catalogHtml(), catalog), saved = structuredClone(previous);
    await network.catalog!(catalog, {request, previous});
    await network.pages!(reader + '?style=paged', {request});
    expect(request.mock.calls).toEqual([[catalog], [reader + '?style=list']]);
    request.mockRejectedValueOnce(Error('unavailable'));
    await expect(network.catalog!(catalog, {request, previous})).rejects.toThrow('unavailable');
    expect(previous).toEqual(saved);
  });
  it.each(['catalog', 'pages'] as const)('stops cancelled %s requests without a second channel', async operation => {
    const controller = new AbortController(), request = vi.fn(async () => {controller.abort(Error('cancelled')); return '';});
    const invoke = () => network[operation]!(operation === 'catalog' ? catalog : reader, {request, signal: controller.signal});
    await expect(invoke()).rejects.toThrow('cancelled');
    expect(request).toHaveBeenCalledTimes(1); request.mockClear();
    await expect(invoke()).rejects.toThrow('cancelled'); expect(request).not.toHaveBeenCalled();
  });
});
