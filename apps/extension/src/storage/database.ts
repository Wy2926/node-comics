/** Final source-storage baseline. Earlier development databases are left untouched. */
export const SOURCE_DATABASE_PREFIX = 'node-comics-reading-v2';
export const sourceDatabaseName = (name: string) => `${SOURCE_DATABASE_PREFIX}-${name}`;
export interface StoreSchema {
  keyPath: string | string[] | null;
  indexes?: readonly { name: string; keyPath: string | string[]; unique?: boolean }[];
}
export type DatabaseSchema = Record<string, StoreSchema>;
export interface DatabaseEvolution {
  version: number;
  /** Schedule explicit changes in this versionchange transaction; throwing or aborting rolls them back. */
  upgrade: (transaction: IDBTransaction, oldVersion: number) => void;
}
export class SourceDatabaseSchemaError extends Error {
  constructor(database: string, detail: string) {
    super(`本机资料库结构与当前扩展不一致（${database}：${detail}）。请关闭漫画页面并重新加载最新扩展；已有资料未被清除。`);
    this.name = 'SourceDatabaseSchemaError';
  }
}
const sameKey = (actual: string | string[] | null, expected: string | string[] | null) => JSON.stringify(actual) === JSON.stringify(expected);
function validate(database: IDBDatabase, schema: DatabaseSchema, transaction?: IDBTransaction) {
  const names = Object.keys(schema);
  for (const name of names) if (!database.objectStoreNames.contains(name)) throw new SourceDatabaseSchemaError(database.name, `缺少 ${name}`);
  const tx = transaction ?? database.transaction(names);
  for (const [name, definition] of Object.entries(schema)) {
    const store = tx.objectStore(name);
    if (!sameKey(store.keyPath, definition.keyPath) || store.autoIncrement) throw new SourceDatabaseSchemaError(database.name, `${name} 主键不匹配`);
    for (const expected of definition.indexes ?? []) {
      if (!store.indexNames.contains(expected.name)) throw new SourceDatabaseSchemaError(database.name, `缺少 ${name}.${expected.name}`);
      const index = store.index(expected.name);
      if (!sameKey(index.keyPath, expected.keyPath) || index.unique !== !!expected.unique || index.multiEntry) throw new SourceDatabaseSchemaError(database.name, `${name}.${expected.name} 索引不匹配`);
    }
  }
}
/** Existing callers stay on version 1. Only the owning store can opt into an explicit upgrade. */
export function openSourceDatabase(name: string, schema: DatabaseSchema, closed: () => void, initialize?: (tx: IDBTransaction) => void, verify?: (database: IDBDatabase) => Promise<void>, evolution?: DatabaseEvolution): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(sourceDatabaseName(name), evolution?.version ?? 1);
    let abandoned = false, upgradeError: unknown;
    request.onblocked = () => { abandoned = true; reject(new SourceDatabaseSchemaError(sourceDatabaseName(name), '升级被其他页面阻塞，请关闭漫画页面后重试')); };
    request.onupgradeneeded = event => {
      const tx = request.transaction!;
      if (abandoned) { tx.abort(); return; }
      try {
        if (event.oldVersion === 0) {
          for (const [table, definition] of Object.entries(schema)) {
            const store = request.result.createObjectStore(table, definition.keyPath === null ? undefined : { keyPath: definition.keyPath });
            for (const index of definition.indexes ?? []) store.createIndex(index.name, index.keyPath, { unique: !!index.unique });
          }
          initialize?.(tx);
        } else {
          if (!evolution) throw new SourceDatabaseSchemaError(request.result.name, '缺少明确的升级步骤');
          evolution.upgrade(tx, event.oldVersion);
        }
        validate(request.result, schema, tx);
      } catch (error) { upgradeError = error; try { tx.abort(); } catch { /* The owner may already have aborted. */ } }
    };
    request.onerror = () => reject(upgradeError ?? request.error);
    request.onsuccess = async () => {
      const database = request.result;
      if (abandoned) { database.close(); return; }
      database.onversionchange = () => { database.close(); closed(); };
      database.onclose = closed;
      try { validate(database, schema); await verify?.(database); }
      catch (error) { database.close(); reject(error); return; }
      resolve(database);
    };
  });
}
