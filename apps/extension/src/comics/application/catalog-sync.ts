import {catalog} from '../repositories';
import {applyCatalogRefresh, catalogSyncPolicy} from './catalog-service';
import type {SourceCatalogSnapshot} from '../../sources';
import {readWebsiteCatalog} from './website-catalog';

type CatalogCheckResult = {status:'checked'; hasUpdates:boolean} | {status:'skipped'|'busy'|'unavailable'};
const running = new Set<string>();

/** Check exactly one requested book; never enumerate the shelf or prepare chapter images. */
export async function checkCatalogUpdates(comicId:string, options:{manual?:boolean; signal?:AbortSignal} = {},
  read:(url:string,signal?:AbortSignal)=>Promise<SourceCatalogSnapshot> = readWebsiteCatalog):Promise<CatalogCheckResult> {
  if (running.has(comicId)) return {status:'busy'};
  running.add(comicId);
  const run = async ():Promise<CatalogCheckResult> => {
    options.signal?.throwIfAborted();
    const now = Date.now(), lease = crypto.randomUUID();
    const claim = await catalog.mutate(['comics','connections'], async tx => {
      const current = await tx.get('comics', comicId), policy = current && catalogSyncPolicy(current);
      if (!current || !policy) return 'unavailable' as const;
      if (!options.manual && (current.catalogSync?.nextCheckAt ?? 0) > now) return 'skipped' as const;
      const connection = await tx.get('connections', current.source.connectionId);
      if (!connection || connection.status !== 'connected') return 'unavailable' as const;
      options.signal?.throwIfAborted();
      const next = {...current, catalogSync:{...current.catalogSync, lease, lastAttemptAt:now,
        nextCheckAt:now + policy.intervalMinutes * 60_000}};
      await tx.put('comics', next);
      return next;
    });
    if (typeof claim === 'string') return {status:claim};
    try {
      options.signal?.throwIfAborted();
      const snapshot = await read(claim.sourceUrl!, options.signal);
      options.signal?.throwIfAborted();
      const refreshed = await applyCatalogRefresh(comicId, claim.source.generation, snapshot, lease);
      return refreshed ? {status:'checked',hasUpdates:(refreshed.catalogUpdates?.revision ?? 0) > (claim.catalogUpdates?.revision ?? 0)} : {status:'unavailable'};
    } finally {
      // Failures/cancellation retain the interval. A released Web Lock lets a manual retry recover immediately.
      await catalog.mutate(['comics'], async tx => {
        const current = await tx.get('comics', comicId);
        if (current?.catalogSync?.lease === lease)
          await tx.put('comics', {...current, catalogSync:{...current.catalogSync, lease:undefined}});
      });
    }
  };
  try {
    // Released automatically on tab closure; no persistent lease can strand a manual retry.
    return globalThis.navigator?.locks
      ? await navigator.locks.request('nc-catalog-check:'+comicId, {ifAvailable:true}, lock => lock ? run() : {status:'busy'} as CatalogCheckResult)
      : await run();
  } finally {running.delete(comicId);}
}
