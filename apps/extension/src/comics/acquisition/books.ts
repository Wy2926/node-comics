import {catalog} from '../repositories';
import {entryContentKind, type Comic} from '../domain';
import type {SourceCatalog} from '../application/types';
import {readWebsiteCatalog} from '../application/website-catalog';
import {reconcileCatalog} from '../application/catalog-service';
import {downloadStore} from '../../storage/downloads';
import {pauseDownloads,queueDownloads,runDownloads,stopDownloads,listDownloads,blockingReason,pauseBlockedDownloads,downloadErrorMessage} from './index';
import {msg} from '../../i18n/runtime';
import {sourceFor} from '../../sources';
import {track} from '../../analytics';
import {getSourceDriver} from '../sources/registry';
import {recoverRemoteFileDownloads,runRemoteFileDownloadCycle,stopRemoteFileDownloads} from './files';
import {bookDownloadId,downloadTaskId,listBookPlans,readBookPlan,selectDownloadScope,suspendBook,isBookDownloadActive,isEntryFullyCached,type BookDownloadPlan,type DownloadLanguages,type DownloadScope} from './book-model';
export {type BookDownloadPlan,type DownloadLanguages,type DownloadScope,downloadLanguage,unknownDownloadLanguage,isBookDownloadActive,isEntryFullyCached} from './book-model';

