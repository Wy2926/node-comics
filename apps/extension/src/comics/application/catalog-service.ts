import {catalog, type CatalogMutation} from '../repositories';
import type {Comic, Entry} from '../domain';
import {sourceFor, validateSourceCatalog, type SourceCatalogSnapshot} from '../../sources';
import type {SourceCatalog} from './types';

export function catalogSyncPolicy(comic:Comic) {
  if (!comic.sourceUrl || comic.source.status !== 'active') return;
  const {definition, location} = sourceFor(comic.sourceUrl);
  if (!definition.catalogSync || !definition.capabilities.importable || !definition.capabilities.catalog ||
      location.kind !== 'catalog' || comic.source.connectionId !== 'website:' + definition.id ||
      comic.source.providerItemId !== location.catalog?.key) return;
  return definition.catalogSync;
}

/** Metadata-only reconciliation: existing page identities, caches and positions stay intact. */
export async function reconcileCatalog(tx:CatalogMutation, current:Comic, source:SourceCatalogSnapshot, now=Date.now()) {
  if (current.source.status !== 'active' || current.source.connectionId !== 'website:' + source.sourceId ||
      current.source.providerItemId !== source.id) throw Error('来源目录不属于此漫画。');
  const previous = await tx.get('catalogs', source.id) as SourceCatalog | undefined;
  if (previous && (previous.comicId !== current.id || previous.observedAt > source.observedAt || previous.complete && !source.complete)) return current;
  const existing = await tx.list('entries', {index:'comicId', range:current.id, limit:10000});
  const bySource = new Map(existing.map(entry => [entry.sourceEntryId, entry]));
  const oldIds = new Set(previous?.entries.filter(entry => !entry.related).map(entry => entry.id));
  const available = new Set<string>(), entries:Entry[] = [];
  let added = 0;
  for (const item of source.entries.filter(item => !item.related)) {
    const old = bySource.get(item.id);
    const entry:Entry = old
      ? {...old, title:item.title, order:item.order, sequenceId:item.sequenceId, sourceUrl:item.url, sourceRemoved:undefined}
      : {id:crypto.randomUUID(), comicId:current.id, title:item.title, order:item.order, sequenceId:item.sequenceId,
        sourceEntryId:item.id, sourceUrl:item.url, format:'website', contentId:crypto.randomUUID(), generation:1,
        indexState:'pending', createdAt:now, updatedAt:now};
    if (!old || JSON.stringify(old) !== JSON.stringify(entry)) await tx.put('entries', entry);
    available.add(item.id); entries.push(entry);
    if (previous?.complete && source.complete && !oldIds.has(item.id)) added++;
  }
  if (source.complete) for (const entry of existing) {
    if (entry.sourceEntryId && !available.has(entry.sourceEntryId) && !entry.sourceRemoved)
      await tx.put('entries', {...entry, sourceRemoved:true});
  }
  const defaultEntry = entries.find(entry => entry.sourceEntryId === source.defaultEntryId) ?? (entries.length === 1 ? entries[0] : undefined);
  const policy = catalogSyncPolicy(current), updates = current.catalogUpdates;
  const next:Comic = {...current, title:source.title, sourceUrl:source.url, startEntryId:defaultEntry?.id,
    ...(added ? {updatedAt:now, catalogUpdates:{revision:(updates?.revision ?? 0) + 1,
      seenRevision:updates?.seenRevision ?? 0, count:(updates?.count ?? 0) + added}} : {}),
    ...(policy && source.complete ? {catalogSync:{nextCheckAt:now + policy.intervalMinutes * 60_000,
      lastAttemptAt:current.catalogSync?.lastAttemptAt, lastSuccessAt:now}} : {}),
  };
  await tx.put('comics', next);
  await tx.put('catalogs', {...source, comicId:current.id});
  return next;
}

/** A late refresh must never recreate a removed comic or overwrite a newer observation. */
export async function applyCatalogRefresh(comicId:string, generation:number, snapshot:SourceCatalogSnapshot, lease?:string) {
  const source = validateSourceCatalog(snapshot);
  if (!source.complete || !source.groups.every(group => group.complete)) throw Error('目录尚未完整加载。');
  return catalog.mutate(['comics','entries','catalogs','connections'], async tx => {
    const current = await tx.get('comics', comicId);
    if (!current || current.source.generation !== generation || lease && current.catalogSync?.lease !== lease) return;
    const connection = await tx.get('connections', current.source.connectionId);
    if (!connection || connection.status !== 'connected' || !catalogSyncPolicy(current)) return;
    return reconcileCatalog(tx, current, source);
  });
}

/** Acknowledge only the revision actually displayed, never an update arriving concurrently. */
export async function acknowledgeCatalogUpdates(comicId:string, revision:number) {
  await catalog.mutate(['comics'], async tx => {
    const comic = await tx.get('comics', comicId), updates = comic?.catalogUpdates;
    if (comic && updates && updates.revision === revision && updates.seenRevision < revision)
      await tx.put('comics', {...comic, catalogUpdates:{...updates, seenRevision:revision, count:0}});
  });
}
