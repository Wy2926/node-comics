/** Independent IndexedDB byte stores: metadata and Blob publish in one atomic transaction.
 * Blob reads return immutable snapshots, so an eviction cannot invalidate an in-memory reader.
 * No budget operation loads a Blob. All contexts share transactional usage and reservations.
 */
import { openSourceDatabase, SourceDatabaseSchemaError, type DatabaseSchema } from './database';
const schema: DatabaseSchema = {
  metadata: { keyPath: 'key', indexes: ['usedAt', 'owner', 'connectionId', 'contentId'].map(name => ({name,keyPath:name})) },
  objects: { keyPath: null }, state: { keyPath: 'id' },
  reservations: { keyPath: 'id', indexes: [{name:'expiresAt',keyPath:'expiresAt'},{name:'key',keyPath:'key'}] },
};
export interface CacheUsage { bytes: number; reservedBytes: number; count: number; budgetBytes: number }
export interface CacheScope { owner?: string; connectionId?: string; contentId?: string }
export interface CacheToken { epoch: number; ownerGeneration: number; owner?: string }
export interface CacheWriteOptions extends CacheScope { token?: CacheToken }
interface CacheMeta extends CacheScope { key: string; size: number; usedAt: number }
interface UsageRecord { id: 'usage'; bytes: number; reservedBytes: number; count: number; epoch: number }
interface ScopeRecord { id: string; generation: number; blocked: boolean }
export interface CacheReservation extends CacheWriteOptions { id: string; key: string; size: number; expiresAt: number; epoch: number; ownerGeneration: number }
interface CacheConfiguration { name: string; budgetBytes: number | (() => number); retained?: boolean }
const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const completed = (tx: IDBTransaction): Promise<void> => {
  const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? Error('Storage transaction aborted')); tx.onerror = () => reject(tx.error ?? Error('Storage transaction failed')); });
  void done.catch(() => {}); return done;
};
const emptyUsage = (): UsageRecord => ({ id: 'usage', bytes: 0, reservedBytes: 0, count: 0, epoch: 0 });
const storeNames = ['metadata', 'objects', 'state', 'reservations'];

