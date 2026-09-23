import { catalog } from '../repositories';
import { onSourceAccessChanged, requireSourceDriver } from '../sources/registry';
import { connectionCapabilities, selectSourceFiles } from './source-service';
import { invalidateSourceAccess, restoreSourceSelection } from './source-access';
export { invalidateSourceAccess } from './source-access';
import { sourcePageCache } from '../../storage/source-pages';
import { sourceRangeCache } from '../../storage/source-ranges';
import { thumbnailCache } from '../../storage/thumbnails';
import { translationCache } from '../../storage/translations';
import { downloadStore } from '../../storage/downloads';
import { estimateStorage, relieveStoragePressure } from '../../storage/pressure';
import { recoverContainerImports, listContainerImports, listContainerReferences, releaseContainer } from '../../storage/containers';
import { registerDocument } from './import-service';
import { completeImportJournal, type LocalImportJournal } from './import-journal';
import { sourceLock } from './locks';
import { Sha256 } from '../../importers/hash';

const digest = (value: string) => new Sha256().update(new TextEncoder().encode(value)).digest();

async function recoverJournal(journal: LocalImportJournal) {
  const existing = await catalog.get('revisions', journal.revisionId);
  if (existing) { await completeImportJournal(journal.revisionId); return; }
  const saved = await listContainerReferences(journal.revisionId);
  const targetRemoved = await catalog.get('tombstones', 'revisions:' + journal.revisionId)
    || journal.assignment.workId && !await catalog.get('works', journal.assignment.workId)
    || journal.assignment.unitId && !await catalog.get('units', journal.assignment.unitId);
  if (targetRemoved || !saved.length) {
    for (const container of saved) await releaseContainer(container.id, journal.revisionId);
    await completeImportJournal(journal.revisionId); return;
  }
  // At most the currently copying file can have published between a byte commit and journal update.
  const ordered = journal.files.map((file, index) => {
    const match = file.containerId ? saved.find(container => container.id === file.containerId) : index === journal.currentIndex ? saved.find(container => container.fileName === file.name && container.size === file.size) : undefined;
    return match ? { ...match, fileName: file.name } : undefined;
  }).filter((value): value is NonNullable<typeof value> => !!value);
  if (!ordered.length) throw Error('已保存的源文件与导入记录不一致，请管理本地资料后重新导入。');
  const album = journal.kind === 'images', complete = ordered.length === journal.files.length;
  const containerIds = ordered.map(container => container.id), destination = journal.assignment.unitId ?? journal.assignment.workId ?? 'new';
  const result = await registerDocument({ title: journal.title, format: album ? 'images' : ordered[0].format,
    sourceKey: album ? 'album:' + digest(JSON.stringify(containerIds)) + ':' + destination : 'local:' + ordered[0].id + ':' + destination,
    connectionId: 'local', provider: 'local', displayName: album ? '本地图集' : '本地源文件',
    locator: album ? {} : { containerId: ordered[0].id, name: ordered[0].fileName },
    containerId: album ? undefined : ordered[0].id, revisionId: journal.revisionId,
    sourceSnapshot: album ? { containerIds, fileNames: ordered.map(container => container.fileName), importComplete: complete, expectedPageCount: journal.files.length } : undefined,
  }, journal.assignment);
  if (!result.created) for (const container of saved) await releaseContainer(container.id, journal.revisionId);
  else {
    for (const container of saved) if (!containerIds.includes(container.id)) await releaseContainer(container.id, journal.revisionId);
    await catalog.patch('documents', result.document.id, { indexState: 'failed', error: complete ? '源文件已完整保存，点击恢复目录继续。' : `图集导入中断，已保存 ${ordered.length} / ${journal.files.length} 张；请重新选择完整图集。` });
  }
  await completeImportJournal(journal.revisionId);
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
    for (const journal of journals) await recoverJournal(journal);
  });
}
export async function reconnectSource(connectionId: string) {
  const connection = await catalog.get('connections', connectionId);
  if (!connection) throw Error('来源连接已移除。');
  const selection = await selectSourceFiles(connection.provider, connection);
  await restoreSourceSelection(selection);
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
