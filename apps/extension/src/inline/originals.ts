import {sourcePageCache} from '../storage/source-pages';
import {SourceDatabaseSchemaError} from '../storage/database';

function cacheUnavailable(error:unknown):undefined{if(error instanceof SourceDatabaseSchemaError)throw error;return undefined;}

/** Per-activation upload bytes. Persistent cache refusal never loses an accepted page's only copy. */
export class InlineOriginals {
  private memory=new Map<string,Blob>();
  private restorers=new Map<string,()=>Promise<Blob>>();
  private pending=new Map<string,Promise<Blob|undefined>>();
  private generation=0;
  constructor(private readonly owner:string,private readonly maxBytes=128*1024*1024){}
  private retain(key:string,blob:Blob){
    this.memory.delete(key);if(blob.size<=this.maxBytes)this.memory.set(key,blob);
    let size=[...this.memory.values()].reduce((sum,value)=>sum+value.size,0);
    while(this.memory.size>4||size>this.maxBytes){const oldest=this.memory.keys().next().value!;size-=this.memory.get(oldest)!.size;this.memory.delete(oldest);}
  }
  async remember(key:string,blob:Blob,restore:()=>Promise<Blob>){
    const generation=this.generation;this.retain(key,blob);this.restorers.delete(key);this.restorers.set(key,restore);
    while(this.restorers.size>200)this.restorers.delete(this.restorers.keys().next().value!);
    const token=await sourcePageCache.token(this.owner).catch(cacheUnavailable);
    if(token&&generation===this.generation)await sourcePageCache.put(key,blob,{owner:this.owner,token}).catch(cacheUnavailable);
  }
  async read(key:string):Promise<Blob|undefined>{
    const memory=this.memory.get(key);if(memory)return memory;
    const existing=this.pending.get(key);if(existing)return existing;
    const generation=this.generation;
    const pending=(async()=>{
      const cached=await sourcePageCache.get(key).catch(cacheUnavailable);
      if(generation!==this.generation)return;
      const blob=cached??await this.restorers.get(key)?.();
      if(generation!==this.generation)return;
      if(blob)this.retain(key,blob);return blob;
    })();
    this.pending.set(key,pending);
    try{return await pending;}finally{if(this.pending.get(key)===pending)this.pending.delete(key);}
  }
  async uploaded(key:string){this.memory.delete(key);await sourcePageCache.delete(key).catch(cacheUnavailable);}
  forget(key:string){this.memory.delete(key);this.restorers.delete(key);}
  clear(){this.generation++;this.memory.clear();this.restorers.clear();this.pending.clear();}
}