export class ByteCache {
  private opening?: Promise<IDBDatabase>;
  private overrideBudget?: number;
  readonly name: string;
  readonly retained: boolean;
  constructor(private readonly configuration: CacheConfiguration) { this.name = configuration.name; this.retained = !!configuration.retained; }
  private budget(): number { return this.retained ? Infinity : Math.max(0, this.overrideBudget ?? (typeof this.configuration.budgetBytes === 'function' ? this.configuration.budgetBytes() : this.configuration.budgetBytes)); }
  private open(): Promise<IDBDatabase> {
    return this.opening ??= openSourceDatabase(this.name, schema, () => { this.opening = undefined; }).catch(error => { this.opening = undefined; throw error; });
  }
  async usage(): Promise<CacheUsage> {
    const db = await this.open(), value = await request(db.transaction('state').objectStore('state').get('usage')) as UsageRecord | undefined;
    return { bytes: value?.bytes ?? 0, reservedBytes: value?.reservedBytes ?? 0, count: value?.count ?? 0, budgetBytes: this.budget() };
  }
  async token(owner?: string): Promise<CacheToken> {
    const db = await this.open(), state = db.transaction('state').objectStore('state');
    const [usage, scope] = await Promise.all([request(state.get('usage')) as Promise<UsageRecord | undefined>, owner ? request(state.get('owner:' + owner)) as Promise<ScopeRecord | undefined> : undefined]);
    return { epoch: usage?.epoch ?? 0, ownerGeneration: scope?.generation ?? 0, owner };
  }
  async get(key: string): Promise<Blob | undefined> {
    try {
      const db = await this.open(), tx = db.transaction(['metadata', 'objects', 'state'], 'readwrite'), done = completed(tx);
      const metadata = tx.objectStore('metadata'), entry = await request(metadata.get(key)) as CacheMeta | undefined;
      if (!entry) { await done; return undefined; }
      const scope = entry.owner ? await request(tx.objectStore('state').get('owner:' + entry.owner)) as ScopeRecord | undefined : undefined;
      if (scope?.blocked) { await done; return undefined; }
      const blob = await request(tx.objectStore('objects').get(key)) as Blob | undefined;
      if (blob && blob.size === entry.size) metadata.put({ ...entry, usedAt: Date.now() });
      else {
        const usage = await request(tx.objectStore('state').get('usage')) as UsageRecord ?? emptyUsage();
        metadata.delete(key); tx.objectStore('objects').delete(key);
        tx.objectStore('state').put({ ...usage, bytes: Math.max(0, usage.bytes - entry.size), count: Math.max(0, usage.count - 1) });
      }
      await done; return blob?.size === entry.size ? blob : undefined;
    } catch (error) { if (this.retained || error instanceof SourceDatabaseSchemaError) throw error; return undefined; }
  }
  /** Presence checks inspect metadata only; never deserialize image bytes for a reader view model. */
  async has(key: string): Promise<boolean> {
    try {
      const db = await this.open(), tx = db.transaction(['metadata', 'state']);
      const value = await request(tx.objectStore('metadata').get(key)) as CacheMeta | undefined;
      if (!value) return false;
      const scope = value.owner ? await request(tx.objectStore('state').get('owner:' + value.owner)) as ScopeRecord | undefined : undefined;
      return !scope?.blocked;
    } catch (error) { if (this.retained || error instanceof SourceDatabaseSchemaError) throw error; return false; }
  }
  /** Capture a token before fetching bytes to fence a response arriving after clear/deleteOwner. */
  async reserve(key: string, size: number, options: CacheWriteOptions = {}): Promise<CacheReservation | undefined> {
    if (!Number.isSafeInteger(size) || size < 0) throw Error('Invalid cache byte size');
    const db = await this.open(), tx = db.transaction(storeNames, 'readwrite'), done = completed(tx);
    const state = tx.objectStore('state'), reservations = tx.objectStore('reservations');
    const usage = await request(state.get('usage')) as UsageRecord ?? emptyUsage();
    await this.expire(tx, usage);
    const owner = options.owner ?? options.token?.owner;
    const scope = owner ? await request(state.get('owner:' + owner)) as ScopeRecord | undefined : undefined;
    if (scope?.blocked || (options.token && (options.token.epoch !== usage.epoch || options.token.ownerGeneration !== (scope?.generation ?? 0) || options.token.owner !== owner))) { state.put(usage); await done; return undefined; }
    if (!this.retained && size > this.budget()) { state.put(usage); await done; return undefined; }
    // A reservation includes the old object plus replacement bytes until commit, matching actual disk needs.
    if (!this.retained) await this.evict(tx, usage, Math.max(0, usage.bytes + usage.reservedBytes + size - this.budget()), key);
    if (!this.retained && (size > this.budget() || usage.bytes + usage.reservedBytes + size > this.budget())) { state.put(usage); await done; return undefined; }
    const reservation: CacheReservation = { ...options, owner, id: crypto.randomUUID(), key, size, expiresAt: Date.now() + 60_000, epoch: usage.epoch, ownerGeneration: scope?.generation ?? 0 };
    reservations.put(reservation); usage.reservedBytes += size; state.put(usage); await done; return reservation;
  }
  async commit(reservation: CacheReservation, blob: Blob): Promise<boolean> {
    const db = await this.open(), tx = db.transaction(storeNames, 'readwrite'), done = completed(tx), state = tx.objectStore('state');
    const usage = await request(state.get('usage')) as UsageRecord ?? emptyUsage();
    const current = await request(tx.objectStore('reservations').get(reservation.id)) as CacheReservation | undefined;
    const scope = current?.owner ? await request(state.get('owner:' + current.owner)) as ScopeRecord | undefined : undefined;
    const valid = current && current.size === blob.size && current.expiresAt > Date.now() && current.epoch === usage.epoch && current.ownerGeneration === (scope?.generation ?? 0) && !scope?.blocked;
    if (current) { usage.reservedBytes = Math.max(0, usage.reservedBytes - current.size); tx.objectStore('reservations').delete(current.id); }
    if (!valid) { state.put(usage); await done; return false; }
    const previous = await request(tx.objectStore('metadata').get(current.key)) as CacheMeta | undefined;
    if (!this.retained && usage.bytes + usage.reservedBytes + blob.size - (previous?.size ?? 0) > this.budget()) { state.put(usage); await done; return false; }
    tx.objectStore('objects').put(blob, current.key);
    tx.objectStore('metadata').put({ key: current.key, size: blob.size, usedAt: Date.now(), owner: current.owner, connectionId: current.connectionId, contentId: current.contentId } satisfies CacheMeta);
    usage.bytes += blob.size - (previous?.size ?? 0); if (!previous) usage.count++;
    state.put(usage); await done; return true;
  }
  async cancel(reservation: CacheReservation): Promise<void> {
    const db = await this.open(), tx = db.transaction(['state', 'reservations'], 'readwrite'), done = completed(tx);
    const stored = await request(tx.objectStore('reservations').get(reservation.id)) as CacheReservation | undefined;
    if (stored) { const usage = await request(tx.objectStore('state').get('usage')) as UsageRecord ?? emptyUsage(); usage.reservedBytes = Math.max(0, usage.reservedBytes - stored.size); tx.objectStore('reservations').delete(stored.id); tx.objectStore('state').put(usage); }
    await done;
  }
  async put(key: string, blob: Blob, options: CacheWriteOptions = {}): Promise<boolean> {
    let reservation: CacheReservation | undefined;
    try { reservation = await this.reserve(key, blob.size, options); return reservation ? await this.commit(reservation, blob) : false; }
    catch (error) { if (reservation) await this.cancel(reservation).catch(() => {}); if (this.retained || error instanceof SourceDatabaseSchemaError) throw error; return false; }
  }
  async delete(key: string): Promise<void> { await this.removeMatching('key', key); }
  async deleteOwner(owner: string, block = false): Promise<void> { await this.removeMatching('owner', owner, block); }
  async deleteConnection(connectionId: string): Promise<void> { await this.removeMatching('connectionId', connectionId); }
  async deleteRevision(contentId: string): Promise<void> { await this.removeMatching('contentId', contentId); }
  private async removeMatching(index: 'key' | 'owner' | 'connectionId' | 'contentId', value: string, block = false): Promise<void> {
    const db = await this.open(), tx = db.transaction(storeNames, 'readwrite'), done = completed(tx), metadata = tx.objectStore('metadata'), state = tx.objectStore('state');
    const usage = await request(state.get('usage')) as UsageRecord ?? emptyUsage();
    const records = index === 'key' ? [await request(metadata.get(value))].filter(Boolean) as CacheMeta[] : await request(metadata.index(index).getAll(value)) as CacheMeta[];
    for (const entry of records) { metadata.delete(entry.key); tx.objectStore('objects').delete(entry.key); usage.bytes -= entry.size; usage.count--; }
    // A local object deletion also invalidates pending writers, without reading any Blob values.
    if (index === 'owner') {
      const scope = await request(state.get('owner:' + value)) as ScopeRecord | undefined;
      state.put({ id: 'owner:' + value, generation: (scope?.generation ?? 0) + 1, blocked: block } satisfies ScopeRecord);
    } else { usage.epoch++; }
    state.put(usage); await done;
  }
  async allowOwner(owner: string): Promise<void> {
    const db = await this.open(), tx = db.transaction('state', 'readwrite'), done = completed(tx), state = tx.objectStore('state');
    const scope = await request(state.get('owner:' + owner)) as ScopeRecord | undefined;
    state.put({ id: 'owner:' + owner, generation: (scope?.generation ?? 0) + 1, blocked: false }); await done;
  }
  /** Stop in-flight writers while retaining already committed explicit downloads. */
  async invalidateOwner(owner: string): Promise<void> {
    const db = await this.open(), tx = db.transaction('state', 'readwrite'), done = completed(tx), state = tx.objectStore('state');
    const scope = await request(state.get('owner:' + owner)) as ScopeRecord | undefined;
    state.put({ id: 'owner:' + owner, generation: (scope?.generation ?? 0) + 1, blocked: scope?.blocked ?? false }); await done;
  }
  async clear(): Promise<void> {
    const db = await this.open(), tx = db.transaction(storeNames, 'readwrite'), done = completed(tx), state = tx.objectStore('state');
    const usage = await request(state.get('usage')) as UsageRecord ?? emptyUsage();
    tx.objectStore('metadata').clear(); tx.objectStore('objects').clear(); tx.objectStore('reservations').clear();
    state.put({ ...emptyUsage(), epoch: usage.epoch + 1 }); await done;
  }
  async setBudget(bytes: number): Promise<void> {
    if (!Number.isFinite(bytes) || bytes < 0) throw Error('Invalid cache budget');
    this.overrideBudget = bytes; await this.enforceBudget();
  }
  async enforceBudget(): Promise<void> {
    const usage = await this.usage(); await this.trim(Math.max(0, usage.bytes + usage.reservedBytes - this.budget()));
  }
  async trim(bytes: number): Promise<number> {
    if (this.retained || bytes <= 0) return 0;
    const db = await this.open(), tx = db.transaction(storeNames, 'readwrite'), done = completed(tx), state = tx.objectStore('state');
    const usage = await request(state.get('usage')) as UsageRecord ?? emptyUsage(); await this.expire(tx, usage);
    const released = await this.evict(tx, usage, bytes); state.put(usage); await done; return released;
  }
  private async expire(tx: IDBTransaction, usage: UsageRecord): Promise<void> {
    const reservations = tx.objectStore('reservations');
    const expired = await request(reservations.index('expiresAt').getAll(IDBKeyRange.upperBound(Date.now()), 100));
    for (const value of expired as CacheReservation[]) { reservations.delete(value.id); usage.reservedBytes = Math.max(0, usage.reservedBytes - value.size); }
  }
  private async evict(tx: IDBTransaction, usage: UsageRecord, bytes: number, protectKey?: string): Promise<number> {
    if (bytes <= 0 || this.retained) return 0;
    return new Promise((resolve, reject) => {
      let released = 0; const cursor = tx.objectStore('metadata').index('usedAt').openCursor();
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const value = cursor.result;
        if (!value || released >= bytes) { resolve(released); return; }
        const entry = value.value as CacheMeta;
        if (entry.key !== protectKey) { value.delete(); tx.objectStore('objects').delete(entry.key); usage.bytes -= entry.size; usage.count--; released += entry.size; }
        value.continue();
      };
    });
  }
}
