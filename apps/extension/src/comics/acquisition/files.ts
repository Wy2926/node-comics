import { catalog, sourceRemovalKey } from '../repositories';
import type { CatalogRecord, Comic } from '../domain';
import type { RemoteReadingPlan } from '../sources/contracts';
import { requireSourceDriver } from '../sources/registry';
import type { DownloadTask } from '../application/types';
import {
  resolveRemoteDownload,
  registerRemoteContainer,
} from '../application/remote-library-service';
import {
  discardContainerImports,
  importContainerStream,
  isContainerAvailable,
  releaseContainer,
} from '../../storage/containers';
import { blockingReason, downloadErrorMessage, downloadRetryAt } from './index';

export type FileDownloadStatus =
  'queued' | 'running' | 'paused' | 'failed' | 'complete' | 'clearing';
export interface FileDownloadIntent extends CatalogRecord {
  connectionId: string;
  connectionGeneration: number;
  publicationId: string;
  representationId: string;
  title: string;
  contentId: string;
  importReferenceId?: string;
  importTargetReferenceId?: string;
  generation: number;
  status: FileDownloadStatus;
  createdAt: number;
  updatedAt: number;
  bytes: number;
  totalBytes?: number;
  owner?: string;
  error?: string;
  reason?: DownloadTask['reason'];
  retryAt?: number;
  comicId?: string;
  entryId?: string;
  sourceGeneration?: number;
  containerId?: string;
  sourceRemovalVersion: number;
}
export interface FileDownloadView {
  intent: FileDownloadIntent;
  comic?: Comic;
}
const prefix = 'file-download:';
export const remoteFileDownloadId = (connectionId: string, publicationId: string) =>
  prefix + JSON.stringify([connectionId, publicationId]);
