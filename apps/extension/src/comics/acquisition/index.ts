import { catalog } from '../repositories';
import {entryContentKind, type Entry} from '../domain';
import type { DownloadTask } from '../application/types';
import {websiteContentError} from '../application/website-content';
import {prepareEntryContent} from '../application/entry-content';
import { acquirePage } from '../pages/service';
import { pageRenderProfile } from '../pages/identity';
import { downloadKey, downloadStore } from '../../storage/downloads';
import { ImagePermissionsRequired } from '../../sources';
import {bookDownloadId,downloadTaskId as taskId,bookTaskActive,suspendBook,listBookPlans,isBookDownloadActive,isEntryFullyCached,type BookDownloadPlan} from './book-model';

const controllers = new Map<string, AbortController>();
const sameTask=(current:DownloadTask|undefined,expected:DownloadTask)=>current?.generation===expected.generation&&current.bookId===expected.bookId&&current.bookGeneration===expected.bookGeneration;
const LEASE_MS = 90_000;
let running: Promise<void> | undefined;
let runController: AbortController | undefined;
export const downloadErrorMessage = websiteContentError;
const message=downloadErrorMessage;
const aborted = () => new DOMException('下载已暂停或文档已移除。', 'AbortError');
type DiscoveryOptions={reload?:boolean;refreshResources?:boolean};
const retainedPages=async(document:Entry)=>(await downloadStore.inventory([document.id],true)).filter(item=>item.contentId===document.contentId);

/** Metadata discovery only. Opening a document never creates an explicit download task. */
export async function discoverEntryContent(id: string, signal?: AbortSignal, options:DiscoveryOptions={}): Promise<void> {
  signal?.throwIfAborted();
  const document = await catalog.get('entries', id);
  if (!document) throw Error('文档已移除。');
  if (entryContentKind(document) !== 'pages') return;
  await discoverContent(document,signal,options);
}
async function discoverContent(document:Entry,signal:AbortSignal|undefined,{reload=false,refreshResources=false}:DiscoveryOptions,saved?:Awaited<ReturnType<typeof retainedPages>>):Promise<void>{
  if(!reload&&!refreshResources&&document.discoveryComplete)return;
  if(!reload&&document.discoveryComplete&&document.pageCount){
    if(isEntryFullyCached(document,(saved??await retainedPages(document)).length))return;
  }
  if (document.sourceRemoved || document.readable === false) throw Error('源站此章节暂不可读，已保存的页面仍可阅读。');
  if (document.discoveryComplete&&!reload) {
    if(!refreshResources)return;
    if(document.format==='website'){
      const pages=await catalog.listPages(document.contentId,{limit:1500});
      if(!pages.some(page=>typeof page.locator.contentKey==='string'))return;
    }
  }
  await prepareEntryContent(document.id,signal,{reload,refreshResources});
}

