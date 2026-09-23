import { catalog } from '../repositories';
import { onSourceAccessChanged, requireSourceDriver } from '../sources/registry';
import { connectionCapabilities, selectSourceFiles } from './source-service';
import { invalidateSourceAccess } from './source-access';
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
  const connection = await catalog.get('connections', connectionId);
  if (!connection) throw Error('来源连接已移除。');
  const selection = await selectSourceFiles(connection.provider, connection);
  const result=await importSourceFiles(selection);
  if(result.failures.length)throw Error(result.failures.map(item=>item.name+'：'+item.error).join('；'));
}
export async function disconnectSource(connectionId: string) {
  const connection = await catalog.get('connections', connectionId);
  if (!connection) throw Error('来源连接已移除。');
  const driver = requireSourceDriver(connection.provider);
  if (!driver.disconnect) throw Error('此来源不支持断开连接。');
  await driver.disconnect(connection);
  await invalidateSourceAccess({connectionId});
}
export async function storageOverview() {
  const [sourcePages, ranges, translations, thumbnails, downloads, connections, device] = await Promise.all([sourcePageCache.usage(), sourceRangeCache.usage(), translationCache.usage(), thumbnailCache.usage(), downloadStore.usage(), catalog.list('connections', { limit: 1000 }), estimateStorage()]);
  const containers = new Map<string, number>(); let after: string | undefined;
  do { const batch = await listContainerImports(100, after); after = batch.next; for (const container of batch.items) containers.set(container.id, container.size); } while (after);
  return { containers: [...containers.values()].reduce((sum, size) => sum + size, 0), sourcePages, ranges, translations, thumbnails, downloads, connections: connections.map(connection => ({...connection, ...connectionCapabilities(connection)})), device };
}
export async function clearStorage(kind: 'sourcePages' | 'ranges' | 'translations' | 'thumbnails') { await ({ sourcePages: sourcePageCache, ranges: sourceRangeCache, translations: translationCache, thumbnails: thumbnailCache })[kind].clear(); }