const controllers = new Map<string, AbortController>();
const executions = new Map<string, Promise<void>>();
const changes = new Map<string, Promise<unknown>>();
const stopped = () => new DOMException('文件下载已暂停或来源访问已变化。', 'AbortError');
const activeStatus = (status: FileDownloadStatus) => status === 'queued' || status === 'running';
async function change<T>(id: string, action: () => Promise<T>): Promise<T> {
  if (globalThis.navigator?.locks) return navigator.locks.request('nc-file-download:' + id, action);
  const next = (changes.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
  changes.set(id, next);
  try {
    return await next;
  } finally {
    if (changes.get(id) === next) changes.delete(id);
  }
}
export const readRemoteFileDownload = async (id: string) =>
  (await catalog.get('metadata', id)) as FileDownloadIntent | undefined;
async function intents(): Promise<FileDownloadIntent[]> {
  return (await catalog.list('metadata', {
    range: IDBKeyRange.bound(prefix, prefix + '\uffff'),
    limit: Number.MAX_SAFE_INTEGER,
  })) as FileDownloadIntent[];
}
export async function listRemoteFileDownloads(): Promise<FileDownloadView[]> {
  return (
    await Promise.all(
      (await intents())
        .sort(
          (a, b) =>
            Number(a.status === 'complete') - Number(b.status === 'complete') ||
            a.createdAt - b.createdAt,
        )
        .map(async (intent) => ({
          intent,
          comic: intent.comicId ? await catalog.get('comics', intent.comicId) : undefined,
        })),
    )
  ).filter(({ intent, comic }) => intent.status !== 'clearing' || !intent.comicId || !!comic);
}

/** Resolve only metadata for the confirmation dialog; never open an acquisition response body. */
export async function prepareRemoteFileDownload(
  comicId: string,
  signal?: AbortSignal,
): Promise<{ connectionId: string; plan: RemoteReadingPlan }> {
  const comic = await catalog.get('comics', comicId),
    connection = comic && (await catalog.get('connections', comic.source.connectionId));
  if (!comic || comic.source.status !== 'active' || connection?.status !== 'connected')
    throw Error('来源访问已断开，请重新连接。');
  const provider = requireSourceDriver(connection.provider);
  if (!provider.catalog || !provider.files?.download) throw Error('此来源不提供完整文件下载。');
  const plan = await provider.catalog.resolve(connection, comic.source.providerItemId, {
    purpose: 'download',
    signal,
  });
  signal?.throwIfAborted();
  const [current, access] = await Promise.all([
    catalog.get('comics', comicId),
    catalog.get('connections', connection.id),
  ]);
  if (
    !current ||
    current.source.status !== 'active' ||
    current.source.generation !== comic.source.generation ||
    access?.status !== 'connected' ||
    access.generation !== connection.generation
  )
    throw stopped();
  if (
    plan.publication.id !== comic.source.providerItemId ||
    plan.kind === 'pages' ||
    plan.format === 'image-sequence'
  )
    throw Error('此出版物不提供完整文件下载。');
  return { connectionId: connection.id, plan };
}

/** Call only from the explicit download confirmation. Resolving/reading a feed never calls this. */
export async function queueRemoteFileDownload(
  connectionId: string,
  plan: RemoteReadingPlan,
  options: { confirmed: true },
): Promise<FileDownloadIntent> {
  if (options?.confirmed !== true) throw Error('请先确认下载完整源文件。');
  if (plan.kind === 'pages' || plan.format === 'image-sequence')
    throw Error('逐页来源应使用漫画离线缓存。');
  const id = remoteFileDownloadId(connectionId, plan.publication.id);
  return change(id, async () => {
    const previous = await readRemoteFileDownload(id);
    if (
      previous &&
      (activeStatus(previous.status) ||
        (previous.status === 'complete' && (await availableAttachment(previous))))
    )
      return previous;
    if (previous?.status === 'clearing') throw Error('正在清理离线内容，请稍后重试。');
    if (previous) await discardUnclaimed(previous);
    return catalog.mutate(['metadata', 'connections', 'comics', 'entries'], async (tx) => {
      const connection = await tx.get('connections', connectionId);
      if (!connection || connection.status !== 'connected')
        throw Error('来源访问已断开，请重新连接。');
      const current = (await tx.get('metadata', id)) as FileDownloadIntent | undefined;
      if (current && activeStatus(current.status)) return current;
      if (
        current?.status === 'complete' &&
        (current.generation !== previous?.generation ||
          current.containerId !== previous?.containerId)
      )
        return current;
      if (current?.retryAt && current.retryAt > Date.now())
        throw Error('来源暂时限制请求，请稍后继续。');
      const removed = await tx.get('tombstones', 'metadata:' + id);
      const sourceKey = JSON.stringify([connectionId, plan.publication.id]);
      const [comic] = await tx.list('comics', { index: 'sourceKey', range: sourceKey, limit: 1 });
      const sourceRemovalVersion = Number(
        (await tx.get('tombstones', sourceRemovalKey(sourceKey)))?.deletedAt ?? 0,
      );
      if (comic && comic.source.status !== 'active') throw Error('来源访问已断开，请重新连接。');
      const now = Date.now(),
        contentId = crypto.randomUUID(),
        intent: FileDownloadIntent = {
          id,
          connectionId,
          connectionGeneration: connection.generation,
          publicationId: plan.publication.id,
          representationId: plan.representationId,
          title: plan.publication.title,
          contentId,
          importReferenceId: contentId,
          generation: Math.max(current?.generation ?? 0, Number(removed?.generation) || 0) + 1,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
          bytes: 0,
          totalBytes: plan.size,
          sourceRemovalVersion,
          comicId: comic?.id,
          sourceGeneration: comic?.source.generation,
        };
      if (removed) await tx.remove('tombstones', 'metadata:' + id);
      await tx.put('metadata', intent);
      return intent;
    });
  });
}

/** Explicit resume restarts the transfer; partial byte ranges are never reused. */
export async function resumeRemoteFileDownload(
  id: string,
  expectedGeneration?: number,
): Promise<void> {
  await change(id, async () => {
    const previous = await readRemoteFileDownload(id);
    if (
      !previous ||
      (expectedGeneration !== undefined && previous.generation !== expectedGeneration) ||
      activeStatus(previous.status) ||
      (previous.status === 'complete' && (await availableAttachment(previous)))
    )
      return;
    if (previous.status === 'clearing') throw Error('正在清理离线内容，请稍后重试。');
    await discardUnclaimed(previous);
    await catalog.mutate(['metadata', 'connections', 'comics'], async (tx) => {
      const current = (await tx.get('metadata', id)) as FileDownloadIntent | undefined;
      if (!current || current.generation !== previous.generation) return;
      const connection = await tx.get('connections', current.connectionId),
        comic = current.comicId ? await tx.get('comics', current.comicId) : undefined;
      if (
        connection?.status !== 'connected' ||
        (current.comicId && (!comic || comic.source.status !== 'active'))
      )
        throw Error('来源访问已断开，请重新连接。');
      if (current.retryAt && current.retryAt > Date.now())
        throw Error('来源暂时限制请求，请稍后继续。');
      const sourceRemovalVersion = Number(
        (
          await tx.get(
            'tombstones',
            sourceRemovalKey(JSON.stringify([current.connectionId, current.publicationId])),
          )
        )?.deletedAt ?? 0,
      );
      const contentId = crypto.randomUUID();
      await tx.put('metadata', {
        ...current,
        status: 'queued',
        generation: current.generation + 1,
        connectionGeneration: connection.generation,
        sourceGeneration: comic?.source.generation,
        sourceRemovalVersion,
        contentId,
        importReferenceId: contentId,
        importTargetReferenceId: undefined,
        bytes: 0,
        containerId: undefined,
        entryId: undefined,
        owner: undefined,
        error: undefined,
        reason: undefined,
        retryAt: undefined,
        updatedAt: Date.now(),
      });
    });
  });
}

async function attached(intent: FileDownloadIntent) {
  const [entry] = await catalog.list('entries', {
    index: 'contentId',
    range: intent.contentId,
    limit: 1,
  });
  const comic = entry && (await catalog.get('comics', entry.comicId));
  return entry?.containerId &&
    comic?.source.connectionId === intent.connectionId &&
    comic.source.providerItemId === intent.publicationId
    ? { entry, comic }
    : undefined;
}
async function availableAttachment(intent: FileDownloadIntent) {
  const value = await attached(intent);
  return value && (await isContainerAvailable(value.entry.containerId!)) ? value : undefined;
}
async function discardUnclaimedTarget(intent: FileDownloadIntent) {
  if (!intent.containerId || !intent.importTargetReferenceId) return;
  const [owner] = await catalog.list('entries', {
    index: 'contentId',
    range: intent.importTargetReferenceId,
    limit: 1,
  });
  // Publication may already have won. Never release the target's claimed or older container.
  if (owner?.containerId !== intent.containerId)
    await releaseContainer(intent.containerId, intent.importTargetReferenceId);
}
async function discardUnclaimed(intent: FileDownloadIntent) {
  await discardUnclaimedTarget(intent);
  if (intent.importReferenceId && intent.importReferenceId !== intent.contentId)
    await discardContainerImports(intent.importReferenceId);
  if (!(await attached(intent))) await discardContainerImports(intent.contentId);
}
export async function pauseRemoteFileDownload(
  id: string,
  expectedGeneration?: number,
): Promise<void> {
  await change(id, async () => {
    const previous = await readRemoteFileDownload(id);
    if (
      !previous ||
      (expectedGeneration !== undefined && previous.generation !== expectedGeneration) ||
      ['complete', 'clearing'].includes(previous.status)
    )
      return;
    controllers.get(id)?.abort(stopped());
    const paused = await catalog.mutate(['metadata'], async (tx) => {
      const current = (await tx.get('metadata', id)) as FileDownloadIntent | undefined;
      if (
        current?.generation !== previous.generation ||
        ['complete', 'clearing'].includes(current.status)
      )
        return;
      const value = {
        ...current,
        status: 'paused' as const,
        generation: current.generation + 1,
        bytes: 0,
        owner: undefined,
        error: undefined,
        reason: undefined,
        updatedAt: Date.now(),
      };
      await tx.put('metadata', value);
      return value;
    });
    if (paused) await discardUnclaimed(paused);
  });
}
/** Clear retained bytes, not the remote publication, reading history or server file. */
export async function clearRemoteFileDownload(
  id: string,
  expectedGeneration?: number,
): Promise<void> {
  await change(id, async () => {
    const previous = await readRemoteFileDownload(id);
    if (
      !previous ||
      (expectedGeneration !== undefined && previous.generation !== expectedGeneration)
    )
      return;
    controllers.get(id)?.abort(stopped());
    const clearing = await catalog.mutate(['metadata', 'entries'], async (tx) => {
      const current = (await tx.get('metadata', id)) as FileDownloadIntent | undefined;
      if (current?.generation !== previous.generation) return;
      const next = {
        ...current,
        status: 'clearing' as const,
        generation: current.generation + 1,
        owner: undefined,
        updatedAt: Date.now(),
      };
      await tx.put('metadata', next);
      const [entry] = await tx.list('entries', {
        index: 'contentId',
        range: current.contentId,
        limit: 1,
      });
      if (entry?.containerId)
        await tx.put('entries', {
          ...entry,
          containerId: undefined,
          generation: entry.generation + 1,
          updatedAt: Date.now(),
        });
      return next;
    });
    if (!clearing) return;
    try {
      await discardUnclaimedTarget(clearing);
      await discardContainerImports(clearing.contentId);
      if (clearing.importReferenceId && clearing.importReferenceId !== clearing.contentId)
        await discardContainerImports(clearing.importReferenceId);
      await catalog.mutate(['metadata'], async (tx) => {
        const current = (await tx.get('metadata', id)) as FileDownloadIntent | undefined;
        if (current?.generation !== clearing.generation || current.status !== 'clearing') return;
        await tx.remove('metadata', id);
        await tx.put('tombstones', {
          id: 'metadata:' + id,
          generation: clearing.generation,
          deletedAt: Date.now(),
        });
      });
    } catch (error) {
      await catalog
        .patch(
          'metadata',
          id,
          { error: '离线文件清理未完成，请重试。', updatedAt: Date.now() },
          { expectedGeneration: clearing.generation },
        )
        .catch(() => {});
      throw error;
    }
  });
}

async function execute(intent: FileDownloadIntent, outer: AbortSignal): Promise<void> {
  const controller = new AbortController();
  controllers.set(intent.id, controller);
  const signal = AbortSignal.any([outer, controller.signal]);
  let transfer: ReadableStream<Uint8Array> | undefined;
  const assertCurrent = async () => {
    signal.throwIfAborted();
    const [current, connection, comic, removed] = await Promise.all([
      readRemoteFileDownload(intent.id),
      catalog.get('connections', intent.connectionId),
      intent.comicId ? catalog.get('comics', intent.comicId) : undefined,
      catalog.get(
        'tombstones',
        sourceRemovalKey(JSON.stringify([intent.connectionId, intent.publicationId])),
      ),
    ]);
    if (
      current?.status !== 'running' ||
      current.generation !== intent.generation ||
      connection?.generation !== intent.connectionGeneration ||
      connection.status !== 'connected' ||
      Number(removed?.deletedAt ?? 0) !== intent.sourceRemovalVersion ||
      (intent.comicId &&
        (!comic ||
          comic.source.status !== 'active' ||
          comic.source.generation !== intent.sourceGeneration))
    )
      throw stopped();
  };
  const patch = async (values: Partial<FileDownloadIntent>) =>
    catalog.mutate(['metadata'], async (tx) => {
      const current = (await tx.get('metadata', intent.id)) as FileDownloadIntent | undefined;
      if (current?.generation === intent.generation && current.status === 'running')
        await tx.put('metadata', { ...current, ...values, updatedAt: Date.now() });
    });
  const unsubscribe = catalog.subscribe((change) => {
    if (
      (change.table === 'metadata' && change.ids.includes(intent.id)) ||
      (change.table === 'connections' && change.ids.includes(intent.connectionId)) ||
      (change.table === 'comics' && !!intent.comicId && change.ids.includes(intent.comicId)) ||
      (change.table === 'tombstones' &&
        change.ids.includes(
          sourceRemovalKey(JSON.stringify([intent.connectionId, intent.publicationId])),
        ))
    )
      void assertCurrent().catch((error) => controller.abort(error));
  });
  try {
    await assertCurrent();
    const resolved = await resolveRemoteDownload(intent.connectionId, intent.publicationId, signal);
    transfer = resolved.transfer.stream;
    await assertCurrent();
    if (
      resolved.connection.generation !== intent.connectionGeneration ||
      resolved.plan.representationId !== intent.representationId
    )
      throw Error('来源文件已变化，请重新选择下载。');
    await patch({ totalBytes: resolved.transfer.size ?? resolved.plan.size });
    let progressAt = 0;
    const container = await importContainerStream(transfer, {
      name: resolved.transfer.name,
      size: resolved.transfer.size,
      signal,
      referenceId: intent.contentId,
      onProgress: async (bytes) => {
        await assertCurrent();
        if (Date.now() - progressAt >= 1000) {
          progressAt = Date.now();
          await patch({ bytes });
        }
      },
    });
    await assertCurrent();
    await patch({ containerId: container.id, bytes: container.size, totalBytes: container.size });
    // Registration publishes the reading entry and completes this intent in the same transaction.
    await registerRemoteContainer(resolved, container, intent.contentId, signal, {
      id: intent.id,
      generation: intent.generation,
    });
  } catch (error) {
    const latest = await readRemoteFileDownload(intent.id),
      published = latest && (await attached(latest));
    if (published) {
      // Publication already completed atomically; only finish the leftover import-reference cleanup.
      await discardUnclaimed(latest!).catch(() => {});
    } else {
      await discardUnclaimed(
        latest && latest.importReferenceId === intent.importReferenceId ? latest : intent,
      ).catch(() => {});
      const reason = blockingReason(error),
        interrupted =
          signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      // Keep the candidate identity until retry/clear finishes cleanup, even if storage is temporarily unavailable.
      await patch({
        status: interrupted || reason ? 'paused' : 'failed',
        bytes: 0,
        owner: undefined,
        reason: reason ?? (interrupted ? 'interrupted' : undefined),
        retryAt: downloadRetryAt(error),
        error: interrupted
          ? '文件下载已中断，继续时会重新下载完整文件。'
          : downloadErrorMessage(error),
      });
    }
  } finally {
    unsubscribe();
    if (controllers.get(intent.id) === controller) controllers.delete(intent.id);
    if (transfer && !transfer.locked) await transfer.cancel().catch(() => {});
  }
}

/** The existing visible-page download host owns both independent kinds of intent. */
export async function runRemoteFileDownloadCycle(
  signal: AbortSignal,
  owner: string,
): Promise<void> {
  signal.throwIfAborted();
  const pending = await intents();
  for (const clearing of pending.filter((intent) => intent.status === 'clearing')) {
    signal.throwIfAborted();
    await clearRemoteFileDownload(clearing.id, clearing.generation).catch(() => {});
  }
  const next = pending
    .filter((intent) => intent.status === 'queued')
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next || executions.has(next.id)) return;
  const run = (async () => {
    const claimed = await catalog.mutate(['metadata', 'connections'], async (tx) => {
      const current = (await tx.get('metadata', next.id)) as FileDownloadIntent | undefined,
        connection = await tx.get('connections', next.connectionId);
      if (current?.status !== 'queued' || current.generation !== next.generation) return;
      const enabled =
        connection?.status === 'connected' &&
        connection.generation === current.connectionGeneration;
      const value = {
        ...current,
        status: enabled ? ('running' as const) : ('paused' as const),
        owner: enabled ? owner : undefined,
        error: enabled ? undefined : '来源访问已变化，请重新连接后继续。',
        updatedAt: Date.now(),
      };
      await tx.put('metadata', value);
      return value;
    });
    if (claimed?.status === 'running') await execute(claimed, signal);
  })();
  executions.set(next.id, run);
  try {
    await run;
  } finally {
    if (executions.get(next.id) === run) executions.delete(next.id);
  }
}
export function stopRemoteFileDownloads() {
  for (const controller of controllers.values()) controller.abort(stopped());
}
export async function recoverRemoteFileDownloads(started: number): Promise<void> {
  for (const intent of await intents()) {
    if (intent.status === 'clearing') {
      await clearRemoteFileDownload(intent.id, intent.generation).catch(() => {});
      continue;
    }
    if (intent.status === 'complete') {
      if (intent.importReferenceId && intent.importReferenceId !== intent.contentId)
        await discardContainerImports(intent.importReferenceId);
      if (!(await availableAttachment(intent)))
        await catalog.patch(
          'metadata',
          intent.id,
          {
            status: 'paused',
            bytes: 0,
            reason: 'space',
            error: '本地源文件已移除，请继续以重新下载。',
            updatedAt: Date.now(),
          },
          { expectedGeneration: intent.generation },
        );
      continue;
    }
    if (!activeStatus(intent.status)) {
      await discardUnclaimed(intent);
      continue;
    }
    if (intent.createdAt >= started && intent.status === 'queued') continue;
    // Attached entries and completion are published atomically; older active intents only have temporary bytes.
    await pauseRemoteFileDownload(intent.id, intent.generation);
    await catalog.patch(
      'metadata',
      intent.id,
      { bytes: 0, reason: 'interrupted', error: '文件下载已中断，继续时会重新下载完整文件。' },
      { expectedGeneration: intent.generation + 1 },
    );
  }
}
