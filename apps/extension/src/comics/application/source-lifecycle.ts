import { catalog, sourceCleanupKey, sourceCleanupRange } from '../repositories';
import type {CatalogRecord,Entry} from '../domain';
import { onSourceAccessChanged, requireSourceDriver } from '../sources/registry';
import { getSourceAccount, selectSourceFiles } from './source-service';
import { invalidateSourceAccess, restoreSourceSelection } from './source-access';
export { invalidateSourceAccess } from './source-access';
import { sourcePageCache } from '../../storage/source-pages';
import { sourceRangeCache } from '../../storage/source-ranges';
import { thumbnailCache } from '../../storage/thumbnails';
import { translationCache } from '../../storage/translations';
import { downloadStore } from '../../storage/downloads';
import { estimateStorage, relieveStoragePressure } from '../../storage/pressure';
import { recoverContainerImports, listContainerImports, listContainerReferences, releaseContainer } from '../../storage/containers';
import { registerLocalContainer, importSourceFiles } from './import-service';
import { completeImportJournal, type LocalImportJournal } from './import-journal';
import { sourceLock } from './locks';
import {closeSourceAccess} from '../sources/runtime';
import {removeComic} from './library-service';
import {sourceCoverOwner} from './cover-access';
import {pauseDownloads} from '../acquisition';
import {remoteFileDownloadConnectionRange,removeRemoteFileDownloads} from '../acquisition/files';
import {blockSourceTranslationEntry,inspectSourceTranslationEntry,removeSourceTranslationEntry,removeSourceTranslationImages,type SourceTranslationResultReference} from './source-translation-removal';


async function recoverJournal(journal: LocalImportJournal) {
  const [existing]=await catalog.list('entries',{index:'contentId',range:journal.contentId,limit:1});
  if(existing){await completeImportJournal(journal.contentId);return;}
  const saved=await listContainerReferences(journal.contentId);
  const container=saved.find(item=>item.id===journal.file.containerId||item.fileName===journal.file.name&&item.size===journal.file.size);
  try {
    if(container){const result=await registerLocalContainer({...container,fileName:journal.file.name},journal.contentId);if(result.created)return;}
  } finally {
    const [entry]=await catalog.list('entries',{index:'contentId',range:journal.contentId,limit:1});
    for(const item of saved)if(item.id!==entry?.containerId)await releaseContainer(item.id,journal.contentId);
    await completeImportJournal(journal.contentId);
  }
}

