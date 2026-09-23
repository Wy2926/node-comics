import { catalog } from '../repositories';
import type { DownloadTask, ImportAssignment, SourceCatalog } from '../application/types';
import { importWebsiteEntry, publishWebsiteManifest } from '../application/import-service';
import { acquirePage } from '../pages/service';
import { RENDER_PROFILE } from '../pages/identity';
import { downloadKey, downloadStore } from '../../storage/downloads';
import { discoverEntry, ImagePermissionsRequired, requestImagePermissions } from '../../sources';
import type { PageManifest, SourceEntry } from '../../sources';

const taskId = (documentId: string) => 'download:' + documentId;
const controllers = new Map<string, AbortController>();
const LEASE_MS = 90_000;
let running: Promise<void> | undefined;
let runController: AbortController | undefined;
const message = (error: unknown) => error instanceof Error ? error.message : '原图下载失败，请重试。';
const aborted = () => new DOMException('下载已暂停或文档已移除。', 'AbortError');

export function suggestedUnitKind(entry: SourceEntry): ImportAssignment['kind'] {
  return entry.suggestedKind === 'chapter' || entry.suggestedKind === 'extra' ? 'chapter' : entry.suggestedKind === 'publication' ? 'volume' : entry.suggestedKind === 'work' ? 'book' : 'unclassified';
}
export async function importCatalogEntries(source: SourceCatalog, entries: SourceEntry[], assignment: ImportAssignment, overrides: Record<string, ImportAssignment['kind']> = {}) {
  let sharedWork = assignment.workId, created = 0;
  const ids: string[] = [];
  for (const entry of entries) {
    if (!(await catalog.list('documents', { index: 'sourceKey', range: 'website:' + entry.id, limit: 1 })).length) created++;
    const id = await importWebsiteEntry(source, entry, entry.related ? { title: entry.title, kind: 'unclassified' } : { ...assignment, workId: sharedWork, kind: overrides[entry.id] ?? suggestedUnitKind(entry), role: entry.suggestedKind === 'extra' ? 'extra' : 'main' });
    if (!entry.related && !sharedWork) {
      const document = await catalog.get('documents', id), unit = document && await catalog.get('units', document.unitId);
      sharedWork = unit?.workId;
    }
    ids.push(id);
  }
  return { ids, created };
}

/** Metadata discovery only. Opening a document never creates an explicit download task. */
export async function discoverDocument(id: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const document = await catalog.get('documents', id);
  if (!document) throw Error('文档已移除。');
  if (document.format !== 'website' || document.discoveryComplete) return;
  const binding = await catalog.get('bindings', document.sourceBindingId);
  const source = typeof binding?.locator.catalogId === 'string' ? await catalog.get('catalogs', binding.locator.catalogId) as unknown as SourceCatalog | undefined : undefined;
  if (!source || !document.sourceEntryId) {
    if (document.pageCount) return; // Explicit fixed selections have no catalog discovery workflow.
    throw Error('来源目录不可用，请打开来源重新导入。');
  }
  const assertActive = async () => {
    signal?.throwIfAborted(); const current = await catalog.get('documents', id);
    if (!current || current.generation !== document.generation || current.revisionId !== document.revisionId) throw aborted();
  };
  const update = async (manifest: PageManifest) => { await assertActive(); await publishWebsiteManifest(document, manifest); };
  try {
    const manifest = await discoverEntry(source, document.sourceEntryId, signal ?? new AbortController().signal, update, assertActive);
    await update(manifest);
  } catch (error) {
    await catalog.patch('documents', id, { error: message(error), indexState: 'failed' }, { expectedGeneration: document.generation }).catch(() => {});
    throw error;
  }
}

/** Idempotent intent registration. It does not start network work or grant permissions. */
export async function queueDownloads(ids: string[]): Promise<void> {
  const queuedAt = Date.now();
  for (const [queueOrder, id] of [...new Set(ids)].entries()) {
    await catalog.editTask(taskId(id), id, (record, document) => {
      if (document.format !== 'website') return undefined;
      const old = record as DownloadTask | undefined;
      if (old?.status === 'running' || old?.status === 'queued') return undefined;
      return { ...old, id: taskId(id), documentId: id, status: 'queued', generation: (old?.generation ?? 0) + 1, documentGeneration: document.generation, revisionId: document.revisionId, completed: old?.completed ?? 0, total: document.pageCount, updatedAt: Date.now(), queuedAt, queueOrder, error: undefined, leaseUntil: undefined } satisfies DownloadTask;
    });
  }
}
export async function pauseDownloads(ids: string[]): Promise<void> {
  for (const id of new Set(ids)) {
    controllers.get(id)?.abort(aborted());
    await catalog.editTask(taskId(id), id, record => {
      const old = record as DownloadTask | undefined;
      return old && old.status !== 'complete' ? { ...old, status: 'paused', generation: old.generation + 1, updatedAt: Date.now(), leaseUntil: undefined, error: '已暂停，已保存的页面会继续保留。' } : undefined;
    });
    await downloadStore.invalidateOwner(id);
  }
}
/** Pass origins prepared during rendering; permission requests must stay in the click call stack. */
export async function grantDownloads(ids: string[], preparedOrigins: string[] = []): Promise<void> {
  await requestImagePermissions(preparedOrigins); await queueDownloads(ids);
}
export async function listDownloads(): Promise<DownloadTask[]> { return await catalog.list('tasks', { limit: 1000 }) as DownloadTask[]; }

