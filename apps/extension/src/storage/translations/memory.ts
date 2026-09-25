import type {CacheToken} from '../cache';
interface MemoryResult {blob:Blob;token?:CacheToken}
const memory=new Map<string,MemoryResult>();
const requests=new Map<string,{key:string;token:CacheToken;finish:(blob?:Blob)=>void}>();
let changes:BroadcastChannel|undefined;
const sameToken=(a:CacheToken|undefined,b:CacheToken|undefined)=>!!a&&!!b&&a.epoch===b.epoch&&a.owner===b.owner&&a.ownerGeneration===b.ownerGeneration;
function channel(){
  if(!changes&&typeof BroadcastChannel!=='undefined'&&typeof navigator!=='undefined'){
    changes=new BroadcastChannel('nc-translation-memory-v1');
    changes.onmessage=event=>{
      const value=event.data;
      if(value?.type==='read'&&typeof value.id==='string'&&typeof value.key==='string'){
        const result=memory.get(value.key);
        if(result&&sameToken(result.token,value.token)){
          try{changes?.postMessage({type:'result',id:value.id,key:value.key,token:result.token,blob:result.blob});}catch{/* A closing context cannot deliver; the requester has a bounded timeout. */}
        }
      }else if(value?.type==='result'){
        const request=requests.get(value.id);
        if(request&&request.key===value.key&&sameToken(request.token,value.token)&&value.blob instanceof Blob)request.finish(value.blob);
      }else if(value?.clear===true)memory.clear();
      else if(value?.type==='delete-owner'&&typeof value.owner==='string')forgetOwner(value.owner);
      else if(value?.type==='delete'&&typeof value.key==='string')memory.delete(value.key);
    };
  }
  return changes;
}
export function resultInMemory(key:string,token?:CacheToken){const value=memory.get(key);return !token||sameToken(value?.token,token)?value?.blob:undefined;}
export function retainResult(key:string,blob:Blob,token?:CacheToken){
  channel();memory.delete(key);memory.set(key,{blob,token});
  let size=[...memory.values()].reduce((sum,value)=>sum+value.blob.size,0);
  while(memory.size>1&&(memory.size>4||size>96*1024*1024)){
    const oldest=memory.keys().next().value!;size-=memory.get(oldest)!.blob.size;memory.delete(oldest);
  }
}
function forgetOwner(owner:string){for(const [key,value] of memory)if(value.token?.owner===owner)memory.delete(key);}
export function invalidateResultMemory(key?:string,owner?:string){
  if(key)memory.delete(key);else if(owner)forgetOwner(owner);else memory.clear();
  channel()?.postMessage(key?{type:'delete',key}:owner?{type:'delete-owner',owner}:{clear:true});
}
/** Bounded handoff between reader tabs/workers. No remote request or persistent byte copy. */
export async function readResultFromContexts(key:string,token:CacheToken|undefined):Promise<Blob|undefined>{
  const bus=channel();if(!bus||!token)return;
  return new Promise(resolve=>{
    const id=crypto.randomUUID(),timer=setTimeout(()=>finish(),350);
    const finish=(blob?:Blob)=>{clearTimeout(timer);requests.delete(id);resolve(blob);};
    requests.set(id,{key,token,finish});try{bus.postMessage({type:'read',id,key,token});}catch{finish();}
  });
}