let subscribed = false;
export async function initializeSources() {
  if (!subscribed) { onSourceAccessChanged(invalidateSourceAccess); subscribed = true; }
  const space = await estimateStorage();
  if (space.available !== undefined && space.available < 16 * 1024 ** 2) await relieveStoragePressure(16 * 1024 ** 2 - space.available);
  await sourceLock(async () => {
    await recoverContainerImports();
    // Startup recovery visits at most 100 registered intents, not every saved file in the library.
    const journals = await catalog.list('metadata', { range: IDBKeyRange.bound('local-import:', 'local-import:\uffff'), limit: 100 }) as LocalImportJournal[];
    for (const journal of journals) await recoverJournal(journal).catch(() => {});
  });
}
export async function reconnectSource(connectionId: string) {
  const connection = await getSourceAccount(connectionId);
  const reconnect=requireSourceDriver(connection.provider).connection?.reconnect;
  if(reconnect){
    const restored=await reconnect(connection);
    if(restored.id!==connection.id||restored.provider!==connection.provider||restored.accountId!==connection.accountId)throw Error('来源账户身份不匹配。');
    await restoreSourceSelection({connection:restored,files:[]});return;
  }
  const selection = await selectSourceFiles(connection.provider, connection);
  const result=await importSourceFiles(selection);
  if(result.failures.length)throw Error(result.failures.map(item=>item.name+'：'+item.error).join('；'));
}
export async function disconnectSource(connectionId: string) {
  const connection = await getSourceAccount(connectionId);
  const driver = requireSourceDriver(connection.provider);
  if (!driver.connection?.disconnect) throw Error('此来源不支持断开连接。');
  await driver.connection.disconnect(connection);
  await invalidateSourceAccess({connectionId});
}
export interface SourceRemovalSummary {comicCount:number;downloadTaskCount:number}
const removalJournalId=(connectionId:string)=>'source-removal:'+JSON.stringify(connectionId);
interface SourceEntryCleanup extends CatalogRecord {
  entryId:string;contentId:string;containerId?:string;resultRefs?:SourceTranslationResultReference[];
}
/** Only this connection's indexed records are read; no covers, file bytes or server requests. */
export async function inspectSourceRemoval(connectionId:string):Promise<SourceRemovalSummary> {
  const account=await getSourceAccount(connectionId);
  if(!requireSourceDriver(account.provider).connection?.remove)throw Error('此来源不支持移除连接。');
  const comicCount=await catalog.count('comics',{index:'connectionId',range:connectionId});
  let pageDownloadCount=0,after:string|undefined;
  for(;;){
    const batch=await catalog.listConnectionComics(connectionId,100,after);
    for(const comic of batch){
      let entryAfter:string|undefined;
      for(;;){
        const entries=await catalog.listComicEntries(comic.id,100,entryAfter);
        for(const entry of entries)pageDownloadCount+=await catalog.count('tasks',{index:'entryId',range:entry.id});
        if(entries.length<100)break;
        entryAfter=entries.at(-1)!.id;
      }
    }
    if(batch.length<100)break;
    after=batch.at(-1)!.id;
  }
  const fileDownloadCount=await catalog.count('metadata',{range:remoteFileDownloadConnectionRange(connectionId)});
  return {comicCount,downloadTaskCount:pageDownloadCount+fileDownloadCount};
}
async function prepareEntryCleanup(connectionId:string,entry:Entry) {
  const id=sourceCleanupKey('entry',connectionId,entry.id);
  await blockSourceTranslationEntry(entry.id);
  if(await catalog.get('metadata',id))return;
  const resultRefs=await inspectSourceTranslationEntry(entry.id);
  await catalog.put('metadata',{id,entryId:entry.id,contentId:entry.contentId,containerId:entry.containerId,resultRefs});
}
async function cleanupEntry(journal:SourceEntryCleanup) {
  await blockSourceTranslationEntry(journal.entryId);
  await removeSourceTranslationEntry(journal.entryId);
  await Promise.all([
    sourcePageCache.deleteOwner(journal.entryId,true),sourceRangeCache.deleteOwner(journal.entryId,true),
    thumbnailCache.deleteOwner(journal.entryId,true),downloadStore.deleteOwner(journal.entryId,true),
  ]);
  if(journal.containerId)await releaseContainer(journal.containerId,journal.contentId);
  await removeSourceTranslationImages([],journal.resultRefs??[]);
  await catalog.remove('metadata',journal.id);
}
const removals=new Map<string,Promise<void>>();
async function removeSourceContents(connectionId:string):Promise<void> {
  const connection=await catalog.get('connections',connectionId);
  if(!connection&&await catalog.get('tombstones','connections:'+connectionId))return;
  const account=connection??await getSourceAccount(connectionId),driver=requireSourceDriver(account.provider);
  if(!driver.connection?.remove)throw Error('此来源不支持移除连接。');
  await sourceLock(()=>catalog.mutate(['connections','metadata'],async tx=>{
    if(await tx.get('metadata',removalJournalId(connectionId)))return;
    const current=await tx.get('connections',connectionId),now=Date.now();
    await tx.put('connections',{...account,...current,status:'disconnected',generation:(current?.generation??0)+1,createdAt:current?.createdAt??now,updatedAt:now});
    await tx.put('metadata',{id:removalJournalId(connectionId),connectionId});
    // The row stays visible for retries while all concurrent reconnections/publications are fenced.
    await tx.put('tombstones',{id:'connections:'+connectionId,deletedAt:now});
  }));
  await closeSourceAccess({connectionId});
  await driver.connection.remove(account);
  // Removing batches keeps connection traversal bounded even for very large libraries.
  for(;;){
    const batch=await catalog.listConnectionComics(connectionId,100);
    if(!batch.length)break;
    for(const comic of batch){
      let entryAfter:string|undefined;
      for(;;){
        const entries=await catalog.listComicEntries(comic.id,100,entryAfter);
        for(const entry of entries)await prepareEntryCleanup(connectionId,entry);
        await pauseDownloads(entries.map(entry=>entry.id));
        if(entries.length<100)break;
        entryAfter=entries.at(-1)!.id;
      }
      await removeComic(comic.id,connectionId);
    }
  }
  await removeRemoteFileDownloads(connectionId);
  for(;;){
    const batch=await catalog.list('metadata',{range:sourceCleanupRange('entry',connectionId),limit:100}) as SourceEntryCleanup[];
    if(!batch.length)break;
    for(const journal of batch)await cleanupEntry(journal);
  }
  for(;;){
    const batch=await catalog.list('metadata',{range:sourceCleanupRange('cover',connectionId),limit:100});
    if(!batch.length)break;
    for(const journal of batch){await thumbnailCache.deleteOwner(sourceCoverOwner(String(journal.comicId)),true);await catalog.remove('metadata',journal.id);}
  }
  for(;;){
    const batch=await catalog.list('metadata',{range:sourceCleanupRange('image',connectionId),limit:100});
    if(!batch.length)break;
    await removeSourceTranslationImages(batch.map(journal=>String(journal.imageSha256)));
    for(const journal of batch)await catalog.remove('metadata',journal.id);
  }
  await Promise.all([sourcePageCache.deleteConnection(connectionId),sourceRangeCache.deleteConnection(connectionId),thumbnailCache.deleteConnection(connectionId)]);
  await catalog.mutate(['connections','metadata'],async tx=>{
    await tx.remove('connections',connectionId);
    await tx.remove('metadata',removalJournalId(connectionId));
  });
}
/** Explicit local removal is idempotent. A failed cleanup keeps the disconnected row and journals. */
export function removeSource(connectionId:string):Promise<void> {
  const previous=removals.get(connectionId);if(previous)return previous;
  const execute=()=>removeSourceContents(connectionId);
  const pending=(globalThis.navigator?.locks?navigator.locks.request<void>('nc-remove-source:'+connectionId,execute):execute())
    .finally(()=>{if(removals.get(connectionId)===pending)removals.delete(connectionId);});
  removals.set(connectionId,pending);return pending;
}
export async function storageOverview() {
  const [sourcePages, ranges, translations, thumbnails, downloads, device] = await Promise.all([sourcePageCache.usage(), sourceRangeCache.usage(), translationCache.usage(), thumbnailCache.usage(), downloadStore.usage(), estimateStorage()]);
  const containers = new Map<string, number>(); let after: string | undefined;
  do { const batch = await listContainerImports(100, after); after = batch.next; for (const container of batch.items) containers.set(container.id, container.size); } while (after);
  return { containers: [...containers.values()].reduce((sum, size) => sum + size, 0), sourcePages, ranges, translations, thumbnails, downloads, device };
}
export async function clearStorage(kind: 'sourcePages' | 'ranges' | 'translations' | 'thumbnails') { await ({ sourcePages: sourcePageCache, ranges: sourceRangeCache, translations: translationCache, thumbnails: thumbnailCache })[kind].clear(); }
