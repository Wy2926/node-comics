import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {catalog, type CatalogWrite} from '../src/comics/repositories';
import type {Document, ReadingPosition, ReadingUnit, Work} from '../src/comics/domain';
import {continueDocument, getReadingUnit, getWork, listLibrary, listWorkUnits, loadDocument, loadWorkDetails, markRead, preferredDocument, readerSequence, removeDocument, searchWorks, searchWorkUnits} from '../src/comics/application/library-service';
import {moveDocument, reorderReadingUnits, setPreferredDocument, setUnitRead, setWorkCover, updateDocument, updateReadingUnit, updateWork} from '../src/comics/application/work-management';

async function fixture(counts = [2, 1, 1]) {
  const prefix = crypto.randomUUID(), now = Date.now();
  const work: Work = {id: prefix, title: 'Work ' + prefix, createdAt: now, updatedAt: now, documentCount: counts.reduce((sum, count) => sum + count, 0)};
  const units: ReadingUnit[] = counts.map((_, index) => ({id: `${prefix}:unit-${index}`, workId: work.id, title: `Unit ${index}`, order: index * 10, kind: 'chapter', role: 'main', createdAt: now, updatedAt: now}));
  const documents: Document[] = counts.flatMap((count, index) => Array.from({length: count}, (_, version): Document => {
    const id = `${prefix}:unit-${index}:version-${version}`;
    return {id, unitId: units[index].id, sourceBindingId: id + ':binding', format: 'image', revisionId: id + ':revision',
      title: `Version ${version}`, generation: 1, indexState: 'ready', pageCount: 1, coverPageId: id + ':page', createdAt: now, updatedAt: now};
  }));
  for (const unit of units) unit.preferredDocumentId = documents.find(document => document.unitId === unit.id)?.id;
  const records: CatalogWrite[] = [{table: 'works', value: work}, ...units.map(value => ({table: 'units' as const, value}))];
  for (const document of documents) records.push(
    {table: 'documents', value: document},
    {table: 'bindings', value: {id: document.sourceBindingId, connectionId: prefix + ':connection', providerItemId: document.id, locator: {}, generation: 1, createdAt: now, updatedAt: now}},
    {table: 'revisions', value: {id: document.revisionId, documentId: document.id, parserVersion: 'test', indexVersion: 1, generation: 1, status: 'ready', createdAt: now}},
    {table: 'pageDescriptors', value: {pageId: document.coverPageId!, revisionId: document.revisionId, ordinal: 0, name: 'page.png', locator: {image: 0}, formatLocator: 'image:0'}},
  );
  await catalog.commit(records);
  return {work, units, documents};
}
const position = (work: Work, document: Document, updatedAt: number): ReadingPosition => ({
  id: document.id, workId: work.id, documentId: document.id, revisionId: document.revisionId, pageId: document.coverPageId!, relativeOffset: .4, updatedAt,
});

