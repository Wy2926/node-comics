import {catalog} from '../repositories';
import {applyCatalogRefresh, catalogSyncPolicy} from './catalog-service';
import {discoverCatalog, type SourceCatalogSnapshot} from '../../sources';

export async function nextCatalogCheckAt() {
  const connections = new Set((await catalog.list('connections', {limit:Number.MAX_SAFE_INTEGER})).filter(connection => connection.status === 'connected').map(connection => connection.id));
  const comics = await catalog.search('comics', comic => !!catalogSyncPolicy(comic) && connections.has(comic.source.connectionId), {limit:Number.MAX_SAFE_INTEGER});
  return comics.reduce((next, comic) => Math.min(next, comic.catalogSync?.nextCheckAt ?? 0), Infinity);
}
/** One bounded job per wakeup, with a persisted claim shared by all extension contexts. */
export async function syncNextCatalog(read:(url:string)=>Promise<SourceCatalogSnapshot> = discoverCatalog) {
  const now = Date.now();
  const connections = new Set((await catalog.list('connections', {limit:Number.MAX_SAFE_INTEGER})).filter(connection => connection.status === 'connected').map(connection => connection.id));
  const candidates = await catalog.search('comics', comic => !!catalogSyncPolicy(comic) &&
    connections.has(comic.source.connectionId) && (comic.catalogSync?.nextCheckAt ?? 0) <= now, {limit:10});
  for (const candidate of candidates) {
    const lease = crypto.randomUUID();
    const comic = await catalog.mutate(['comics','connections'], async tx => {
      const current = await tx.get('comics', candidate.id);
      if (!current || !catalogSyncPolicy(current) || (current.catalogSync?.nextCheckAt ?? 0) > now) return;
      const connection = await tx.get('connections', current.source.connectionId);
      if (!connection || connection.status !== 'connected') return;
      // Persist the 12-hour gate before making any request, including failures and worker interruption.
      const next = {...current, catalogSync:{...current.catalogSync, lease, lastAttemptAt:now,
        nextCheckAt:now + catalogSyncPolicy(current)!.intervalMinutes * 60_000}};
      await tx.put('comics', next); return next;
    });
    if (!comic) continue;
    try {
      const snapshot = await read(comic.sourceUrl!);
      await applyCatalogRefresh(comic.id, comic.source.generation, snapshot, lease);
    } catch {
      // Quiet retries never erase a previously usable directory or expose source contents in logs.
      await catalog.mutate(['comics'], async tx => {
        const current = await tx.get('comics', comic.id);
        if (current?.catalogSync?.lease === lease)
          await tx.put('comics', {...current, catalogSync:{...current.catalogSync, lease:undefined}});
      });
    }
    return true;
  }
  return false;
}
