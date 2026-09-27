import {catalog} from '../repositories';
import type {CatalogRecord, Entry} from '../domain';
import type {DownloadTask, SourceCatalog} from '../application/types';
import {downloadStore} from '../../storage/downloads';

export const bookDownloadId = (comicId:string) => 'book-download:' + comicId;
export const downloadTaskId = (entryId:string) => 'download:' + entryId;
export const unknownDownloadLanguage = 'und';
export type DownloadLanguages = string[] | null;
export interface BookDownloadPlan extends CatalogRecord {
  comicId:string; sourceGeneration:number; generation:number;
  status:'queued'|'preparing'|'running'|'paused'|'partial'|'complete'|'clearing';
  languages:DownloadLanguages; entryIds:string[];
  createdAt:number; updatedAt:number; owner?:string; error?:string;
  reason?:DownloadTask['reason']; missingLanguages?:number; catalogAt?:number; retryAt?:number; networkRetries?:number;
}
export interface DownloadScope {
  title?:string;
  entries:Entry[]; languages:{id:string;count:number}[];
  selected:Entry[]; missingLanguages:number; catalogAt?:number;
}
export const isBookDownloadActive=(status:BookDownloadPlan['status']|undefined)=>status==='queued'||status==='preparing'||status==='running';
export function isEntryFullyCached(entry:Pick<Entry,'discoveryComplete'|'pageCount'|'knownTotal'>,cachedPages:number):boolean{
  return !!entry.discoveryComplete&&Number.isSafeInteger(entry.pageCount)&&(entry.pageCount??0)>0&&
    (entry.knownTotal==null||entry.knownTotal===entry.pageCount)&&cachedPages===entry.pageCount;
}
export function downloadLanguage(value?:string):string {
  if(!value)return unknownDownloadLanguage;
  try {
    const locale=new Intl.Locale(value);
    return locale.language==='zh'?'zh-'+locale.maximize().script:locale.baseName;
  } catch {return unknownDownloadLanguage;}
}
export function selectDownloadScope(entries:Entry[], source:SourceCatalog|undefined, languages:DownloadLanguages):DownloadScope {
  const related=new Set(source?.entries.filter(entry=>entry.related).map(entry=>entry.id));
  const unique=[...new Map(entries.filter(entry=>entry.format==='website'&&!related.has(entry.sourceEntryId??'')).map(entry=>[entry.id,entry])).values()];
  const counts=new Map<string,number>();
  for(const entry of unique){const key=downloadLanguage(entry.contentLanguage);counts.set(key,(counts.get(key)??0)+1);}
  const selected=unique.filter(entry=>!languages||languages.includes(downloadLanguage(entry.contentLanguage)));
  const slots=new Map<string,Entry[]>();
  for(const entry of unique)if(entry.readingSlotId){const key=JSON.stringify([entry.sequenceId,entry.readingSlotId]);slots.set(key,[...slots.get(key)??[],entry]);}
  const missingLanguages=languages?[...slots.values()].filter(values=>languages.some(language=>!values.some(entry=>downloadLanguage(entry.contentLanguage)===language))).length:0;
  return {entries:unique,selected,missingLanguages,catalogAt:source?.observedAt,
    languages:[...counts].map(([id,count])=>({id,count})).sort((a,b)=>a.id.localeCompare(b.id))};
}
// Old stopped records are cleanup intents, never resumable plans.
const currentPlan=(plan:BookDownloadPlan):BookDownloadPlan=>(plan.status as string)==='stopped'?{...plan,status:'clearing'}:plan;
export async function readBookPlan(comicId:string):Promise<BookDownloadPlan|undefined>{
  const plan=await catalog.get('metadata',bookDownloadId(comicId)) as BookDownloadPlan|undefined;
  return plan&&currentPlan(plan);
}
export async function listBookPlans():Promise<BookDownloadPlan[]>{
  const plans=await catalog.list('metadata',{range:IDBKeyRange.bound('book-download:','book-download:\uffff'),limit:Number.MAX_SAFE_INTEGER}) as BookDownloadPlan[];
  return plans.map(currentPlan);
}
export async function bookTaskActive(task:DownloadTask):Promise<boolean>{
  if(!task.bookId)return true;
  const plan=await readBookPlan(task.bookId);
  const comic=await catalog.get('comics',task.bookId);
  return !!plan&&plan.status==='running'&&plan.generation===task.bookGeneration&&plan.entryIds.includes(task.entryId)&&comic?.source.status==='active'&&comic.source.generation===plan.sourceGeneration;
}
/** Change intent first; the storage generation fences any late in-flight writes before returning. */
export async function suspendBook(comicId:string,status:'paused'|'clearing',reason?:DownloadTask['reason'],error?:string,expectedGeneration?:number,retryAt?:number){
  const ids=await catalog.mutate(['metadata','tasks'],async tx=>{
    const plan=await tx.get('metadata',bookDownloadId(comicId)) as BookDownloadPlan|undefined;
    if(!plan||expectedGeneration!==undefined&&plan.generation!==expectedGeneration||['clearing','stopped'].includes(plan.status)&&status!=='clearing')return [];
    await tx.put('metadata',{...plan,status,generation:plan.generation+1,owner:undefined,reason,error,retryAt:retryAt??plan.retryAt,updatedAt:Date.now()});
    for(const id of plan.entryIds){
      const task=await tx.get('tasks',downloadTaskId(id)) as DownloadTask|undefined;
      if(task&&task.status!=='complete')await tx.put('tasks',{...task,status:'paused',generation:task.generation+1,reason,error,leaseUntil:undefined,updatedAt:Date.now()});
    }
    return plan.entryIds;
  });
  for(const id of ids)await downloadStore.invalidateOwner(id);
}
