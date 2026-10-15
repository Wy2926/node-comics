import {RequestPool} from '../concurrency';
import {IMAGE_MEMORY_BYTES,DECODED_PAGE_WINDOW} from '../image-resources';
import {currentInlineActivation} from '../inline/activation';
import {receiveImage} from '../inline/blob-transfer';
import {readInlineSourceImage,readResolvedSourceImage} from '../sources/runtime/source-image';
import {IMMERSIVE_SOURCE_PORT,immersiveSessionKey,type ImmersiveImage,type ImmersiveSession} from './protocol';

interface Pending {controller:AbortController;promise:Promise<Blob>;users:number;done:boolean;blob?:Blob;}
interface Cache {id:string;pool:RequestPool;items:Map<string,Pending>;}
const caches=new Map<number,Cache>();
/** Synchronous transfer guard; release/rebind invalidates even an already-loaded Blob. */
export function isImmersiveSessionCurrent(tabId:number,sessionId:string){return caches.get(tabId)?.id===sessionId;}
export function clearImmersiveSources(tabId:number){
  const cache=caches.get(tabId);if(!cache)return;
  caches.delete(tabId);
  for(const item of cache.items.values())item.controller.abort();
}
function trim(cache:Cache){
  let bytes=[...cache.items.values()].reduce((sum,item)=>sum+(item.blob?.size??0),0);
  for(const [key,item] of cache.items){
    if(cache.items.size<=DECODED_PAGE_WINDOW&&bytes<=IMAGE_MEMORY_BYTES)break;
    if(!item.done||item.users)continue;
    bytes-=item.blob?.size??0;cache.items.delete(key);
  }
}
export async function currentImmersiveSession(sender:chrome.runtime.MessageSender,navigationId:unknown){
  const current=await currentInlineActivation(sender,navigationId);
  if(!current?.activation.immersive)throw Error('SOURCE_SESSION_EXPIRED');
  const saved=await chrome.storage.session.get(immersiveSessionKey(sender.tab!.id!));
  const session=saved[immersiveSessionKey(sender.tab!.id!)] as ImmersiveSession|undefined;
  if(!session||session.navigationId!==navigationId||session.url!==current.tab.url)throw Error('SOURCE_SESSION_EXPIRED');
  return session;
}
/** Translation receives registered slots, never arbitrary caller-provided URLs or decoding recipes. */
export function validImmersiveImages(session:ImmersiveSession,images:unknown,limit:number):images is ImmersiveImage[]{
  return Array.isArray(images)&&images.length<=limit&&new Set(images.map(image=>image?.id)).size===images.length&&images.every(image=>
    image&&typeof image.id==='string'&&image.url==='page-image:'+image.id&&
    Number.isFinite(image.width)&&Number.isFinite(image.height)&&image.width>0&&image.height>0&&
    session.images.some(registered=>registered.id===image.id));
}
/** View and translator share bounded original reads, but either consumer can cancel independently. */
export async function readImmersiveOriginal(sender:chrome.runtime.MessageSender,navigationId:string,id:string,signal:AbortSignal){
  signal.throwIfAborted();
  const session=await currentImmersiveSession(sender,navigationId),tabId=sender.tab!.id!;
  signal.throwIfAborted();
  const index=session.images.findIndex(image=>image.id===id),image=session.images[index];
  if(!image)throw Error('SOURCE_RESOURCE_EXPIRED');
  let cache=caches.get(tabId);
  if(cache?.id!==session.id){clearImmersiveSources(tabId);cache={id:session.id,pool:new RequestPool(3),items:new Map()};caches.set(tabId,cache);}
  const owner=cache;
  let pending=owner.items.get(id);
  if(pending?.controller.signal.aborted){owner.items.delete(id);pending=undefined;}
  if(!pending){
    const controller=new AbortController();
    const work:Pending={controller,promise:Promise.resolve(new Blob()),users:0,done:false};
    work.promise=owner.pool.run(async()=>{
      controller.signal.throwIfAborted();
      const page=session.manifest?.items[index];
      let blob:Blob;
      if(image.url==='page-image:'+id){
        const port=chrome.tabs.connect(tabId,{name:IMMERSIVE_SOURCE_PORT,frameId:0,...(sender.documentId?{documentId:sender.documentId}:{})});
        blob=await receiveImage(port,{navigationId,id},controller.signal,()=>caches.get(tabId)===owner);
      }else if(page){
        blob=await readResolvedSourceImage({url:page.url,pageUrl:session.manifest!.url,sourceId:session.manifest!.adapter,processing:page.processing},controller.signal);
      }else blob=await readInlineSourceImage(image.url,session.url,controller.signal,image.referrerPolicy);
      controller.signal.throwIfAborted();
      const current=await currentImmersiveSession(sender,navigationId).catch(error=>{
        if(caches.get(tabId)===owner)clearImmersiveSources(tabId);
        throw error;
      });
      controller.signal.throwIfAborted();
      if(caches.get(tabId)!==owner||current.id!==session.id){
        if(caches.get(tabId)===owner)clearImmersiveSources(tabId);
        throw Error('SOURCE_SESSION_EXPIRED');
      }
      work.blob=blob;return blob;
    }).finally(()=>{
      work.done=true;
      if(!work.blob&&owner.items.get(id)===work)owner.items.delete(id);
      trim(owner);
    });
    owner.items.set(id,work);pending=work;
  }
  const work=pending;work.users++;
  let abort=()=>{};
  try{
    signal.throwIfAborted();
    const blob=await Promise.race([work.promise,new Promise<never>((_,reject)=>{
      abort=()=>reject(signal.reason??new DOMException('Aborted','AbortError'));
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
    })]);
    signal.throwIfAborted();
    if(caches.get(tabId)!==owner)throw Error('SOURCE_SESSION_EXPIRED');
    return blob;
  }finally{
    signal.removeEventListener('abort',abort);work.users--;
    if(!work.done&&!work.users){work.controller.abort();if(owner.items.get(id)===work)owner.items.delete(id);}
    // Promise completion precedes consumer release, so its trim cannot evict the last active Blob.
    trim(owner);
  }
}
