import {describe, expect, it, vi} from 'vitest';
import {definition, catalogUrl, releaseUrl} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {language} from '../protocol';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {chapter, chapters, images, metadata, volumes} from './fixtures';

const url = catalogUrl('7'), reader = releaseUrl('1', 'user', 'chapter', '7');
describe('MangaDot full HTTP source', () => {
  it('claims only its HTTPS host and keeps scraper, upload, and volume identities distinct', () => {
    expect(definition.identify(new URL(url))?.catalog?.key).toBe('mangadot:7');
    const urls = [releaseUrl('1', 'scraper', 'chapter'), reader, releaseUrl('1', 'user', 'volume')];
    expect(urls.map(url => definition.identify(new URL(url))?.pageKey)).toEqual(['mangadot:scraper:chapter:1', 'mangadot:user:chapter:1', 'mangadot:user:volume:1']);
    expect(definition.identify(new URL(reader))?.catalog?.url).toBe(url);
    expect(definition.identify(new URL(urls[0] + '#p=3'))?.pageKey).toBe('mangadot:scraper:chapter:1');
    for (const bad of ['http://mangadot.net/manga/7', 'https://mangadot.net.evil.test/manga/7', 'https://mangadot.net:4433/manga/7', 'https://u:p@mangadot.net/manga/7'])
      expect(definition.identify(new URL(bad))).toBeNull();
    for (const bad of ['/manga/0', '/manga/7/ch/1', '/chapter/1?source=unknown', '/chapter/1?source=user&source=scraper', '/volume/1?source=scraper', '/chapter/1#nodelane-mangadot=bad'])
      expect(definition.identify(new URL('https://mangadot.net' + bad))?.kind).toBe('other');
    expect(definition.installation.optionalOrigins).toEqual(['https://mangadot.net/*']);
    expect(definition.catalogSync?.intervalMinutes).toBe(720);
  });
  it('merges source-declared positions across languages while separating whole volumes and preserving release identity', () => {
    const result = validateCatalog(parseCatalog(metadata(), chapters(), volumes(), '7'), [definition]);
    expect(result.entries).toHaveLength(6);
    expect(new Set(result.entries.map(e => e.id)).size).toBe(6);
    expect(result.entries.slice(0, 4).map(e => e.order)).toEqual([0, 0, 0, 0]);
    expect(new Set(result.entries.slice(0, 4).map(e => e.readingSlotId)).size).toBe(1);
    expect(new Set(result.entries.slice(0, 4).map(e => e.contentLanguage))).toEqual(new Set(['en', 'fr', 'es']));
    expect(result.entries.at(-1)?.sequenceId).not.toBe(result.entries[0].sequenceId);
    expect(result.groups.map(group => group.entryIds.length)).toEqual([5, 1]);
    expect(result.entries.find(e => e.id === 'mangadot:user:chapter:2')?.rawTypes).toEqual(['Fixture Group']);
    for (const entry of result.entries) expect(definition.identify(new URL(entry.url))?.pageKey).toBe(entry.id);
    expect(result.cover?.url).toBe('https://mangadot.net/uploads/cover.webp');
  });
  it('orders decimal chapters, picks oldest releases deterministically and marks empty releases unreadable', () => {
    const rows = [chapter(2, 'fr', 1.5), chapter(4, 'en', 1.25), {...chapter(1, 'en', 1.25), page_count: 0}];
    const meta = metadata(); meta.total_volumes = 0;
    const result = parseCatalog(meta, rows, [], '7');
    expect(result.entries.map(e => e.remoteId)).toEqual(['user:chapter:1', 'user:chapter:4', 'user:chapter:2']);
    expect(result.entries[0].readable).toBe(false);
    expect(result.defaultEntryId).toBe(result.entries[1].id);
    expect(['zh', 'zh-hk', 'pt-br', 'fr', undefined].map(language)).toEqual(['zh-Hans', 'zh-HK', 'pt-BR', 'fr', undefined]);
  });
  it.each(['duplicate', 'owner', 'count', 'missing-chapter', 'missing-volume', 'language', 'cover', 'source'])('rejects %s instead of declaring a partial catalog complete', mode => {
    const meta = metadata(), rows = chapters(), vols = volumes();
    if (mode === 'duplicate') rows.push(rows[0]);
    if (mode === 'owner') meta.manga.id = 8;
    if (mode === 'count') meta.total_chapters++;
    if (mode === 'missing-chapter') rows.splice(3, 1);
    if (mode === 'missing-volume') vols.pop();
    if (mode === 'language') rows[0].language = 'bad-language-tag';
    if (mode === 'cover') meta.manga.photo = 'https://evil.test/cover.webp';
    if (mode === 'source') rows[0].source = 'unknown';
    expect(() => parseCatalog(meta, rows, vols, '7')).toThrow();
  });
  it('uses three unfiltered API reads with explicit source Referer and leaves previous catalogs untouched on failure', async () => {
    const previous = parseCatalog(metadata(), chapters(), volumes(), '7'), before = structuredClone(previous);
    const request = vi.fn(async (target: string) => JSON.stringify(target.endsWith('/chapters/list') ? chapters() : target.endsWith('/volumes') ? volumes() : metadata()));
    expect((await network.catalog(url, {request, previous})).entries).toHaveLength(6);
    expect(request.mock.calls.map(call => call[0])).toEqual(['https://mangadot.net/api/manga/7', 'https://mangadot.net/api/manga/7/chapters/list', 'https://mangadot.net/api/manga/7/volumes']);
    expect(request).toHaveBeenCalledWith('https://mangadot.net/api/manga/7', {referer: url});
    await expect(network.catalog(url, {previous, request: async () => 'Just a moment...'})).rejects.toThrow('验证');
    expect(previous).toEqual(before);
  });
  it('preserves duplicate image URLs as distinct slots and validates complete pages with the common contract', () => {
    const snapshot = validatePages(parsePages(images(), reader), definition.identify(new URL(reader))!);
    expect(snapshot.knownTotal).toBe(3);
    expect(snapshot.items.map(e => [e.id, e.order])).toEqual([['page-0', 0], ['page-1', 1], ['page-2', 2]]);
    expect(snapshot.items[1].resource).toEqual(snapshot.items[2].resource);
  });
  it.each(['owner', 'id', 'type', 'source', 'missing', 'empty', 'foreign-image', 'other-work-image', 'credentials', 'status'])('rejects %s image data', mode => {
    const data = images();
    if (mode === 'owner') data.chapter.manga_id = 8;
    if (mode === 'id') data.chapter.id = 2;
    if (mode === 'type') data.type = 'volume';
    if (mode === 'source') data.source = 'scraper';
    if (mode === 'missing') data.images.pop();
    if (mode === 'empty') {data.images = []; data.chapter.page_count = 0;}
    if (mode === 'foreign-image') data.images[0].url = 'https://mangadot.net.evil.test/chapters/manga_7/first/1.webp';
    if (mode === 'other-work-image') data.images[0].url = '/chapters/manga_8/first/1.webp';
    if (mode === 'credentials') data.images[0].url = 'https://u:p@mangadot.net/chapters/manga_7/first/1.webp';
    if (mode === 'status') data.chapter.status = 'pending';
    expect(() => parsePages(data, reader)).toThrow();
  });
  it('resolves bare chapter/upload/volume ownership through the appropriate API and rejects conflicting bindings', async () => {
    for (const [source, kind] of [['scraper', 'chapter'], ['user', 'chapter'], ['user', 'volume']] as const) {
      const target = releaseUrl('1', source, kind), request = vi.fn(async () => JSON.stringify(images(1, source, kind)));
      expect(await network.resolveCatalog(target, {request})).toBe(url);
      expect((await network.pages(target, {request})).items).toHaveLength(3);
      expect(request).toHaveBeenCalledWith(`https://mangadot.net/api/${source === 'user' ? 'uploads' : 'chapters'}/1/images`, {referer: target});
      await expect(network.resolveCatalog(releaseUrl('1', source, kind, '8'), {request})).rejects.toThrow();
    }
  });
  it('aborts before requests and after responses without parsing or switching transport', async () => {
    const controller = new AbortController(); controller.abort(); const request = vi.fn();
    await expect(network.catalog(url, {request, signal: controller.signal})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    const pending = new AbortController();
    await expect(network.pages(reader, {signal: pending.signal, request: async () => {pending.abort(); return JSON.stringify(images());}})).rejects.toThrow();
  });
});
