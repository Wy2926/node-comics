import 'fake-indexeddb/auto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importSourceFiles, registerDocument, reindexDocument} from '../src/comics/application/import-service';
import {removeDocument} from '../src/comics/application/library-service';
import {disconnectSource, initializeSources, invalidateSourceAccess, reconnectSource, storageOverview} from '../src/comics/application/source-lifecycle';
import {chooseSourceFiles, sourceImportOptions} from '../src/comics/application/source-service';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {openFileSource} from '../src/comics/sources/runtime';
import type {OpenFileSourceContext, SelectedSourceFile, SourceAccessChange, SourceSelection} from '../src/comics/sources/contracts';
import type {SourceConnection} from '../src/comics/domain';
import {sourcePageCache} from '../src/storage/source-pages';

const format = vi.hoisted(() => ({index: vi.fn(), close: vi.fn()}));
vi.mock('../src/comics/formats', () => ({openDocument: async () => ({index: format.index, close: format.close})}));
const select = vi.fn(), disconnect = vi.fn(), close = vi.fn();
let open = vi.fn(), disposers: (() => void)[] = [], changed: ((change: SourceAccessChange) => Promise<void>) | undefined;
const assignment = () => ({title: 'Source ' + crypto.randomUUID(), kind: 'book' as const});
const connection = () => ({id: 'opaque-connection-' + crypto.randomUUID(), provider: 'fixture-cloud', accountId: crypto.randomUUID(), displayName: 'Fixture account'});
const file = (id: string = crypto.randomUUID(), version = 'one'): SelectedSourceFile => ({
  id, name: id + '.cbz', format: 'cbz', sourceKey: JSON.stringify(['fixture-cloud', id, version]),
  locator: {opaqueResource: id}, snapshot: {opaqueResource: id, version, size: 16},
});
const selection = (): SourceSelection => ({connection: connection(), files: [file()]});
async function record(id: string) {
  const document = (await catalog.get('documents', id))!, binding = (await catalog.get('bindings', document.sourceBindingId))!;
  return {document, binding, connection: (await catalog.get('connections', binding.connectionId))!, revision: (await catalog.get('revisions', document.revisionId))!};
}
beforeEach(() => {
  format.index.mockReset().mockResolvedValue([{ordinal: 0, name: 'page.png', locator: {entry: 0}}]);
  format.close.mockReset().mockResolvedValue(undefined); close.mockReset().mockResolvedValue(undefined);
  select.mockReset(); disconnect.mockReset().mockResolvedValue(undefined);
  open = vi.fn(async (context: OpenFileSourceContext) => ({
    snapshot: {identity: context.binding.providerItemId, version: String(context.revision.sourceSnapshot?.version), size: 16, local: false},
    readAt: async (_offset: number, length: number) => new Uint8Array(length), validate: async () => 'unchanged' as const, close,
  }));
  disposers = [registerSourceDriver({id: 'fixture-cloud', label: 'Fixture cloud', cachePages: true, cacheRanges: false,
    open, select, disconnect, subscribe(listener) { changed = listener; return () => { changed = undefined; }; }})];
});
afterEach(() => { for (const dispose of disposers) dispose(); disposers = []; });