describe('work metadata and relationship management', () => {
  it('normalizes editable metadata and preserves concurrent edits and source identity', async () => {
    const {work, units, documents} = await fixture();
    await Promise.all([updateWork(work.id, {title: ' Renamed ', aliases: [' Alias ', '', 'Alias']}), updateWork(work.id, {description: ' About this book ', creators: [' Author ', 'Author']})]);
    expect(await getWork(work.id)).toMatchObject({title: 'Renamed', aliases: ['Alias'], description: 'About this book', creators: ['Author']});
    await updateReadingUnit(units[0].id, {title: ' Bonus ', kind: 'volume', role: 'extra'});
    expect(await getReadingUnit(units[0].id)).toMatchObject({title: 'Bonus', kind: 'volume', role: 'extra'});
    await updateDocument(documents[0].id, {title: ' Scan edition ', language: ' ja ', versionLabel: ' Original scan '});
    expect(await catalog.get('documents', documents[0].id)).toMatchObject({title: 'Scan edition', language: 'ja', versionLabel: 'Original scan', revisionId: documents[0].revisionId, sourceBindingId: documents[0].sourceBindingId, generation: 1});
    await expect(updateWork(work.id, {title: ' '})).rejects.toThrow('标题');
    await expect(updateReadingUnit(units[0].id, {kind: 'invalid' as ReadingUnit['kind']})).rejects.toThrow('类型');
    await expect(updateDocument('missing', {title: 'Title'})).rejects.toThrow('已移除');
  });

  it('sets read status for whole reading units and atomically rejects a stale bulk selection', async () => {
    const {work, units, documents} = await fixture();
    await expect(setUnitRead([units[0].id, 'missing-unit'], true)).rejects.toThrow('已移除');
    expect((await getReadingUnit(units[0].id))?.readAt).toBeUndefined();
    await setUnitRead([units[0].id, units[0].id, units[1].id], true);
    const readAt = (await getReadingUnit(units[0].id))!.readAt; expect(readAt).toBeTypeOf('number');
    await markRead(documents[1].id); expect((await getReadingUnit(units[0].id))?.readAt).toBe(readAt);
    const sequence = await readerSequence(documents[1].id); expect(sequence.directory.entries.find(entry => entry.current)?.read).toBe(true);
    await setUnitRead([units[0].id], false); expect((await getReadingUnit(units[0].id))?.readAt).toBeUndefined();
    await markRead(documents[1].id); expect((await getReadingUnit(units[0].id))?.readAt).toBeTypeOf('number');
    expect((await getWork(work.id))?.documentCount).toBe(documents.length);
  });

  it('sets only a document from the same unit as preferred', async () => {
    const {units, documents} = await fixture();
    await expect(setPreferredDocument(units[0].id, documents[2].id)).rejects.toThrow('不属于');
    expect((await getReadingUnit(units[0].id))?.preferredDocumentId).toBe(documents[0].id);
    await setPreferredDocument(units[0].id, documents[1].id);
    expect((await getReadingUnit(units[0].id))?.preferredDocumentId).toBe(documents[1].id);
  });

  it('moves a version within its work while repairing preference and preserving its reading position', async () => {
    const {work, units, documents} = await fixture(), saved = position(work, documents[0], Date.now());
    await catalog.savePosition(saved); const previousPosition = await catalog.get('positions', documents[0].id);
    await moveDocument(documents[0].id, units[1].id);
    expect((await catalog.get('documents', documents[0].id))?.unitId).toBe(units[1].id);
    expect((await getReadingUnit(units[0].id))?.preferredDocumentId).toBe(documents[1].id);
    expect((await getReadingUnit(units[1].id))?.preferredDocumentId).toBe(documents[2].id);
    expect(await catalog.get('positions', documents[0].id)).toEqual(previousPosition);
    expect((await loadDocument(documents[0].id)).pageId).toBe(saved.pageId);
    expect((await getWork(work.id))?.documentCount).toBe(documents.length);
    await moveDocument(documents[1].id, units[1].id); expect(await getReadingUnit(units[0].id)).toBeUndefined();
    const foreign = await fixture([1]);
    await expect(moveDocument(documents[0].id, foreign.units[0].id)).rejects.toThrow('同一作品');
    expect((await catalog.get('documents', documents[0].id))?.unitId).toBe(units[1].id);
  });

  it('requires a complete unique ordering and persists all new positions together', async () => {
    const {work, units} = await fixture();
    await expect(reorderReadingUnits(work.id, [units[0].id, units[0].id, units[2].id])).rejects.toThrow('不重复');
    await expect(reorderReadingUnits(work.id, [units[0].id, units[1].id])).rejects.toThrow('已变化');
    expect((await listWorkUnits(work.id)).map(unit => unit.id)).toEqual(units.map(unit => unit.id));
    const reversed = units.map(unit => unit.id).reverse(); await reorderReadingUnits(work.id, reversed);
    expect((await listWorkUnits(work.id)).map(unit => unit.id)).toEqual(reversed);
    expect((await listWorkUnits(work.id)).map(unit => unit.order)).toEqual([0, 1, 2]);
    await catalog.remove('units', units[1].id);
    await expect(reorderReadingUnits(work.id, reversed)).rejects.toThrow('已变化');
    expect((await listWorkUnits(work.id)).map(unit => unit.order)).toEqual([0, 2]);
  });

  it('selects a real current revision cover and clears it when the document is deleted', async () => {
    const {work, units, documents} = await fixture(), foreign = await fixture([1]);
    await expect(setWorkCover(work.id, foreign.documents[0].id)).rejects.toThrow('不属于');
    await setWorkCover(work.id, documents[0].id);
    expect((await getWork(work.id))?.cover).toEqual({documentId: documents[0].id, revisionId: documents[0].revisionId, pageId: documents[0].coverPageId});
    await catalog.patch('documents', documents[1].id, {coverPageId: 'missing-page'});
    await expect(setWorkCover(work.id, documents[1].id)).rejects.toThrow('尚无');
    await removeDocument(documents[0].id); expect((await getWork(work.id))?.cover).toBeUndefined();
    expect((await getReadingUnit(units[0].id))?.preferredDocumentId).toBe(documents[1].id);
    await removeDocument(documents[1].id); expect(await getReadingUnit(units[0].id)).toBeUndefined();
  });

  it('does not resurrect a moved document or unit when deletion races management writes', async () => {
    const {work, units, documents} = await fixture();
    await Promise.allSettled([moveDocument(documents[0].id, units[1].id), removeDocument(documents[0].id), updateDocument(documents[0].id, {title: 'Late edit'})]);
    expect(await catalog.get('documents', documents[0].id)).toBeUndefined();
    const persistedUnits = await listWorkUnits(work.id);
    for (const unit of persistedUnits) if (unit.preferredDocumentId) expect((await catalog.get('documents', unit.preferredDocumentId))?.unitId).toBe(unit.id);
    expect((await getWork(work.id))?.documentCount).toBe(documents.length - 1);
  });

  it('does not remove a version moved out of the selected unit before a bulk deletion', async () => {
    const {work, units, documents} = await fixture();
    await moveDocument(documents[0].id, units[1].id);
    await expect(removeDocument(documents[0].id, {expectedUnitId: units[0].id})).rejects.toThrow('归属已变化');
    expect((await catalog.get('documents', documents[0].id))?.unitId).toBe(units[1].id);
    expect(await catalog.get('revisions', documents[0].revisionId)).toBeDefined();
    expect((await getWork(work.id))?.documentCount).toBe(documents.length);
    await removeDocument(documents[0].id, {expectedUnitId: units[1].id});
    expect(await catalog.get('documents', documents[0].id)).toBeUndefined();
    await removeDocument(documents[1].id);
    expect(await getReadingUnit(units[0].id)).toBeUndefined();
  });
});