const preferencesId=(id:string)=>'download-languages:'+id;
const hostId='download-host';
const changes=new Map<string,Promise<unknown>>();
/** Serialize cross-database teardown with starts, including concurrent extension pages. */
async function changeBook<T>(comicId:string,action:()=>Promise<T>):Promise<T>{
  if(globalThis.navigator?.locks)return navigator.locks.request('nc-book-download:'+comicId,action);
  const run=(changes.get(comicId)??Promise.resolve()).catch(()=>{}).then(action);changes.set(comicId,run);
  try{return await run;}finally{if(changes.get(comicId)===run)changes.delete(comicId);}
}
const interrupted=()=>new DOMException('缓存操作已停止。','AbortError');
const active=(plan:BookDownloadPlan|undefined,generation:number):plan is BookDownloadPlan=>plan?.generation===generation&&isBookDownloadActive(plan.status);
export async function readComicOfflineCapability(comicId:string):Promise<'pages'|'file'|'local'|'none'>{
  const comic=await catalog.get('comics',comicId);if(!comic)return 'none';
  const [connection,entries]=await Promise.all([catalog.get('connections',comic.source.connectionId),catalog.listEntries(comicId,{limit:1})]);
  if(!connection||!entries[0])return 'none';
  if(connection.provider==='local')return 'local';
  if(entryContentKind(entries[0])==='pages')return 'pages';
  return getSourceDriver(connection.provider)?.files?.download?'file':'none';
}
export async function downloadLanguages(comicId:string):Promise<DownloadLanguages>{
  const record=await catalog.get('metadata',preferencesId(comicId));
  return Array.isArray(record?.languages)?record.languages as string[]:null;
}
export async function saveDownloadLanguages(comicId:string,languages:DownloadLanguages){
  if(languages&&!languages.length)throw Error('至少选择一种语言。');
  await catalog.mutate(['comics','metadata'],async tx=>{
    if(!await tx.get('comics',comicId))throw interrupted();
    await tx.put('metadata',{id:preferencesId(comicId),languages:languages?[...new Set(languages)]:null});
  });
}
export async function readDownloadScope(comicId:string,languages:DownloadLanguages=null):Promise<DownloadScope>{
  const comic=await catalog.get('comics',comicId);if(!comic)throw interrupted();
  const entries=await catalog.listEntries(comicId,{limit:Number.MAX_SAFE_INTEGER});
  const [source]=await catalog.list('catalogs',{index:'comicId',range:comicId,limit:1}) as unknown as SourceCatalog[];
  return {...selectDownloadScope(entries,source,languages),title:comic.title};
}
/** Registration is atomic and network-free. The single host prepares the full directory. */
export async function startBookDownload(comicId:string,languages?:DownloadLanguages,rebuild=false,expectedNetworkGeneration?:number,expectedPlanGeneration?:number):Promise<boolean>{
  return changeBook(comicId,async()=>{
    const selection=languages===undefined?await downloadLanguages(comicId):languages;
    if(selection&&!selection.length)throw Error('至少选择一种语言。');
    const old=await readBookPlan(comicId);
    if(expectedPlanGeneration!==undefined&&old?.generation!==expectedPlanGeneration)return false;
    if(old?.retryAt&&old.retryAt>Date.now())throw Error(msg('来源暂时限制请求，请在 {0} 后继续。',{'0':new Date(old.retryAt).toLocaleTimeString()}));
    if(old?.status==='clearing')throw Error('正在清理离线内容，请稍后重试。');
    if(old&&isBookDownloadActive(old.status)&&!rebuild)return false;
    if(old&&rebuild)await suspendBook(comicId,'paused',undefined,undefined,old.generation);
    return catalog.mutate(['comics','connections','entries','metadata'],async tx=>{
      const comic=await tx.get('comics',comicId),connection=comic&&await tx.get('connections',comic.source.connectionId);
      if(!comic||comic.source.status!=='active'||!connection||['disconnected','revoked'].includes(connection.status))throw Error('来源访问已断开，请重新连接。');
      const [entry]=await tx.list('entries',{index:'comicId',range:comicId,limit:1});
      if(!entry||entryContentKind(entry)!=='pages')throw Error('此来源暂不支持整本缓存。');
      const previous=await tx.get('metadata',bookDownloadId(comicId)) as BookDownloadPlan|undefined;
      if(expectedNetworkGeneration!==undefined&&(previous?.generation!==expectedNetworkGeneration||previous.status!=='paused'||previous.reason!=='network'))return false;
      if(previous?.retryAt&&previous.retryAt>Date.now())throw Error(msg('来源暂时限制请求，请在 {0} 后继续。',{'0':new Date(previous.retryAt).toLocaleTimeString()}));
      if(previous&&(isBookDownloadActive(previous.status)||previous.status==='clearing'))return false;
      const preserve=!rebuild&&languages===undefined&&previous?.entryIds.length;
      const host=await tx.get('metadata',hostId),tombstoneId='metadata:'+bookDownloadId(comicId);
      const removed=await tx.get('tombstones',tombstoneId);
      // Keep the incarnation monotonic even though cancellation removes the visible plan.
      const generation=Math.max(previous?.generation??0,Number(removed?.generation)||0)+1;
      if(removed)await tx.remove('tombstones',tombstoneId);
      const plan:BookDownloadPlan={id:bookDownloadId(comicId),comicId,sourceGeneration:comic.source.generation,generation,
        status:'queued',languages:preserve?previous.languages:selection,entryIds:preserve?previous.entryIds:[],
        owner:typeof host?.owner==='string'?host.owner:undefined,networkRetries:expectedNetworkGeneration===undefined?0:(previous?.networkRetries??0)+1,createdAt:Date.now(),updatedAt:Date.now()};
      if(languages!==undefined)await tx.put('metadata',{id:preferencesId(comicId),languages:selection});
      await tx.put('metadata',plan);return true;
    });
  });
}
export const pauseBookDownload=(id:string,expectedGeneration?:number)=>changeBook(id,()=>suspendBook(id,'paused',undefined,undefined,expectedGeneration));
export const cancelBookDownload=(id:string,expectedGeneration?:number)=>clearBookDownloads(id,expectedGeneration);

