import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { catalog, type CatalogWrite } from '../src/comics/repositories';
import type { Document, DocumentRevision, PageDescriptor } from '../src/comics/domain';

async function fixture() {
  const prefix = crypto.randomUUID(), workId = prefix + ':work', unitId = prefix + ':unit';
  const document: Document = { id: prefix + ':doc', unitId, title: 'Test', sourceBindingId: prefix + ':binding', format: 'zip', revisionId: prefix + ':revision', generation: 1, indexState: 'ready', createdAt: 1, updatedAt: 1 };
  const revision: DocumentRevision = { id: document.revisionId, documentId: document.id, containerId: prefix + ':container', parserVersion: 'zip-v1', indexVersion: 1, generation: 1, status: 'ready', createdAt: 1 };
  await catalog.commit([
    { table: 'connections', value: { id: 'local', provider: 'local', displayName: 'Local', generation: 1, status: 'connected', createdAt: 1, updatedAt: 1 } },
    { table: 'works', value: { id: workId, title: 'Work', createdAt: 1, updatedAt: 1, documentCount: 1 } },
    { table: 'units', value: { id: unitId, workId, title: 'Unit', order: 0, kind: 'book', role: 'main', createdAt: 1, updatedAt: 1 } },
    { table: 'bindings', value: { id: document.sourceBindingId, connectionId: 'local', providerItemId: prefix, locator: { containerId: revision.containerId }, generation: 1, createdAt: 1, updatedAt: 1 } },
    { table: 'documents', value: document }, { table: 'revisions', value: revision },
  ]);
  const page = (ordinal: number): PageDescriptor => ({ pageId: prefix + ':page:' + ordinal, revisionId: revision.id, ordinal, name: `${ordinal}.png`, formatLocator: `zip:${ordinal}`, locator: { entryIndex: ordinal } });
  return { workId, unitId, document, revision, page };
}

describe('catalog records and fences', () => {
  it('indexes a chapter in bounded batches and preserves stable page IDs during indexing retries', async () => {
    const f = await fixture();
    await catalog.putPages(f.document.id, f.revision.id, Array.from({ length: 205 }, (_, ordinal) => f.page(ordinal)), 1);
    expect((await catalog.listPages(f.revision.id)).length).toBe(100);
    expect((await catalog.listPages(f.revision.id, { offset: 100, limit: 100 }))[0].ordinal).toBe(100);
    await catalog.putPages(f.document.id, f.revision.id, [{ ...f.page(20), pageId: 'accidental-new-id', width: 800 }], 1);
    expect(await catalog.get('pageDescriptors', [f.revision.id, f.page(20).pageId])).toMatchObject({ width: 800 });
    expect(await catalog.count('pageDescriptors', { index: 'revisionId', range: f.revision.id })).toBe(205);
  });
  it('keeps work/unit queries local and updates only the requested record', async () => {
    const a = await fixture(), b = await fixture();
    const listener = vi.fn(), unsubscribe = catalog.subscribe(listener);
    await catalog.patch('documents', a.document.id, { title: 'Edited' }, { expectedGeneration: 1 });
    expect((await catalog.get('documents', b.document.id))?.title).toBe('Test');
    expect((await catalog.listUnits(a.workId)).map(item => item.id)).toEqual([a.unitId]);
    expect((await catalog.listDocuments(a.unitId)).map(item => item.id)).toEqual([a.document.id]);
    expect(listener).toHaveBeenCalledWith({ table: 'documents', ids: [a.document.id] }); unsubscribe();
  });
  it('rejects stale index and materialization writes after a generation change or removal', async () => {
    const f = await fixture(); await catalog.putPages(f.document.id, f.revision.id, [f.page(0)], 1);
    const value = { id: 'materialization:' + f.document.id, pageId: f.page(0).pageId, revisionId: f.revision.id, renderProfileId: 'original-v1', imageSha256: 'a'.repeat(64), width: 20, height: 30, byteSize: 40, mime: 'image/png', updatedAt: 1 };
    expect(await catalog.putMaterialization(value, 1)).toBe(true);
    await catalog.patch('documents', f.document.id, { generation: 2 });
    await expect(catalog.putPages(f.document.id, f.revision.id, [f.page(1)], 1)).rejects.toThrow('revision changed');
    expect(await catalog.putMaterialization(value, 1)).toBe(false);
    const released = await catalog.deleteDocument(f.document.id);
    expect(released.revisions).toEqual([f.revision]);
    expect(await catalog.putMaterialization(value, 2)).toBe(false);
    await expect(catalog.put('documents', f.document)).rejects.toThrow('revision changed');
    expect(await catalog.count('pageDescriptors', { index: 'revisionId', range: f.revision.id })).toBe(0);
    expect((await catalog.get('works', f.workId))?.documentCount).toBe(0);
  });
  it('saves positions separately and ignores older updates or revision mismatches', async () => {
    const f = await fixture(), base = { id: f.document.id, documentId: f.document.id, workId: f.workId, revisionId: f.revision.id, pageId: f.page(0).pageId, relativeOffset: .6, updatedAt: 100 };
    await catalog.putPages(f.document.id, f.revision.id, [f.page(0)], 1);
    await catalog.savePosition(base);
    await catalog.savePosition({ ...base, relativeOffset: .1, updatedAt: 99 });
    await catalog.savePosition({ ...base, revisionId: 'wrong-version', relativeOffset: .2, updatedAt: 101 });
    expect(await catalog.get('positions', f.document.id)).toEqual(base);
  });
  it('rolls back the complete registration when one record violates an identity constraint', async () => {
    const f = await fixture(), otherWork = crypto.randomUUID();
    const writes: CatalogWrite[] = [
      { table: 'works', value: { id: otherWork, title: 'Will roll back', createdAt: 2, updatedAt: 2 } },
      { table: 'bindings', value: { ...(await catalog.get('bindings', f.document.sourceBindingId))!, id: crypto.randomUUID() } },
    ];
    await expect(catalog.commit(writes)).rejects.toThrow();
    expect(await catalog.get('works', otherWork)).toBeUndefined();
  });
  it('deletes only a selected work and retains another document sharing the same container', async () => {
    const a = await fixture(), b = await fixture();
    await catalog.patch('revisions', b.revision.id, { containerId: a.revision.containerId });
    await catalog.putPages(a.document.id, a.revision.id, [a.page(0)], 1);
    await catalog.deleteWork(a.workId);
    expect(await catalog.get('works', a.workId)).toBeUndefined();
    expect(await catalog.get('documents', b.document.id)).toEqual(b.document);
    expect((await catalog.get('revisions', b.revision.id))?.containerId).toBe(a.revision.containerId);
  });
});
