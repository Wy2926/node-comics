import type { CatalogTable, CatalogTables, PageDescriptor } from '../domain';
import { openSourceDatabase, sourceDatabaseName, type DatabaseSchema } from '../../storage/database';

export const CATALOG_DATABASE = sourceDatabaseName('catalog');
export interface CatalogChange { table: CatalogTable; ids: IDBValidKey[] }
export type CatalogWrite = { [T in CatalogTable]: { table: T; value: CatalogTables[T] } }[CatalogTable];
export interface ListOptions {
  index?: string; range?: IDBValidKey | IDBKeyRange; offset?: number; limit?: number;
  direction?: IDBCursorDirection;
}
export interface CatalogMutation {
  get<T extends CatalogTable>(table: T, id: IDBValidKey): Promise<CatalogTables[T] | undefined>;
  list<T extends CatalogTable>(table: T, options?: ListOptions): Promise<CatalogTables[T][]>;
  put<T extends CatalogTable>(table: T, record: CatalogTables[T]): Promise<void>;
  remove(table: CatalogTable, id: IDBValidKey): Promise<void>;
}
const schema: Record<CatalogTable, [string, string | string[], boolean?][]> = {
  comics: [['sourceKey', 'sourceKey', true], ['connectionId', 'source.connectionId'], ['updatedAt', 'updatedAt'], ['lastReadAt', 'lastReadAt']],
  entries: [['comicId', 'comicId'], ['comicOrder', ['comicId', 'order']], ['sourceEntry', ['comicId', 'sourceEntryId'], true], ['contentId', 'contentId', true]],
  connections: [['provider', 'provider']],
  pageDescriptors: [['contentId', 'contentId'], ['contentOrdinal', ['contentId', 'ordinal']], ['contentLocator', ['contentId', 'formatLocator'], true]],
  materializations: [['contentId', 'contentId'], ['pageId', 'pageId'], ['imageSha256', 'imageSha256']],
  positions: [['entryId', 'entryId', true], ['comicId', 'comicId'], ['updatedAt', 'updatedAt']],
  translationBindings: [['imageSha256', 'imageSha256'], ['account', ['apiOrigin', 'userId']]],
  catalogs: [['comicId', 'comicId']],
  tasks: [['entryId', 'entryId'], ['status', 'status'], ['statusNextRun', ['status', 'nextRunAt']]],
  metadata: [], tombstones: [],
};
export const idbRequest = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
export const idbCompleted = (tx: IDBTransaction): Promise<void> => {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? Error('Catalog transaction aborted'));
    tx.onerror = () => reject(tx.error ?? Error('Catalog transaction failed'));
  });
  void done.catch(() => {}); return done;
};
let opening: Promise<IDBDatabase> | undefined;
const databaseSchema: DatabaseSchema = Object.fromEntries(Object.entries(schema).map(([name, indices]) => [name, {
  keyPath: name === 'pageDescriptors' ? ['contentId', 'pageId'] : 'id',
  indexes: indices.map(([name, keyPath, unique]) => ({ name, keyPath, unique })),
}]));
export function openCatalog(): Promise<IDBDatabase> {
  if (!opening) opening = openSourceDatabase('catalog', databaseSchema, () => { opening = undefined; }).catch(error => { opening = undefined; throw error; });
  return opening;
}
const listeners = new Set<(change: CatalogChange) => void>();
let channel: BroadcastChannel | undefined;
function broadcast(): BroadcastChannel | undefined {
  // A service worker has no window; it still sends invalidations to reader tabs.
  if (!channel && typeof BroadcastChannel !== 'undefined' && typeof navigator !== 'undefined' && typeof indexedDB !== 'undefined') {
    channel = new BroadcastChannel(sourceDatabaseName('catalog-changes'));
    channel.onmessage = event => { const change = event.data as CatalogChange; if (change?.table in schema && Array.isArray(change.ids)) for (const listener of listeners) listener(change); };
  }
  return channel;
}
function changed(table: CatalogTable, ids: IDBValidKey[]) {
  const change = { table, ids }; for (const listener of listeners) listener(change); broadcast()?.postMessage(change);
}
async function cursorValues<T>(source: IDBObjectStore | IDBIndex, options: ListOptions, matches?: (value: T) => boolean): Promise<T[]> {
  const offset = Math.max(0, options.offset ?? 0), limit = Math.max(0, options.limit ?? 100);
  if (!limit) return [];
  return new Promise((resolve, reject) => {
    const values: T[] = []; let skipped = false, matched = 0;
    const request = source.openCursor(options.range, options.direction ?? 'next');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || values.length >= limit) { resolve(values); return; }
      if (matches) {
        if (!matches(cursor.value) || matched++ < offset) { cursor.continue(); return; }
      } else if (!skipped && offset) { skipped = true; cursor.advance(offset); return; }
      values.push(cursor.value as T);
      if (values.length >= limit) resolve(values); else cursor.continue();
    };
  });
}
export class StaleCatalogWriteError extends Error { constructor() { super('漫画已移除或来源内容已变化，请重新打开。'); this.name = 'StaleCatalogWriteError'; } }