describe('document preference, continuation and metadata search', () => {
  it('keeps the explicitly opened version even when a preferred version appears first', async () => {
    const {work, units, documents} = await fixture();
    const recent = position(work, documents[1], Date.now()); await catalog.savePosition(recent);
    expect(preferredDocument(units[0], documents, [recent])?.id).toBe(documents[0].id);
    expect(preferredDocument(units[0], documents, [recent], documents[1].id)?.id).toBe(documents[1].id);
    const sequence = await readerSequence(documents[1].id);
    expect(sequence.copies.some(copy => copy.id === documents[1].id && copy.pages.length === 1)).toBe(true);
    expect(sequence.copies.some(copy => copy.id === documents[0].id)).toBe(false);
    expect(sequence.directory.entries.find(entry => entry.current)?.id).toBe(documents[1].id);
    expect(sequence.directory.entries.find(entry => entry.current)?.title).toBe(units[0].title);
    const library = await listLibrary(0, 100), listed = library.works.some(value => value.id === work.id); expect(listed).toBe(true);
    expect(library.positions?.find(value => value.documentId === documents[1].id)).toEqual(recent);
    expect(continueDocument(work.id, library)?.id).toBe(documents[1].id);
  });

  it('ignores stale revision positions and chooses the first unread available unit when no progress exists', async () => {
    const {work, units, documents} = await fixture();
    const stale = {...position(work, documents[1], Date.now()), revisionId: 'old-revision'};
    const first = {...units[0], preferredDocumentId: undefined};
    const candidates = documents.map(document => document.id === documents[0].id ? {...document, indexState: 'failed' as const} : document);
    expect(preferredDocument(first, candidates, [stale])?.id).toBe(documents[1].id);
    expect(continueDocument(work.id, {works: [work], units: [{...units[0], readAt: 1}, ...units.slice(1)], documents, positions: [stale]})?.id).toBe(documents[2].id);
  });

  it('retains current and recent documents beyond the default per-unit metadata page', async () => {
    const {work, units, documents} = await fixture([101]), current = documents[99];
    expect((await catalog.listDocuments(units[0].id)).some(document => document.id === current.id)).toBe(false);
    await catalog.savePosition(position(work, current, Date.now()));
    expect((await readerSequence(current.id)).copies.map(copy => copy.id)).toEqual([current.id]);
    expect(continueDocument(work.id, await listLibrary(0, 100))?.id).toBe(current.id);
  });

  it('loads complete metadata for only the requested work and opens units beyond the shelf limit', async () => {
    const {work, units, documents} = await fixture([101, ...Array.from({length: 1000}, () => 1)]);
    const foreign = await fixture([1]), current = documents.at(-1)!;
    await catalog.put('connections', {id: work.id + ':connection', provider: 'fixture', displayName: 'Test library source', status: 'connected', generation: 1, createdAt: 1, updatedAt: 1});
    await catalog.savePosition(position(work, current, Date.now()));
    const details = await loadWorkDetails(work.id);
    expect(details?.works.map(value => value.id)).toEqual([work.id]);
    expect(details?.units).toHaveLength(1001); expect(details?.documents).toHaveLength(1101);
    expect(details?.documents.some(value => value.id === foreign.documents[0].id)).toBe(false);
    expect(Object.keys(details?.sourceLabels ?? {})).toHaveLength(documents.length);
    expect(details?.sourceLabels?.[current.id]).toBe('Test library source');
    expect(details?.positions?.map(value => value.documentId)).toEqual([current.id]);
    expect(continueDocument(work.id, details!)?.id).toBe(current.id);
    const shelf = await listLibrary(0, 100);
    expect(shelf.units.some(unit => unit.id === units.at(-1)!.id)).toBe(true);
    expect(continueDocument(work.id, shelf)?.id).toBe(current.id);
    const sequence = await readerSequence(current.id);
    expect(sequence.directory.entries).toHaveLength(units.length);
    expect(sequence.directory.entries.find(entry => entry.current)?.id).toBe(current.id);
    expect(sequence.copies.find(copy => copy.id === current.id)?.pages).toHaveLength(1);
    expect(sequence.copies.filter(copy => copy.pages.length)).toHaveLength(2);
    expect(await loadWorkDetails('missing-work')).toBeUndefined();
  }, 20000);

  it('adds only selected cover and preferred versions beyond the shelf metadata page', async () => {
    const {work, units, documents} = await fixture([103]);
    const page = new Set((await catalog.listDocuments(units[0].id)).map(document => document.id));
    const omitted = documents.filter(document => !page.has(document.id)); expect(omitted).toHaveLength(3);
    await setWorkCover(work.id, omitted[0].id); await setPreferredDocument(units[0].id, omitted[1].id);
    const shelf = await listLibrary(0, 100), listedWork = shelf.works.find(value => value.id === work.id)!;
    const listedUnit = shelf.units.find(value => value.id === units[0].id)!;
    const versions = shelf.documents.filter(document => document.unitId === units[0].id);
    expect(versions).toHaveLength(102);
    expect(versions.find(document => document.id === listedWork.cover?.documentId)?.revisionId).toBe(listedWork.cover?.revisionId);
    expect(preferredDocument(listedUnit, versions)?.id).toBe(omitted[1].id);
    expect(versions.some(document => document.id === omitted[2].id)).toBe(false);
  });

  it('searches and paginates all work metadata and unit titles outside the current shelf page', async () => {
    const query = 'Search ' + crypto.randomUUID(), entries: Work[] = [];
    for (let index = 0; index < 55; index++) entries.push({id: crypto.randomUUID(), title: `${query} ${index}`, aliases: index === 0 ? ['Unique alias ' + query] : [], creators: ['Creator ' + query], createdAt: 1, updatedAt: index});
    await catalog.commit(entries.map(value => ({table: 'works', value})));
    const first = await searchWorks(query, 0, 30), second = await searchWorks(query, first.nextOffset, 30);
    expect(first.works).toHaveLength(30); expect(second.works).toHaveLength(25); expect(second.nextOffset).toBeUndefined();
    expect(new Set([...first.works, ...second.works].map(work => work.id)).size).toBe(55);
    expect((await searchWorks('Unique alias ' + query)).works.map(work => work.id)).toEqual([entries[0].id]);
    expect((await searchWorks('Creator ' + query, 0, 100)).works).toHaveLength(55);
    const {work, units} = await fixture([1, 1, 1]);
    expect((await searchWorkUnits(work.id, 'Unit', 0, 2)).nextOffset).toBe(2);
    expect((await searchWorkUnits(work.id, 'Unit', 2, 2)).units.map(unit => unit.id)).toEqual([units[2].id]);
    expect((await searchWorkUnits(work.id, 'Unit 1')).units.map(unit => unit.id)).toEqual([units[1].id]);
  });
});
