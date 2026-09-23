/** Final source-storage baseline. Earlier development databases are left untouched. */
export const SOURCE_DATABASE_PREFIX = 'node-comics-sources-v1';
export const sourceDatabaseName = (name: string) => `${SOURCE_DATABASE_PREFIX}-${name}`;
export interface StoreSchema {
  keyPath: string | string[] | null;
  indexes?: readonly { name: string; keyPath: string | string[]; unique?: boolean }[];
}
export type DatabaseSchema = Record<string, StoreSchema>;
export class SourceDatabaseSchemaError extends Error {
  constructor(database: string, detail: string) {
    super(`本机资料库结构与当前扩展不一致（${database}：${detail}）。请关闭漫画页面并重新加载最新扩展；已有资料未被清除。`);
    this.name = 'SourceDatabaseSchemaError';
  }
}
const sameKey = (actual: string | string[] | null, expected: string | string[] | null) => JSON.stringify(actual) === JSON.stringify(expected);
function validate(database: IDBDatabase, schema: DatabaseSchema) {
  const names = Object.keys(schema);
  for (const name of names) if (!database.objectStoreNames.contains(name)) throw new SourceDatabaseSchemaError(database.name, `缺少 ${name}`);
  const tx = database.transaction(names);
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
/** No migration, destructive reset, or fallback to a database with a different schema. */
export function openSourceDatabase(name: string, schema: DatabaseSchema, closed: () => void, initialize?: (tx: IDBTransaction) => void, verify?: (database: IDBDatabase) => Promise<void>): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(sourceDatabaseName(name), 1);
    request.onupgradeneeded = () => {
      for (const [table, definition] of Object.entries(schema)) {
        const store = request.result.createObjectStore(table, definition.keyPath === null ? undefined : { keyPath: definition.keyPath });
        for (const index of definition.indexes ?? []) store.createIndex(index.name, index.keyPath, { unique: !!index.unique });
      }
      initialize?.(request.transaction!);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = async () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); closed(); };
      database.onclose = closed;
      try { validate(database, schema); await verify?.(database); }
      catch (error) { database.close(); reject(error); return; }
      resolve(database);
    };
  });
}