/** Idempotent intent registration. It does not start network work or grant permissions. */
export async function queueDownloads(ids: string[], book?:{comicId:string;generation:number}, signal?:AbortSignal): Promise<void> {
  const queuedAt = Date.now(), unique = [...new Set(ids)];
  // A bounded transaction avoids cloning the whole book plan for every chapter.
  // Pause/cancel writes serialize with each batch and are rechecked before the next.
  for (let offset=0;offset<unique.length;offset+=100) {
    signal?.throwIfAborted();
    await catalog.mutate(['entries','comics','tasks','metadata'],async tx=>{
      let members:Set<string>|undefined;
      if(book){
        const plan=await tx.get('metadata',bookDownloadId(book.comicId)) as BookDownloadPlan|undefined;
        const comic=await tx.get('comics',book.comicId);
        if(plan?.generation!==book.generation||!isBookDownloadActive(plan.status)||comic?.source.status!=='active'||comic.source.generation!==plan.sourceGeneration)return;
        members=new Set(plan.entryIds);
      }
      for(let queueOrder=offset;queueOrder<Math.min(offset+100,unique.length);queueOrder++){
        const id=unique[queueOrder],document=await tx.get('entries',id);
        if(!document||entryContentKind(document)!=='pages'||book&&(document.comicId!==book.comicId||!members!.has(id)))continue;
        const old=await tx.get('tasks',taskId(id)) as DownloadTask|undefined;
        if((old?.status==='running'||old?.status==='queued')&&(!book||old.bookGeneration===book.generation))continue;
        // An explicit fresh plan may recreate its tasks; stale preparations cannot cross the guard above.
        await tx.remove('tombstones','tasks:'+taskId(id));
        await tx.put('tasks',{...old,id:taskId(id),entryId:id,status:'queued',generation:(old?.generation??0)+1,entryGeneration:document.generation,contentId:document.contentId,completed:old?.contentId===document.contentId?old.completed:0,total:document.pageCount,updatedAt:Date.now(),queuedAt,queueOrder,error:undefined,reason:undefined,leaseUntil:undefined,
          ...(book?{bookId:book.comicId,bookGeneration:book.generation}:{})} satisfies DownloadTask);
      }
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
export async function listDownloads(): Promise<DownloadTask[]> { return await catalog.list('tasks', { limit: Number.MAX_SAFE_INTEGER }) as DownloadTask[]; }

async function recoverInterrupted(holdsLock: boolean): Promise<void> {
  const tasks = await catalog.list('tasks', { index: 'status', range: 'running', limit: Number.MAX_SAFE_INTEGER }) as DownloadTask[];
  for (const old of tasks) {
    if (!holdsLock && typeof old.leaseUntil === 'number' && old.leaseUntil > Date.now()) continue;
    const paused = await catalog.editTask(old.id, old.entryId, record => {
      const current = record as DownloadTask | undefined;
      return current?.status === 'running' && sameTask(current,old) ? { ...current, status: 'paused', generation: current.generation + 1, leaseUntil: undefined, updatedAt: Date.now(), error: '下载页面已关闭，点击继续恢复。' } : undefined;
    });
    if (paused) await downloadStore.invalidateOwner(old.entryId);
  }
}
async function execute(task: DownloadTask, outerSignal?: AbortSignal): Promise<void> {
  const controller = new AbortController(); controllers.set(task.entryId, controller);
  const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
  const active = async () => {
    signal.throwIfAborted();
    const [current, document] = await Promise.all([catalog.get('tasks', task.id), catalog.get('entries', task.entryId)]);
    if (!current || current.status !== 'running' || !sameTask(current as DownloadTask,task) || !document || document.generation !== task.entryGeneration || document.contentId !== task.contentId || !await bookTaskActive(task)) throw aborted();
    return document;
  };
  const patch = async (values: Partial<DownloadTask>) => catalog.editTask(task.id, task.entryId, record => {
    const current = record as DownloadTask | undefined;
    return current?.status === 'running' && sameTask(current,task) ? { ...current, ...values, updatedAt: Date.now(), leaseUntil: values.status && values.status !== 'running' ? undefined : Date.now() + LEASE_MS } : undefined;
  });
  const unsubscribe = catalog.subscribe(change => {
    if (change.table==='tasks'&&change.ids.includes(task.id)||change.table==='entries'&&change.ids.includes(task.entryId)||
      task.bookId&&change.table==='metadata'&&change.ids.includes(bookDownloadId(task.bookId))) void active().catch(error => controller.abort(error));
  });
  const heartbeat = setInterval(() => { void active().then(() => patch({})).catch(error => controller.abort(error)); }, 20_000);
  try {
    let document=await active();
    const retained=await retainedPages(document);
    await discoverContent(document,signal,{refreshResources:true},retained);
    document=await active();
    // Resuming checks retained object keys once, without loading saved image Blobs again.
    const saved=new Map(retained.map(item=>[item.key,item.size]));
    if(isEntryFullyCached(document,saved.size)){
      await patch({status:'complete',completed:saved.size,total:document.pageCount,bytes:retained.reduce((sum,item)=>sum+item.size,0),error:undefined,pageErrors:{},leaseUntil:undefined});
      return;
    }
    let offset = 0, completed = 0, failed = 0, bytes=0;
    const errors: Record<string, string> = {};
    await patch({ total: document.pageCount, error: undefined, pageErrors: {} });
    const token = await downloadStore.token(task.entryId);
    while (true) {
      document = await active();
      const pages = await catalog.listPages(document.contentId, { offset, limit: 100 });
      if (!pages.length) break;
      for (const page of pages) {
        await active();
        const renderProfileId=pageRenderProfile(document.format),key = downloadKey(document.contentId, page.pageId,renderProfileId);
        const size=saved.get(key);
        if (size!==undefined) { completed++; bytes+=size; continue; }
        try {
          let attempt=0;
          const read=()=>acquirePage({ entryId: document.id, contentId: document.contentId, pageId: page.pageId, renderProfileId, signal, priority: 'background', purpose: 'download' });
          const lease = await (async()=>{
            for(;;){try{return await read();}catch(error){
              await active();
              if(!task.bookId||blockingReason(error)||attempt++>=1)throw error;
              await new Promise(resolve=>setTimeout(resolve,300));await active();
            }}
          })();
          try {
            await active();
            if (!await downloadStore.put(key, lease.blob, { owner: document.id, contentId: document.contentId, token })) throw aborted();
            await active(); completed++; bytes+=lease.blob.size;
          } finally { lease.release(); }
        } catch (error) {
          await active();
          if (blockingReason(error) || (error instanceof DOMException && error.name === 'AbortError')) throw error;
          errors[page.pageId] = message(error); failed++;
        }
        await patch({ completed, bytes,pageErrors: { ...errors } });
      }
      offset += pages.length;
    }
    await active();
    const complete=isEntryFullyCached(document,completed);
    await patch({ status: failed ? 'failed' : complete ? 'complete' : 'paused', completed,bytes, total: document.pageCount, error: failed ? `${failed} 页下载失败，已完成页面可以阅读。` : complete ? undefined : '来源仍有待发现页面，请打开来源后继续。', leaseUntil: undefined });
  } catch (error) {
    const reason=blockingReason(error);
    if(task.bookId&&reason&&!signal.aborted)await pauseBlockedDownloads(task.bookId,error);
    const paused = signal.aborted || error instanceof ImagePermissionsRequired || error instanceof DOMException && (error.name === 'AbortError' || error.name === 'QuotaExceededError');
    await patch({ status: paused ? 'paused' : 'failed', reason,error: message(error), leaseUntil: undefined });
  } finally { clearInterval(heartbeat); unsubscribe(); if (controllers.get(task.entryId) === controller) controllers.delete(task.entryId); }
}

async function drain(holdsLock: boolean, signal?: AbortSignal): Promise<void> {
  await recoverInterrupted(holdsLock);
  while (!signal?.aborted) {
    const tasks = await catalog.list('tasks', { index: 'status', range: 'queued', limit: Number.MAX_SAFE_INTEGER }) as DownloadTask[];
    if (!tasks.length) break;
    tasks.sort((a, b) => Number(a.queuedAt ?? a.updatedAt) - Number(b.queuedAt ?? b.updatedAt) || Number(a.queueOrder ?? 0) - Number(b.queueOrder ?? 0) || a.id.localeCompare(b.id));
    // Read the queue once per batch, while rechecking each intent before claiming it.
    for(const next of tasks){
      if(signal?.aborted)break;
      const enabled=await bookTaskActive(next);
      const claimed = await catalog.editTask(next.id, next.entryId, (record, document) => {
        const current = record as DownloadTask | undefined;
        return current?.status === 'queued'&&sameTask(current,next) ? { ...current, status: enabled?'running':'paused', generation: current.generation + 1, entryGeneration: document.generation, contentId: document.contentId, leaseUntil: enabled?Date.now() + LEASE_MS:undefined, updatedAt: Date.now() } : undefined;
      }) as DownloadTask | undefined;
      if (claimed?.status==='running') await execute(claimed, signal);
      else if (!await catalog.get('entries', next.entryId)) await catalog.remove('tasks', next.id);
    }
  }
}
export function blockingReason(error:unknown):DownloadTask['reason']{
  if(error instanceof ImagePermissionsRequired||(error as {kind?:string})?.kind==='permission-required')return 'permission';
  if(error instanceof DOMException&&error.name==='QuotaExceededError')return 'space';
  if(typeof navigator!=='undefined'&&navigator.onLine===false)return 'network';
  if(error instanceof Error&&(error.name==='TimeoutError'||error.cause instanceof TypeError)||error instanceof TypeError)return 'network';
  const details=(error as {details?:{status?:number;retryAfter?:number}})?.details;
  if(details?.status===401||details?.status===403||details?.status===429||details?.retryAfter)return 'source';
  return undefined;
}
export function downloadRetryAt(error:unknown):number|undefined{
  const details=(error as {details?:{status?:number;retryAfter?:number}})?.details;
  const seconds=details?.retryAfter??(details?.status===429?60:0);
  return seconds>0?Date.now()+seconds*1000:undefined;
}
export async function pauseBlockedDownloads(comicId:string,error:unknown){
  const reason=blockingReason(error);if(!reason)return;
  const comic=await catalog.get('comics',comicId);
  for(const plan of await listBookPlans()){
    if(!isBookDownloadActive(plan.status))continue;
    const other=await catalog.get('comics',plan.comicId);
    if(reason==='space'||other?.source.connectionId===comic?.source.connectionId)await suspendBook(plan.comicId,'paused',reason,message(error),plan.generation,downloadRetryAt(error));
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
