import {RequestPool} from '../concurrency';
import {msg} from '../i18n/runtime';
import {receiveImage,INLINE_RESULT_PORT} from '../inline/blob-transfer';
import type {InlineImage,InlineResponse,InlineResult} from '../inline/protocol';
import {ReadingWindow} from '../reading-window';
import type {SessionReaderWindow} from '../reader/session-model';
let generationSequence=0;

/** A view client of the existing inline protocol; admission, receipts and jobs remain in its background runtime. */
export class ImmersiveTranslation {
  readonly results=new Map<string,InlineResult>();
  private generation=++generationSequence;private active=false;private disposed=false;
  private window=new ReadingWindow<InlineImage>(image=>image.id);
  private timer?:ReturnType<typeof setTimeout>;private busy?:number;private watching=false;
  private pending=false;private backoff=0;private failures=0;private retryId?:string;
  private latest?:Pick<InlineResponse,'contextId'|'revision'|'scope'>;
  private requiresInternet=true;private loads=new RequestPool(2);
  constructor(readonly navigationId:string,private changed:()=>void){}
  private send(type:string,extra:Record<string,unknown>={}){
    return chrome.runtime.sendMessage({type,navigationId:this.navigationId,generation:this.generation,...extra});
  }
  update(view:SessionReaderWindow,images:InlineImage[]){
    const active=view.view==='translation'&&!document.hidden&&images.length>0;
    const changed=this.window.update(active?images:[],performance.now(),view.immediate);
    if(this.active!==active||changed){
      this.active=active;this.generation=++generationSequence;
      void this.send('NC_INLINE_INVALIDATE',{keepIds:active?images.map(image=>image.id):[]}).catch(()=>{});
      if(active)this.schedule();else clearTimeout(this.timer);
    }
  }
  openAccount(){void this.send('NC_INLINE_OPEN',{view:'account'}).catch(()=>{});}
  retry(id:string){this.retryId=id;this.backoff=0;this.generation=++generationSequence;this.results.delete(id);this.changed();this.schedule();}
  reset(){this.generation=++generationSequence;this.results.clear();this.latest=undefined;this.backoff=0;this.changed();this.schedule();}
  accept(data:InlineResponse,generation:number){
    if(this.disposed||!this.active||generation!==this.generation)return;
    if(this.latest?.contextId===data.contextId&&data.revision<=this.latest.revision)return;
    if(this.latest&&this.latest.scope!==data.scope)this.results.clear();
    this.latest={contextId:data.contextId,revision:data.revision,scope:data.scope};
    for(const item of data.items)this.results.set(item.id,item);
    this.pending=!!data.hasPending;this.requiresInternet=data.requiresInternet!==false;
    if(data.retryAfterMs)this.backoff=Math.max(this.backoff,performance.now()+data.retryAfterMs);
    this.changed();
    if(data.needsSubmit||data.retryAfterMs)this.schedule(Math.max(100,this.backoff-performance.now()));
    void this.watch();
  }
  onMessage(message:{type?:string;navigationId?:string;generation?:number;data?:InlineResponse}){
    if(message.type==='NC_INLINE_UPDATE'&&message.navigationId===this.navigationId&&message.data)this.accept(message.data,message.generation!);
    else if(message.type==='NC_INLINE_CONFIG_CHANGED')this.reset();
  }
  async read(image:InlineImage,signal:AbortSignal){
    const result=this.results.get(image.id),scope=this.latest?.scope;
    if(!result?.resultKey)return;
    return this.loads.run(async()=>{
      signal.throwIfAborted();
      return receiveImage(chrome.runtime.connect({name:INLINE_RESULT_PORT}),{type:'NC_INLINE_IMAGE',navigationId:this.navigationId,generation:this.generation,
        images:[image],resultKey:result.resultKey},signal,()=>!this.disposed&&this.latest?.scope===scope&&this.results.get(image.id)?.resultKey===result.resultKey);
    });
  }
  private schedule(delay=0){
    clearTimeout(this.timer);if(this.active&&!this.disposed)this.timer=setTimeout(()=>void this.tick(),Math.max(delay,this.window.delay()));
  }
  private async tick(){
    if(!this.active||this.disposed||document.hidden||this.busy===this.generation)return;
    const images=this.window.ready();if(!images.length){this.schedule();return;}
    const generation=this.generation;this.busy=generation;
    const retryId=this.retryId;this.retryId=undefined;
    try{
      const response=await this.send('NC_INLINE_TICK',{images,readingImages:this.window.targets,retryId,
        deferRemote:performance.now()<this.backoff?'backoff':navigator.onLine===false?'offline':undefined});
      if(generation!==this.generation||this.disposed)return;
      if(!response?.ok)throw Error(response?.error??msg('翻译服务暂不可用'));
      this.failures=0;this.accept(response.data,generation);
      if(images.length<this.window.targets.length)this.schedule();
    }catch(error){
      if(generation!==this.generation||this.disposed)return;
      for(const image of images)if(!this.results.get(image.id)?.resultKey)this.results.set(image.id,{id:image.id,state:{kind:'error',message:(error as Error).message}});
      this.backoff=performance.now()+Math.min(30000,1000*2**this.failures++);this.changed();this.schedule(this.backoff-performance.now());
    }finally{if(this.busy===generation)this.busy=undefined;if(generation!==this.generation)this.schedule();}
  }
  private async watch(){
    if(this.watching||!this.pending||!this.active||this.disposed||document.hidden||this.requiresInternet&&navigator.onLine===false)return;
    this.watching=true;let retry=false;
    try{
      while(this.pending&&this.active&&!this.disposed&&!document.hidden&&(!this.requiresInternet||navigator.onLine!==false)){
        const generation=this.generation;
        const response=await this.send('NC_INLINE_WAIT',{images:this.window.targets});
        if(generation!==this.generation)continue;
        if(!response?.ok){retry=true;break;}
        this.accept(response.data,generation);
      }
    }catch{retry=true;}finally{
      this.watching=false;
      if(retry)this.schedule(Math.min(30000,1000*2**this.failures++));
    }
  }
  dispose(){
    this.disposed=true;this.active=false;this.generation=++generationSequence;clearTimeout(this.timer);
    void this.send('NC_INLINE_INVALIDATE',{keepIds:[]}).catch(()=>{});this.results.clear();
  }
}