async function ensureDirectory(plan:BookDownloadPlan,signal:AbortSignal){
  const entries=await catalog.listEntries(plan.comicId,{limit:2});
  // Remote page publications are already one complete resource, not an OPDS navigation tree.
  if(entries.length===1&&entries[0].format==='image-sequence')return;
  let [source]=await catalog.list('catalogs',{index:'comicId',range:plan.comicId,limit:1}) as unknown as SourceCatalog[];
  if(source?.complete&&source.groups.every(group=>group.complete))return;
  const comic=await catalog.get('comics',plan.comicId);
  if(!comic?.sourceUrl)throw Error('来源目录不可用。');
  // A dedicated single-page source already represents the complete imported resource.
  if(!source&&typeof comic.source.locator.catalogId!=='string'&&!sourceFor(comic.sourceUrl).definition.capabilities.catalog)return;
  source=await readWebsiteCatalog(comic.sourceUrl,signal);
  signal.throwIfAborted();
  if(!source.complete||!source.groups.every(group=>group.complete))throw Error('目录尚未完整加载，请重试。');
  await catalog.mutate(['metadata','comics','entries','catalogs','connections'],async tx=>{
    const current=await tx.get('metadata',plan.id) as BookDownloadPlan|undefined,owner=await tx.get('comics',plan.comicId);
    const connection=owner&&await tx.get('connections',owner.source.connectionId);
    if(!active(current,plan.generation)||!owner||owner.source.generation!==plan.sourceGeneration||connection?.status!=='connected')throw interrupted();
    await reconcileCatalog(tx,owner,source);
  });
}
async function prepareBook(plan:BookDownloadPlan,owner:string,outerSignal:AbortSignal){
  const controller=new AbortController(),signal=AbortSignal.any([outerSignal,controller.signal]);
  const unsubscribe=catalog.subscribe(change=>{
    if(change.table==='metadata'&&change.ids.includes(plan.id))void readBookPlan(plan.comicId).then(current=>{if(!active(current,plan.generation))controller.abort();}).catch(()=>controller.abort());
  });
  try{
    await catalog.patch('metadata',plan.id,{status:'preparing',owner,updatedAt:Date.now()},{expectedGeneration:plan.generation});
    await ensureDirectory(plan,signal);signal.throwIfAborted();
    const scope=await readDownloadScope(plan.comicId,plan.languages);
    const planned=new Set(plan.entryIds),entries=planned.size?scope.entries.filter(entry=>planned.has(entry.id)):scope.selected;
    if(!entries.length)throw Error('所选语言没有可缓存的章节，请调整语言。');
    await catalog.mutate(['metadata','comics'],async tx=>{
      const current=await tx.get('metadata',plan.id) as BookDownloadPlan|undefined,comic=await tx.get('comics',plan.comicId);
      if(!active(current,plan.generation)||comic?.source.generation!==plan.sourceGeneration)throw interrupted();
      await tx.put('metadata',{...current,entryIds:entries.map(entry=>entry.id),
        catalogAt:scope.catalogAt,missingLanguages:scope.missingLanguages});
    });
    await queueDownloads(entries.map(entry=>entry.id),{comicId:plan.comicId,generation:plan.generation},signal);
    signal.throwIfAborted();
    await catalog.mutate(['metadata'],async tx=>{
      const current=await tx.get('metadata',plan.id) as BookDownloadPlan|undefined;
      if(!active(current,plan.generation))throw interrupted();
      await tx.put('metadata',{...current,status:'running',owner,error:undefined,reason:undefined,updatedAt:Date.now()});
    });
  }catch(error){
    if(active(await readBookPlan(plan.comicId),plan.generation)){
      if(!signal.aborted&&blockingReason(error))await pauseBlockedDownloads(plan.comicId,error);
      else await suspendBook(plan.comicId,'paused',signal.aborted?'interrupted':undefined,downloadErrorMessage(error),plan.generation);
    }
  }finally{unsubscribe();}
}
export interface BookDownloadView {comic:Comic;plan:BookDownloadPlan;availableLanguages:string[];completed:number;total:number;bytes:number;newChapters:number;hasPendingTasks:boolean;status:BookDownloadPlan['status'];}
/** UI summaries read metadata only. Startup and terminal checks also verify retained object presence. */
export async function listBookDownloads(verify=false,comicIds?:Set<string>):Promise<BookDownloadView[]>{
  const plans=(await listBookPlans()).filter(plan=>!comicIds||comicIds.has(plan.comicId));
  if(!plans.length)return [];
  const tasks=new Map((await listDownloads()).map(task=>[task.entryId,task]));
  const views:BookDownloadView[]=[];
  for(const plan of plans){
    const comic=await catalog.get('comics',plan.comicId);if(!comic)continue;
    const scope=await readDownloadScope(comic.id,plan.languages),entries=new Map(scope.entries.map(entry=>[entry.id,entry])),planned=new Set(plan.entryIds);
    const inventory=await downloadStore.inventory(scope.entries.map(entry=>entry.id),verify);
    const counts=new Map<string,number>();
    for(const item of inventory)if(item.owner&&item.contentId===entries.get(item.owner)?.contentId)counts.set(item.owner,(counts.get(item.owner)??0)+1);
    let completed=0,hasPendingTasks=false;
    for(const id of plan.entryIds){
      const entry=entries.get(id);if(!entry)continue;
      if(isEntryFullyCached(entry,counts.get(id)??0))completed++;
      const task=tasks.get(id);
      if(task?.contentId===entry.contentId&&['queued','running'].includes(task.status))hasPendingTasks=true;
    }
    views.push({comic,plan,availableLanguages:scope.languages.map(language=>language.id),completed,total:plan.entryIds.length,bytes:inventory.reduce((sum,item)=>sum+item.size,0),hasPendingTasks,
      newChapters:scope.selected.filter(entry=>!planned.has(entry.id)).length,
      status:plan.status==='complete'&&completed!==plan.entryIds.length?'partial':plan.status});
  }
  return views.sort((a,b)=>Number(a.status==='complete')-Number(b.status==='complete')||a.plan.createdAt-b.plan.createdAt);
}
/** Cancellation and clearing remove the offline resource; pause alone retains a resumable plan. */
export async function clearBookDownloads(comicId:string,expectedGeneration?:number){
  return changeBook(comicId,async()=>{
    const previous=await readBookPlan(comicId);if(!previous||expectedGeneration!==undefined&&previous.generation!==expectedGeneration)return;
    try{
      if(previous.status!=='clearing')await suspendBook(comicId,'clearing');
      const plan=await readBookPlan(comicId);if(!plan||plan.status!=='clearing')return;
      const entries=await catalog.listEntries(comicId,{limit:Number.MAX_SAFE_INTEGER});
      const ids=[...new Set([...plan.entryIds,...entries.map(entry=>entry.id)])];
      for(const id of ids)await downloadStore.deleteOwner(id);
      await catalog.mutate(['metadata','tasks'],async tx=>{
        const current=await tx.get('metadata',plan.id) as BookDownloadPlan|undefined;
        if(current?.generation!==plan.generation||!['clearing','stopped'].includes(current.status))return;
        for(const id of ids)await tx.remove('tasks',downloadTaskId(id));
        await tx.remove('metadata',plan.id);
        await tx.put('tombstones',{id:'metadata:'+plan.id,generation:plan.generation,deletedAt:Date.now()});
      });
    }catch(error){
      // Keep deletion durable across a closed page or temporary storage failure.
      const current=await readBookPlan(comicId).catch(()=>undefined);
      if(current?.status==='clearing')await catalog.patch('metadata',current.id,{status:'clearing',error:downloadErrorMessage(error),reason:undefined,updatedAt:Date.now()},{expectedGeneration:current.generation}).catch(()=>{});
      throw error;
    }
  });
}

