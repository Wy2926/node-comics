import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importCatalog} from '../src/comics/application/import-service';
import {applyCatalogRefresh} from '../src/comics/application/catalog-service';
import {validateCatalog} from '../src/sources/core/catalog';
import {definition} from '../src/sources/sites/mangadex/definition';
import {parseCatalog} from '../src/sources/sites/mangadex/network';
import {aggregate, chapter, manga, mangaId} from '../src/sources/sites/mangadex/tests/fixtures';

const snapshot = () => {
  const rows = [chapter(1, 'en', '12'), chapter(2, 'es', '12'), chapter(3, 'en', '12.5'), chapter(4, 'en', '12a')];
  return {...parseCatalog(manga(), rows, aggregate(rows), mangaId), externalIds: {anilist: 30001, myAnimeList: 1}};
};
afterEach(async () => {
  for (const comic of await catalog.list('comics', {limit: 10000})) await catalog.deleteComic(comic.id);
});

describe('source-native tracker evidence', () => {
  it('validates and retains labels verbatim and keeps external ID namespaces separate', () => {
    const source = snapshot();
    source.entries[0].chapterNumber = 'Special';
    const result = validateCatalog({...source, externalIds: {...source.externalIds, unknown: 'ignored'}}, [definition]);
    expect(result.entries.map(entry => entry.chapterNumber)).toEqual(['Special', '12', '12a', '12.5']);
    expect(result.externalIds).toEqual({anilist: 30001, myAnimeList: 1});
    expect(result.externalIds).not.toBe(source.externalIds);
  });

  it.each([null, 12, '', ' ', ' 12', '12 ', '12\n', '12\u0000', 'a'.repeat(65)])('rejects invalid chapter evidence %s', chapterNumber => {
    const source = snapshot();
    const entries = [{...source.entries[0], chapterNumber}, ...source.entries.slice(1)];
    expect(() => validateCatalog({...source, entries}, [definition])).toThrow('INVALID_SOURCE_CATALOG');
  });

  it.each([null, [], '30001', {anilist: 0}, {anilist: -1}, {anilist: 1.5}, {anilist: '30001'},
    {myAnimeList: true}, {myAnimeList: Number.MAX_SAFE_INTEGER + 1}])('rejects invalid tracker IDs %s', externalIds => {
    expect(() => validateCatalog({...snapshot(), externalIds}, [definition])).toThrow('INVALID_SOURCE_CATALOG');
  });

  it('projects native evidence through import and refresh while preserving independent release and reading identities', async () => {
    const source = snapshot(), comic = await importCatalog(source), entries = await catalog.listEntries(comic.id);
    expect(entries.map(entry => entry.chapterNumber)).toEqual(['12', '12', '12a', '12.5']);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(4);
    expect((await catalog.get('catalogs', source.id))?.externalIds).toEqual(source.externalIds);
    const current = entries.find(entry => entry.sourceEntryId === source.entries[0].id)!;
    await catalog.patch('entries', current.id, {readAt: 123});
    const refreshed = {...source, observedAt: source.observedAt + 1, entries: source.entries.map((entry, index) => ({...entry,
      title: 'Renamed ' + index, chapterNumber: index === 0 ? '12.0' : entry.chapterNumber}))};
    await applyCatalogRefresh(comic.id, comic.source.generation, refreshed);
    expect(await catalog.get('entries', current.id)).toMatchObject({chapterNumber: '12.0', contentId: current.contentId,
      generation: current.generation, readAt: 123, sourceEntryId: current.sourceEntryId, readingSlotId: current.readingSlotId});
    expect((await catalog.get('catalogs', source.id))?.externalIds).toEqual(source.externalIds);
    // A later source observation can retract evidence. Do not retain a stale tracker ordinal.
    await applyCatalogRefresh(comic.id, comic.source.generation, {...refreshed, observedAt: refreshed.observedAt + 1,
      externalIds: undefined, entries: refreshed.entries.map(entry => ({...entry, chapterNumber: undefined}))});
    expect((await catalog.get('entries', current.id))?.chapterNumber).toBeUndefined();
    expect((await catalog.get('catalogs', source.id))?.externalIds).toBeUndefined();
    expect(await catalog.get('entries', current.id)).toMatchObject({contentId: current.contentId, readAt: 123});
  });
});