async function recoverInterrupted(holdsLock: boolean): Promise<void> {
  const tasks = await catalog.list('tasks', { index: 'status', range: 'running', limit: 1000 }) as DownloadTask[];
  for (const old of tasks) {
    if (!holdsLock && typeof old.leaseUntil === 'number' && old.leaseUntil > Date.now()) continue;
    const paused = await catalog.editTask(old.id, old.documentId, record => {
      const current = record as DownloadTask | undefined;
      return current?.status === 'running' && current.generation === old.generation ? { ...current, status: 'paused', generation: current.generation + 1, leaseUntil: undefined, updatedAt: Date.now(), error: '下载页面已关闭，点击继续恢复。' } : undefined;
    });
    if (paused) await downloadStore.invalidateOwner(old.documentId);
  }
}
async function execute(task: DownloadTask, outerSignal?: AbortSignal): Promise<void> {
  const controller = new AbortController(); controllers.set(task.documentId, controller);
  const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
  const active = async () => {
    signal.throwIfAborted();
    const [current, document] = await Promise.all([catalog.get('tasks', task.id), catalog.get('documents', task.documentId)]);
    if (!current || current.status !== 'running' || current.generation !== task.generation || !document || document.generation !== task.documentGeneration || document.revisionId !== task.revisionId) throw aborted();
    return document;
  };
  const patch = async (values: Partial<DownloadTask>) => catalog.editTask(task.id, task.documentId, record => {
    const current = record as DownloadTask | undefined;
    return current?.status === 'running' && current.generation === task.generation ? { ...current, ...values, updatedAt: Date.now(), leaseUntil: values.status && values.status !== 'running' ? undefined : Date.now() + LEASE_MS } : undefined;
  });
  const unsubscribe = catalog.subscribe(change => {
    if (change.table === 'tasks' || change.table === 'documents') void active().catch(error => controller.abort(error));
  });
  const heartbeat = setInterval(() => { void active().then(() => patch({})).catch(error => controller.abort(error)); }, 20_000);
  try {
    await active(); await discoverDocument(task.documentId, signal);
    let document = await active(), offset = 0, completed = 0, failed = 0;
    const errors: Record<string, string> = {};
    await patch({ total: document.pageCount, error: undefined, pageErrors: {} });
    const token = await downloadStore.token(task.documentId);
    while (true) {
      document = await active();
      const pages = await catalog.listPages(document.revisionId, { offset, limit: 100 });
      if (!pages.length) break;
      for (const page of pages) {
        await active();
        const key = downloadKey(document.revisionId, page.pageId);
        if (await downloadStore.get(key)) { completed++; await patch({ completed }); continue; }
        try {
          const lease = await acquirePage({ documentId: document.id, revisionId: document.revisionId, pageId: page.pageId, renderProfileId: RENDER_PROFILE, signal, priority: 'background', purpose: 'download' });
          try {
            await active();
            if (!await downloadStore.put(key, lease.blob, { owner: document.id, revisionId: document.revisionId, token })) throw aborted();
            await active(); completed++;
          } finally { lease.release(); }
        } catch (error) {
          await active();
          if (error instanceof ImagePermissionsRequired || (error instanceof DOMException && error.name === 'QuotaExceededError') || (error instanceof DOMException && error.name === 'AbortError')) throw error;
          errors[page.pageId] = message(error); failed++;
        }
        await patch({ completed, pageErrors: { ...errors } });
      }
      offset += pages.length;
    }
    await active();
    await patch({ status: failed ? 'failed' : document.discoveryComplete ? 'complete' : 'paused', completed, total: document.pageCount, error: failed ? `${failed} 页下载失败，已完成页面可以阅读。` : document.discoveryComplete ? undefined : '来源仍有待发现页面，请打开来源后继续。', leaseUntil: undefined });
  } catch (error) {
    const paused = signal.aborted || error instanceof ImagePermissionsRequired || error instanceof DOMException && (error.name === 'AbortError' || error.name === 'QuotaExceededError');
    await patch({ status: paused ? 'paused' : 'failed', error: message(error), leaseUntil: undefined });
  } finally { clearInterval(heartbeat); unsubscribe(); if (controllers.get(task.documentId) === controller) controllers.delete(task.documentId); }
}

async function drain(holdsLock: boolean, signal?: AbortSignal): Promise<void> {
  await recoverInterrupted(holdsLock);
  while (!signal?.aborted) {
    const tasks = await catalog.list('tasks', { index: 'status', range: 'queued', limit: 1000 }) as DownloadTask[];
    const next = tasks.sort((a, b) => Number(a.queuedAt ?? a.updatedAt) - Number(b.queuedAt ?? b.updatedAt) || Number(a.queueOrder ?? 0) - Number(b.queueOrder ?? 0) || a.id.localeCompare(b.id))[0];
    if (!next) break;
    const claimed = await catalog.editTask(next.id, next.documentId, (record, document) => {
      const current = record as DownloadTask | undefined;
      return current?.status === 'queued' ? { ...current, status: 'running', generation: current.generation + 1, documentGeneration: document.generation, revisionId: document.revisionId, leaseUntil: Date.now() + LEASE_MS, updatedAt: Date.now() } : undefined;
    }) as DownloadTask | undefined;
    if (claimed) await execute(claimed, signal);
    else if (!await catalog.get('documents', next.documentId)) await catalog.remove('tasks', next.id);
  }
}
/** The visible extension page owns this lifetime; reopening never auto-resumes interrupted work. */
export function runDownloads(signal?: AbortSignal): Promise<void> {
  if (running) return running;
  const controller = new AbortController(); runController = controller;
  const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const execute = async () => {
    if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request('nc-website-downloads', { ifAvailable: true }, lock => lock ? drain(true, lifetime) : Promise.resolve());
    else await drain(false, lifetime);
  };
  running = execute().finally(() => { running = undefined; if (runController === controller) runController = undefined; }); return running;
}
export function stopDownloads(): void { runController?.abort(aborted()); for (const controller of controllers.values()) controller.abort(aborted()); }