async function settleBooks(){
  const running=new Set((await listBookPlans()).filter(plan=>plan.status==='running').map(plan=>plan.comicId));
  if(!running.size)return;
  for(const view of await listBookDownloads(true,running)){
    if(view.status!=='running')continue;
    if(view.hasPendingTasks)continue;
    const status=view.total>0&&view.completed===view.total?'complete':'partial';
    const settled=await catalog.mutate(['metadata'],async tx=>{
      const plan=await tx.get('metadata',view.plan.id) as BookDownloadPlan|undefined;
      if(plan?.generation!==view.plan.generation||plan.status!=='running')return false;
      await tx.put('metadata',{...plan,status,owner:undefined,updatedAt:Date.now()});return true;
    });
    if(settled)track('offline_download_result',{surface:'reader',source_type:'website',outcome:status==='complete'?'success':'partial',count:Math.min(10000,view.completed),duration_ms:Math.min(86400000,Math.max(0,Date.now()-view.plan.createdAt))},view.plan.createdAt);
  }
}
/** A host iteration; production callers hold the book host lock for their full lifetime. */
export async function runBookDownloadCycle(signal:AbortSignal,owner:string){
  await runRemoteFileDownloadCycle(signal,owner);
  if(signal.aborted)return;
  const queued=(await listBookPlans()).filter(plan=>plan.status==='queued').sort((a,b)=>a.createdAt-b.createdAt)[0];
  if(queued)await prepareBook(queued,owner,signal);
  if(signal.aborted)return;
  await runDownloads(signal);await settleBooks();
}
const sleep=(signal:AbortSignal)=>new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,1000);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});
/** One visible extension page owns the host lock. Other tabs only register intents and observe. */
export async function hostBookDownloads(signal:AbortSignal){
  const started=Date.now(),owner=crypto.randomUUID();
  const host=async()=>{
    await catalog.put('metadata',{id:hostId,owner});
    await recoverRemoteFileDownloads(started);
    for(const plan of await listBookPlans())if(plan.status==='clearing')await clearBookDownloads(plan.comicId).catch(()=>{});
    for(const plan of await listBookPlans())if((isBookDownloadActive(plan.status)||plan.reason==='network')&&plan.owner!==owner&&(plan.owner||plan.createdAt<started))
      await suspendBook(plan.comicId,'paused','interrupted',undefined,plan.generation);
    const legacy=(await listDownloads()).filter(task=>!task.bookId);
    await pauseDownloads(legacy.filter(task=>['queued','running'].includes(task.status)).map(task=>task.entryId));
    // Existing chapter downloads remain visible and manageable after their old entry is removed.
    const comics=new Set((await Promise.all(legacy.map(task=>catalog.get('entries',task.entryId)))).flatMap(entry=>entry?[entry.comicId]:[]));
    for(const comicId of comics){
      const comic=await catalog.get('comics',comicId);if(!comic||await readBookPlan(comicId))continue;
      const scope=await readDownloadScope(comicId);
      await catalog.mutate(['comics','metadata'],async tx=>{
        if(!await tx.get('comics',comicId)||await tx.get('metadata',bookDownloadId(comicId))||await tx.get('tombstones','metadata:'+bookDownloadId(comicId)))return;
        await tx.put('metadata',{id:bookDownloadId(comicId),comicId,sourceGeneration:comic.source.generation,generation:1,status:'paused',
          languages:null,entryIds:scope.selected.map(entry=>entry.id),createdAt:Date.now(),updatedAt:Date.now()});
      });
    }
    for(const view of await listBookDownloads(true))if(view.plan.status==='complete'&&view.status==='partial')
      await catalog.patch('metadata',view.plan.id,{status:'partial',updatedAt:Date.now()},{expectedGeneration:view.plan.generation});
    try{
      while(!signal.aborted){
        for(const plan of await listBookPlans())if(plan.status==='paused'&&plan.reason==='network'&&(plan.networkRetries??0)<2&&(!plan.retryAt||plan.retryAt<=Date.now())&&globalThis.navigator?.onLine!==false){
          try{await startBookDownload(plan.comicId,undefined,false,plan.generation);}
          catch(error){await suspendBook(plan.comicId,'paused',undefined,downloadErrorMessage(error),plan.generation);}
        }
        await runBookDownloadCycle(signal,owner);await sleep(signal);
      }
    }finally{
      stopDownloads();stopRemoteFileDownloads();
      for(const plan of await listBookPlans())if(plan.owner===owner&&isBookDownloadActive(plan.status))
        await suspendBook(plan.comicId,'paused','interrupted',undefined,plan.generation);
    }
  };
  if(globalThis.navigator?.locks){
    try{await navigator.locks.request('nc-book-download-host',{signal},host);}catch(error){if(!signal.aborted)throw error;}
  }else await host();
}