describe('provider-independent source application', () => {
  it('lists selectable registered providers and rejects unconfigured or mismatched selections', async () => {
    disposers.push(registerSourceDriver({id: 'fixture-disabled', label: 'Disabled', cachePages: false, cacheRanges: false, open, select, isConfigured: () => false}));
    disposers.push(registerSourceDriver({id: 'fixture-passive', label: 'Passive', cachePages: false, cacheRanges: false, open}));
    expect(sourceImportOptions()).toEqual([{id: 'fixture-cloud', label: 'Fixture cloud', configured: true}, {id: 'fixture-disabled', label: 'Disabled', configured: false}]);
    await expect(chooseSourceFiles('fixture-disabled')).rejects.toThrow('尚未配置');
    await expect(chooseSourceFiles('fixture-passive')).rejects.toThrow('不提供');
    const selected = selection(); select.mockResolvedValue(selected);
    expect(await chooseSourceFiles('fixture-cloud')).toEqual(selected);
    select.mockResolvedValue({...selected, connection: {...selected.connection, provider: 'different-source'}});
    await expect(chooseSourceFiles('fixture-cloud')).rejects.toThrow('来源身份');
    expect(open).not.toHaveBeenCalled();
  });

  it('imports and indexes an opaque provider snapshot through its registered driver', async () => {
    const selected = selection(), [id] = await importSourceFiles(selected, assignment()), saved = await record(id);
    expect(saved.binding.providerItemId).toBe(selected.files[0].id);
    expect(saved.binding.locator).toEqual(selected.files[0].locator);
    expect(saved.revision.sourceSnapshot).toEqual(selected.files[0].snapshot);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({connection: saved.connection, binding: saved.binding, revision: expect.objectContaining({sourceSnapshot: selected.files[0].snapshot}), documentId: id, format: 'cbz'}));
    expect(saved.document.indexState).toBe('ready'); expect(close).toHaveBeenCalledOnce();
    expect(await importSourceFiles(selected, assignment())).toEqual([id]); expect(open).toHaveBeenCalledOnce();
  });

  it('retries a failed existing index when the same source files are selected again', async () => {
    const selected = selection(); format.index.mockRejectedValueOnce(Error('temporary source failure'));
    await expect(importSourceFiles(selected, assignment())).rejects.toThrow('temporary source failure');
    const saved = (await catalog.list('documents', {index: 'sourceKey', range: selected.files[0].sourceKey, limit: 1}))[0];
    expect(saved.indexState).toBe('failed');
    expect(await importSourceFiles(selected, assignment())).toEqual([saved.id]);
    expect((await catalog.get('documents', saved.id))?.indexState).toBe('ready'); expect(open).toHaveBeenCalledTimes(2);
  });

  it('revokes all versions of one stable item without affecting another item or connection', async () => {
    const selected = selection(), target = selected.files[0], next = file(target.id, 'two'), sibling = file();
    const ids = await importSourceFiles({...selected, files: [target, next, sibling]}, assignment());
    expect((await record(ids[0])).binding.id).toBe((await record(ids[1])).binding.id);
    const other = selection(); other.files = [{...target, sourceKey: target.sourceKey + ':other-account'}];
    const [otherId] = await importSourceFiles(other, assignment());
    await invalidateSourceAccess({connectionId: selected.connection.id, itemId: target.id});
    expect((await record(ids[0])).binding.status).toBe('revoked'); expect((await record(ids[1])).binding.status).toBe('revoked');
    expect((await record(ids[2])).binding.status).toBeUndefined(); expect((await record(otherId)).binding.status).toBeUndefined();
    expect((await record(ids[0])).connection.status).toBe('connected');
  });

  it('keeps a shared binding and frozen source snapshots when one document version is removed', async () => {
    const selected = selection(), first = selected.files[0], second = file(first.id, 'two');
    const ids = await importSourceFiles({...selected, files: [first, second]}, assignment());
    const original = await record(ids[0]), retained = await record(ids[1]);
    expect(retained.binding.id).toBe(original.binding.id); expect(retained.revision.sourceSnapshot).toEqual(second.snapshot);
    await removeDocument(ids[0]); expect(await catalog.get('bindings', retained.binding.id)).toBeDefined();
    await reindexDocument(ids[1]);
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({revision: expect.objectContaining({sourceSnapshot: second.snapshot})}));
    expect((await record(ids[1])).document.indexState).toBe('ready');
  });

  it('registers concurrent first versions using one stable source binding', async () => {
    const selected = selection(), first = selected.files[0], second = file(first.id, 'two');
    const [firstIds, secondIds] = await Promise.all([
      importSourceFiles({...selected, files: [first]}, assignment()), importSourceFiles({...selected, files: [second]}, assignment()),
    ]);
    const firstRecord = await record(firstIds[0]), secondRecord = await record(secondIds[0]);
    expect(firstRecord.binding.id).toBe(secondRecord.binding.id);
    expect(firstRecord.revision.sourceSnapshot).toEqual(first.snapshot); expect(secondRecord.revision.sourceSnapshot).toEqual(second.snapshot);
  });

  it('keeps revoked files blocked across disconnect and restores only explicitly reselected items', async () => {
    const selected = selection(); selected.files.push(file()); const ids = await importSourceFiles(selected, assignment());
    await invalidateSourceAccess({connectionId: selected.connection.id, itemId: selected.files[0].id});
    await disconnectSource(selected.connection.id); expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({id: selected.connection.id}));
    select.mockResolvedValue({...selected, files: []}); await reconnectSource(selected.connection.id);
    expect((await record(ids[0])).binding.status).toBe('revoked'); expect((await record(ids[1])).binding.status).toBe('active');
    select.mockResolvedValue({...selected, files: [selected.files[0]]}); await reconnectSource(selected.connection.id);
    expect((await record(ids[0])).binding.status).toBe('active');
    select.mockResolvedValue({...selected, connection: {...selected.connection, id: 'different-connection'}});
    await expect(reconnectSource(selected.connection.id)).rejects.toThrow('原连接');
  });

  it.each(['disconnected', 'revoked'] as const)('restores a %s file when it is explicitly selected for import again', async state => {
    const selected = selection(); selected.files.push(file(), file());
    const ids = await importSourceFiles(selected, assignment()), oldToken = await sourcePageCache.token(ids[0]);
    await invalidateSourceAccess({connectionId: selected.connection.id, itemId: selected.files[1].id});
    if (state === 'disconnected') await disconnectSource(selected.connection.id);
    else await invalidateSourceAccess({connectionId: selected.connection.id, itemId: selected.files[0].id});
    open.mockClear(); await expect(reindexDocument(ids[0])).rejects.toThrow('已断开'); expect(open).not.toHaveBeenCalled();
    expect(await importSourceFiles({...selected, files: [selected.files[0]]}, assignment())).toEqual([ids[0]]);
    const restored = await record(ids[0]);
    expect(restored.connection.status).toBe('connected'); expect(restored.binding.status).toBe('active'); expect(restored.document.indexState).toBe('ready');
    const source = await openFileSource({...restored, documentId: ids[0], format: 'cbz'});
    expect(await source.readAt(0, 4)).toEqual(new Uint8Array(4)); await source.close();
    expect((await record(ids[1])).binding.status).toBe('revoked');
    await expect(reindexDocument(ids[1])).rejects.toThrow('已断开');
    if (state === 'disconnected') expect((await record(ids[2])).binding.status).toBe('active');
    expect(await sourcePageCache.put('late:' + ids[0], new Blob(['late']), {owner: ids[0], token: oldToken})).toBe(false);
    expect(await sourcePageCache.put('restored:' + ids[0], new Blob(['current']), {owner: ids[0], token: await sourcePageCache.token(ids[0])})).toBe(true);
    expect(await sourcePageCache.put('revoked:' + ids[1], new Blob(['blocked']), {owner: ids[1], token: await sourcePageCache.token(ids[1])})).toBe(false);
  });

  it('restores the shared item binding before indexing a newly selected document version', async () => {
    const selected = selection(), [id] = await importSourceFiles(selected, assignment()), original = await record(id);
    await invalidateSourceAccess({connectionId: selected.connection.id, itemId: selected.files[0].id});
    const next = file(selected.files[0].id, 'two');
    const [nextId] = await importSourceFiles({...selected, files: [next]}, assignment()), current = await record(nextId);
    expect(current.binding.id).toBe(original.binding.id); expect(current.binding.status).toBe('active');
    expect(current.document.indexState).toBe('ready'); expect(current.revision.sourceSnapshot).toEqual(next.snapshot);
  });

  it('applies provider events to catalog and cache leases and closes the matching active source', async () => {
    const selected = selection(), [id] = await importSourceFiles(selected, assignment()), saved = await record(id);
    await initializeSources();
    const source = await openFileSource({...saved, documentId: id, format: 'cbz'});
    const token = await sourcePageCache.token(id), key = 'source-event:' + id;
    await sourcePageCache.put(key, new Blob(['cached']), {owner: id, connectionId: saved.connection.id, token});
    await changed!({connectionId: saved.connection.id, itemId: saved.binding.providerItemId});
    expect((await record(id)).binding.status).toBe('revoked'); expect(await sourcePageCache.get(key)).toBeUndefined();
    expect(await sourcePageCache.put(key, new Blob(['late']), {owner: id, token})).toBe(false);
    await expect(source.readAt(0, 1)).rejects.toThrow('来源已关闭'); await source.close();
    const before = (await record(id)).document.generation;
    await changed!({connectionId: saved.connection.id, itemId: saved.binding.providerItemId});
    expect((await record(id)).document.generation).toBe(before);
  });

  it('reports connection capabilities from registration without assuming a provider name', async () => {
    const selected = selection(); await importSourceFiles(selected, assignment());
    const summary = (await storageOverview()).connections.find(value => value.id === selected.connection.id)!;
    expect(summary).toMatchObject({providerLabel: 'Fixture cloud', canReconnect: true, canDisconnect: true});
    const passive: SourceConnection = {...selected.connection, id: crypto.randomUUID(), provider: 'uninstalled-source', status: 'connected', generation: 1, createdAt: 1, updatedAt: 1};
    await catalog.put('connections', passive);
    expect((await storageOverview()).connections.find(value => value.id === passive.id)).toMatchObject({providerLabel: 'uninstalled-source', canReconnect: false, canDisconnect: false});
  });

  it('rejects indexing an unregistered provider instead of guessing a remote implementation', async () => {
    const sourceKey = crypto.randomUUID();
    const saved = await registerDocument({title: 'Unknown source', format: 'cbz', sourceKey, providerItemId: sourceKey,
      connectionId: sourceKey, provider: 'unregistered-source', displayName: 'Unknown', locator: {opaque: true}, sourceSnapshot: {version: 'one'}}, assignment());
    await expect(reindexDocument(saved.document.id)).rejects.toThrow('来源未启用');
    expect(open).not.toHaveBeenCalled(); expect((await catalog.get('documents', saved.document.id))?.indexState).toBe('failed');
  });
});
