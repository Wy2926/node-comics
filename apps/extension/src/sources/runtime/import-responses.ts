import type {SourceLocation} from '../contracts/definition';

export interface ImportResponse {url:string; referer?:string; body:string}
interface Handoff {sourceId:string; pageKey:string; catalogKey:string; expiresAt:number; responses:ImportResponse[]}
export const importResponseLimits={bytes:2*1024*1024,count:8} as const;
const key='nc-import-responses', lifetime=30_000, budget=4*1024*1024;
const size=(value:Handoff)=>JSON.stringify(value).length*2;
const samePage=(value:Handoff,location:SourceLocation)=>value.sourceId===location.sourceId&&value.pageKey===location.pageKey;
function discard(values:Handoff[],location:SourceLocation){
  for(let i=values.length-1;i>=0;i--)if(samePage(values[i],location))values.splice(i,1);
}
const available=()=>typeof chrome!=='undefined'&&!!chrome.storage?.session?.get&&!!chrome.storage.session.set&&!!chrome.storage.session.remove&&typeof navigator!=='undefined'&&!!navigator.locks;
async function update<T>(run:(values:Handoff[])=>T,signal?:AbortSignal){
  // This optimization must not turn unavailable session storage into an import failure.
  try{return await navigator.locks.request(key,async()=>{
    const record=await chrome.storage.session.get(key), values=(Array.isArray(record[key])?record[key]:[]) as Handoff[];
    signal?.throwIfAborted();
    // Expired responses cannot be reused; stored bodies are removed on the next operation.
    const live=values.filter(value=>value.expiresAt>Date.now());
    const result=run(live);
    if(live.length)await chrome.storage.session.set({[key]:live});else await chrome.storage.session.remove(key);
    return result;
  });}catch{signal?.throwIfAborted();return undefined;}
}
/** A bounded, one-use handoff between the import worker and reader, never an HTTP/catalog cache. */
export async function rememberImportResponses(location:SourceLocation,catalogKey:string,responses:ImportResponse[],signal?:AbortSignal){
  if(!available()||!responses.length)return;
  const value:Handoff={sourceId:location.sourceId,pageKey:location.pageKey,catalogKey,expiresAt:Date.now()+lifetime,responses};
  if(responses.length>importResponseLimits.count||size(value)>importResponseLimits.bytes)return;
  await update(values=>{
    discard(values,location);
    values.push(value);
    while(values.length>4||values.reduce((total,item)=>total+size(item),0)>budget)values.shift();
  },signal);
}
export async function forgetImportResponses(location:SourceLocation){
  if(!available())return;
  await update(values=>discard(values,location));
}
export async function takeImportResponses(location:SourceLocation,signal?:AbortSignal):Promise<ImportResponse[]>{
  if(!available()||!location.catalog||!chrome.permissions?.contains)return [];
  const value=await update(values=>{
    const index=values.findIndex(value=>samePage(value,location)&&value.catalogKey===location.catalog!.key);
    return index<0?undefined:values.splice(index,1)[0];
  },signal);
  if(!value)return [];
  // Permission revocation must invalidate the handoff just as it invalidates a fresh request.
  const origins=[...new Set([location.url,...value.responses.map(response=>response.url)].map(url=>new URL(url).origin+'/*'))];
  const granted=await chrome.permissions.contains({origins}).catch(()=>false);
  signal?.throwIfAborted();
  return granted?value.responses:[];
}
