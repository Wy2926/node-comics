import type {RandomAccessSource} from '../formats/contracts';
import {checkRange} from '../formats/contracts';
import type {OpenFileSourceContext, SourceAccessChange} from './contracts';
import {requireSourceDriver} from './registry';
import {sourceRangeCache, sourceRangeKey} from '../../storage/source-ranges';
import {SourceDatabaseSchemaError} from '../../storage/database';

interface ActiveSource { itemId: string; close(): Promise<void>; }
const active = new Map<string, Set<ActiveSource>>();
const invalidations = new Map<string, {connection: number; items: Map<string, number>}>();
const accessVersion = (connectionId: string, itemId: string) => {
  const state = invalidations.get(connectionId);
  return `${state?.connection ?? 0}:${state?.items.get(itemId) ?? 0}`;
};
function cacheFailure(error: unknown): undefined {
  if (error instanceof SourceDatabaseSchemaError) throw error;
  return undefined;
}
export async function closeSourceAccess(change: SourceAccessChange) {
  let state = invalidations.get(change.connectionId);
  if (!state) { state = {connection: 0, items: new Map()}; invalidations.set(change.connectionId, state); }
  if (change.itemId === undefined) state.connection++;
  else state.items.set(change.itemId, (state.items.get(change.itemId) ?? 0) + 1);
  const sources = active.get(change.connectionId);
  if (sources) await Promise.all([...sources].filter(source => change.itemId === undefined || source.itemId === change.itemId).map(source => source.close()));
}

/** Generic source selection and optional range caching. Providers own only acquisition. */
export async function openFileSource(context: OpenFileSourceContext): Promise<RandomAccessSource> {
  context.signal?.throwIfAborted();
  if (context.source.connectionId !== context.connection.id) throw Error('来源绑定与连接不匹配。');
  if (['disconnected', 'revoked'].includes(context.connection.status) || ['disconnected', 'revoked'].includes(context.source.status ?? ''))
    throw Error('来源连接或文件访问已断开，请重新连接。');
  const driver = requireSourceDriver(context.connection.provider);
  const version = accessVersion(context.connection.id, context.source.providerItemId);
  const source = await driver.open(context);
  if (context.signal?.aborted) { await source.close(); context.signal.throwIfAborted(); }
  if (accessVersion(context.connection.id, context.source.providerItemId) !== version) {
    await source.close(); throw new DOMException('来源访问已变化。', 'AbortError');
  }
  const cachedRanges = driver.cacheRanges && !source.snapshot.local;
  const {connection, source: binding, entryId} = context;
  let closed = false;
  const assertOpen = (signal?: AbortSignal) => {
    if (closed) throw new DOMException('来源已关闭。', 'AbortError');
    signal?.throwIfAborted();
  };
  let sources = active.get(connection.id);
  if (!sources) { sources = new Set(); active.set(connection.id, sources); }
  const entry: ActiveSource = {itemId: binding.providerItemId, close: async () => {
    if (closed) return;
    closed = true; sources.delete(entry);
    if (!sources.size) active.delete(connection.id);
    await source.close();
  }};
  sources.add(entry);
  return {
    snapshot: source.snapshot,
    async readAt(offset, length, signal) {
      assertOpen(signal);
      checkRange(source, offset, length);
      if (!cachedRanges) { const bytes = await source.readAt(offset, length, signal); assertOpen(signal); return bytes; }
      const key = sourceRangeKey(connection.id, binding.providerItemId, source.snapshot.version, offset, length);
      const cached = await sourceRangeCache.get(key).catch(cacheFailure);
      assertOpen(signal);
      if (cached && cached.size === length) {
        const bytes = new Uint8Array(await cached.arrayBuffer());
        assertOpen(signal); return bytes;
      }
      const token = await sourceRangeCache.token(entryId).catch(cacheFailure);
      assertOpen(signal);
      const bytes = await source.readAt(offset, length, signal);
      assertOpen(signal);
      if (token) await sourceRangeCache.put(key, new Blob([bytes as Uint8Array<ArrayBuffer>]), {
        owner: entryId, connectionId: connection.id, contentId: context.contentId, token,
      }).catch(cacheFailure);
      assertOpen(signal); return bytes;
    },
    async validate(signal) { assertOpen(signal); const state = await source.validate(signal); assertOpen(signal); return state; },
    close: entry.close,
  };
}