export const catalog = {
  /** Keep all reads and writes for an association change in one IDB transaction. */
  async mutate<T>(tables: CatalogTable[], edit: (records: CatalogMutation) => Promise<T>): Promise<T> {
    const db = await openCatalog(), tx = db.transaction([...new Set([...tables, 'tombstones'])], 'readwrite'), done = idbCompleted(tx);
    const writes = new Map<CatalogTable, IDBValidKey[]>();
    const records: CatalogMutation = {
      get: (table, id) => idbRequest(tx.objectStore(table).get(id)),
      list: (table, options = {}) => {
        const store = tx.objectStore(table); return cursorValues(options.index ? store.index(options.index) : store, options);
      },
      async put(table, record) {
        const key = table === 'pageDescriptors' ? [(record as PageDescriptor).contentId, (record as PageDescriptor).pageId] : (record as {id: string}).id;
        if (await idbRequest(tx.objectStore('tombstones').get([table, key].join(':')))) throw new StaleCatalogWriteError();
        tx.objectStore(table).put(record); writes.set(table, [...writes.get(table) ?? [], key]);
      },
      async remove(table, id) {
        tx.objectStore(table).delete(id); if(table!=='catalogs')tx.objectStore('tombstones').put({id: [table, id].join(':'), deletedAt: Date.now()});
        writes.set(table, [...writes.get(table) ?? [], id]);
      },
    };
    try {
      const result = await edit(records); await done;
      for (const [table, ids] of writes) changed(table, ids);
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* A failed request may already have aborted the transaction. */ }
      await done.catch(() => {}); throw error;
    }
  },
  async finishIndex(entryId: string, contentId: string, generation: number, summary: Pick<CatalogTables['entries'], 'pageCount' | 'knownTotal' | 'discoveryComplete' | 'coverPageId'>): Promise<boolean> {
    return catalog.mutate(['entries', 'comics'], async tx => {
      const entry = await tx.get('entries', entryId);
      if (!entry || entry.generation !== generation || entry.contentId !== contentId) return false;
      await tx.put('entries', {...entry, ...summary, indexState: 'ready', error: undefined});
      const comic = await tx.get('comics', entry.comicId);
      if (comic && summary.coverPageId && (!comic.cover || comic.cover.entryId === entryId)) await tx.put('comics', {...comic, cover: {entryId, contentId, pageId: summary.coverPageId}});
      return true;
    });
  },
  async editTranslationBinding(id: string, edit: (previous: CatalogTables['translationBindings'] | undefined) => CatalogTables['translationBindings'] | undefined): Promise<CatalogTables['translationBindings'] | undefined> {
    const db = await openCatalog(), tx = db.transaction('translationBindings', 'readwrite'), done = idbCompleted(tx);
    const store = tx.objectStore('translationBindings'), previous = await idbRequest(store.get(id)) as CatalogTables['translationBindings'] | undefined;
    const next = edit(previous); if (next) store.put(next); await done;
    if (next) changed('translationBindings', [id]); return next ?? previous;
  },
  async commit(records: CatalogWrite[], options: {require?: {table: CatalogTable; id: IDBValidKey}[]} = {}): Promise<void> {
    if (!records.length) return;
    await catalog.mutate([...records.map(r => r.table), ...(options.require ?? []).map(r => r.table)], async tx => {
      for (const {table, value} of records) await tx.put(table, value);
      for (const ref of options.require ?? []) if (!await tx.get(ref.table, ref.id)) throw new StaleCatalogWriteError();
    });
  },
  async get<T extends CatalogTable>(table: T, id: IDBValidKey): Promise<CatalogTables[T] | undefined> {
    const db = await openCatalog(); return idbRequest(db.transaction(table).objectStore(table).get(id));
  },
  async put<T extends CatalogTable>(table: T, record: CatalogTables[T]): Promise<void> {
    const db = await openCatalog(), tx = db.transaction([table, 'tombstones'], 'readwrite'), done = idbCompleted(tx);
    const key = table === 'pageDescriptors' ? [(record as PageDescriptor).contentId, (record as PageDescriptor).pageId] : (record as { id: string }).id;
    if (table !== 'tombstones' && await idbRequest(tx.objectStore('tombstones').get([table, key].join(':')))) { tx.abort(); await done.catch(() => {}); throw new StaleCatalogWriteError(); }
    tx.objectStore(table).put(record); await done; changed(table, [key]);
  },
  async patch<T extends CatalogTable>(table: T, id: IDBValidKey, patch: Partial<CatalogTables[T]>, options: { expectedGeneration?: number } = {}): Promise<CatalogTables[T] | undefined> {
    const db = await openCatalog(), tx = db.transaction(table, 'readwrite'), done = idbCompleted(tx), store = tx.objectStore(table);
    const value = await idbRequest(store.get(id)) as CatalogTables[T] | undefined;
    if (!value) { await done; return undefined; }
    if (options.expectedGeneration !== undefined && (value as unknown as { generation: number }).generation !== options.expectedGeneration) { tx.abort(); await done.catch(() => {}); throw new StaleCatalogWriteError(); }
    const next = { ...value, ...patch }; store.put(next); await done; changed(table, [id]); return next;
  },
  async remove(table: CatalogTable, id: IDBValidKey): Promise<void> {
    const db = await openCatalog(), tx = db.transaction([table, 'tombstones'], 'readwrite'), done = idbCompleted(tx);
    tx.objectStore(table).delete(id);
    if (table !== 'tombstones') tx.objectStore('tombstones').put({ id: [table, id].join(':'), deletedAt: Date.now() });
    await done; changed(table, [id]);
  },
  async list<T extends CatalogTable>(table: T, options: ListOptions = {}): Promise<CatalogTables[T][]> {
    const db = await openCatalog(), store = db.transaction(table).objectStore(table);
    return cursorValues(options.index ? store.index(options.index) : store, options);
  },
  async search<T extends CatalogTable>(table: T, matches: (value: CatalogTables[T]) => boolean, options: ListOptions = {}): Promise<CatalogTables[T][]> {
    const db = await openCatalog(), store = db.transaction(table).objectStore(table);
    return cursorValues(options.index ? store.index(options.index) : store, options, matches);
  },
  async count(table: CatalogTable, options: Pick<ListOptions, 'index' | 'range'> = {}): Promise<number> {
    const db = await openCatalog(), store = db.transaction(table).objectStore(table);
    return idbRequest((options.index ? store.index(options.index) : store).count(options.range));
  },
  listEntries(comicId: string, options: {offset?: number; limit?: number} = {}) {
    return catalog.list('entries', {limit: 10000, ...options, index: 'comicOrder', range: IDBKeyRange.bound([comicId, -Infinity], [comicId, Infinity])});
  },
  listPages(contentId: string, options: { offset?: number; limit?: number } = {}) {
    return catalog.list('pageDescriptors', { ...options, index: 'contentOrdinal', range: IDBKeyRange.bound([contentId, -Infinity], [contentId, Infinity]) });
  },
  async putPages(entryId: string, contentId: string, pages: PageDescriptor[], generation: number): Promise<void> {
    await catalog.mutate(['entries', 'pageDescriptors'], async tx => {
      const entry = await tx.get('entries', entryId);
      if (!entry || entry.generation !== generation || entry.contentId !== contentId) throw new StaleCatalogWriteError();
      for (const page of pages) {
        if (page.contentId !== contentId) throw new StaleCatalogWriteError();
        const [previous] = await tx.list('pageDescriptors', {index: 'contentLocator', range: [contentId, page.formatLocator], limit: 1});
        await tx.put('pageDescriptors', {...page, pageId: previous?.pageId ?? page.pageId});
      }
    });
  },
  /** Atomically replace the current index after preparing it; no history is retained. */
  async replaceContent(entryId: string, generation: number, content: Pick<CatalogTables['entries'], 'contentId' | 'containerId' | 'sourceSnapshot' | 'format'>, pages: PageDescriptor[], complete: boolean, total?: number): Promise<void> {
    await catalog.mutate(['entries', 'comics', 'connections', 'pageDescriptors', 'materializations', 'positions'], async tx => {
      const entry = await tx.get('entries', entryId);
      if (!entry || entry.generation !== generation) throw new StaleCatalogWriteError();
      const comic = await tx.get('comics', entry.comicId), connection = comic && await tx.get('connections', comic.source.connectionId);
      if (!comic || comic.source.status !== 'active' || !connection || connection.status !== 'connected') throw new StaleCatalogWriteError();
      for (const page of await tx.list('pageDescriptors', {index: 'contentId', range: entry.contentId, limit: 1500})) await tx.remove('pageDescriptors', [page.contentId, page.pageId]);
      for (const value of await tx.list('materializations', {index: 'contentId', range: entry.contentId, limit: 5000})) await tx.remove('materializations', value.id);
      for (const page of pages) {if (page.contentId !== content.contentId) throw new StaleCatalogWriteError(); await tx.put('pageDescriptors', page);}
      await tx.put('entries', {...entry, ...content, generation: entry.generation + 1, indexState: 'ready', error: undefined, readAt: undefined, pageCount: pages.length, knownTotal: total ?? (complete ? pages.length : undefined), discoveryComplete: complete, coverPageId: pages[0]?.pageId, updatedAt: Date.now()});
      const position = await tx.get('positions', entryId);
      // An old ordinal does not prove that changed source bytes identify the same page.
      if (position && pages.length) await tx.put('positions', {...position, contentId: content.contentId, pageId: pages[0].pageId, relativeOffset: 0});
      if (comic) await tx.put('comics', {...comic,
        ...(comic.lastEntryId === entryId ? {lastPage: pages.length ? 1 : undefined, lastPageCount: total ?? (complete ? pages.length : undefined)} : {}),
        ...(comic.cover?.entryId === entryId ? {cover: pages.length ? {entryId, contentId: content.contentId, pageId: pages[0].pageId} : undefined} : {}),
      });
    });
  },
  async savePosition(position: CatalogTables['positions']): Promise<void> {
    await catalog.mutate(['entries', 'positions', 'comics', 'pageDescriptors'], async tx => {
      const entry = await tx.get('entries', position.entryId), previous = await tx.get('positions', position.entryId);
      if (!entry || entry.comicId !== position.comicId || entry.contentId !== position.contentId || previous && previous.updatedAt > position.updatedAt) return;
      const page = await tx.get('pageDescriptors', [position.contentId, position.pageId]);
      if (!page) return;
      if (previous && previous.pageId === position.pageId && previous.contentId === position.contentId && previous.relativeOffset === position.relativeOffset && previous.updatedAt === position.updatedAt) return;
      await tx.put('positions', {...position, id: position.entryId});
      const comic = await tx.get('comics', position.comicId);
      if (comic && (comic.lastReadAt ?? 0) <= position.updatedAt) await tx.put('comics', {...comic, lastEntryId: entry.id, lastReadAt: position.updatedAt, lastPage: page.ordinal + 1, lastPageCount: entry.knownTotal ?? (entry.discoveryComplete ? entry.pageCount : undefined)});
    });
  },
  async markRead(entryId: string): Promise<void> {
    await catalog.mutate(['entries'], async tx => {
      const entry = await tx.get('entries', entryId);
      if (entry && !entry.readAt && entry.discoveryComplete && entry.pageCount && !entry.error) await tx.put('entries', {...entry, readAt: Date.now()});
    });
  },
  async putMaterialization(value: CatalogTables['materializations'], expectedGeneration?: number): Promise<boolean> {
    return catalog.mutate(['entries', 'comics', 'connections', 'pageDescriptors', 'materializations'], async tx => {
      const [entry] = await tx.list('entries', {index: 'contentId', range: value.contentId, limit: 1});
      if (!entry || expectedGeneration !== undefined && entry.generation !== expectedGeneration || !await tx.get('pageDescriptors', [value.contentId, value.pageId])) return false;
      const comic = await tx.get('comics', entry.comicId), connection = comic && await tx.get('connections', comic.source.connectionId);
      if (!comic || !connection || comic.source.status !== 'active' || ['disconnected', 'revoked'].includes(connection.status)) return false;
      await tx.put('materializations', value); return true;
    });
  },
  async editTask(id: string, entryId: string, edit: (task: CatalogTables['tasks'] | undefined, document: CatalogTables['entries']) => CatalogTables['tasks'] | undefined): Promise<CatalogTables['tasks'] | undefined> {
    const db = await openCatalog(), tx = db.transaction(['tasks', 'entries'], 'readwrite'), done = idbCompleted(tx);
    const document = await idbRequest(tx.objectStore('entries').get(entryId)) as CatalogTables['entries'] | undefined;
    if (!document) { await done; return undefined; }
    const previous = await idbRequest(tx.objectStore('tasks').get(id)) as CatalogTables['tasks'] | undefined;
    const next = edit(previous, document);
    if (next) tx.objectStore('tasks').put({ ...next, id, entryId }); await done;
    if (next) changed('tasks', [id]); return next;
  },
  async deleteComic(comicId: string): Promise<CatalogTables['entries'][]> {
    return catalog.mutate(Object.keys(schema) as CatalogTable[], async tx => {
      const entries = await tx.list('entries', {index: 'comicId', range: comicId, limit: 10000});
      for (const entry of entries) {
        for (const page of await tx.list('pageDescriptors', {index: 'contentId', range: entry.contentId, limit: 1500})) await tx.remove('pageDescriptors', [page.contentId, page.pageId]);
        for (const value of await tx.list('materializations', {index: 'contentId', range: entry.contentId, limit: 5000})) await tx.remove('materializations', value.id);
        for (const table of ['positions', 'tasks'] as const) for (const value of await tx.list(table, {index: 'entryId', range: entry.id, limit: 10000})) await tx.remove(table, value.id);
        await tx.remove('entries', entry.id);
      }
      for (const value of await tx.list('catalogs', {index: 'comicId', range: comicId, limit: 1})) await tx.remove('catalogs', value.id);
      await tx.remove('comics', comicId); return entries;
    });
  },
  subscribe(listener: (change: CatalogChange) => void) { listeners.add(listener); broadcast(); return () => { listeners.delete(listener); }; },
};
