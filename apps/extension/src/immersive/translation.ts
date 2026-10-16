import {RequestPool} from '../concurrency';
import {msg} from '../i18n/runtime';
import {receiveImage,INLINE_RESULT_PORT} from '../inline/blob-transfer';
import type {InlineImage,InlineResponse,InlineResult} from '../inline/protocol';
import {InlineBackoff} from '../inline/backoff';
import {ReadingWindow} from '../reading-window';
import type {SessionReaderWindow} from '../reader/session-model';
let generationSequence=0;

/** A view client of the existing inline protocol; admission, receipts and jobs remain in its background runtime. */
export class ImmersiveTranslation {
  readonly results=new Map<string,InlineResult>();
  private generation=++generationSequence;private active=false;private disposed=false;
  private window=new ReadingWindow<InlineImage>(image=>image.id);
  private timer?:ReturnType<typeof setTimeout>;private waitTimer?:ReturnType<typeof setTimeout>;private busy?:number;private watching=false;
  private pending=false;private backoff=new InlineBackoff();private waitBackoff=new InlineBackoff();private retryId?:string;
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
      clearTimeout(this.waitTimer);this.waitTimer=undefined;
      void this.send('NC_INLINE_INVALIDATE',{keepIds:active?images.map(image=>image.id):[]}).catch(()=>{});
      if(active)this.schedule();else clearTimeout(this.timer);
    }
  }
  openAccount(){void this.send('NC_INLINE_OPEN',{view:'account'}).catch(()=>{});}
  retry(id:string){this.retryId=id;this.backoff.reset();this.generation=++generationSequence;this.results.delete(id);this.changed();this.schedule();}
  reset(){this.generation=++generationSequence;this.results.clear();this.latest=undefined;this.pending=false;
    this.backoff.reset();this.waitBackoff.reset();clearTimeout(this.waitTimer);this.waitTimer=undefined;this.changed();this.schedule();}
  accept(data:InlineResponse,generation:number){
    if(this.disposed||!this.active||generation!==this.generation)return;
    if(this.latest?.contextId===data.contextId&&data.revision<=this.latest.revision)return;
    if(this.latest&&this.latest.scope!==data.scope)this.results.clear();
    this.latest={contextId:data.contextId,revision:data.revision,scope:data.scope};
    for(const item of data.items)this.results.set(item.id,item);
    this.pending=!!data.hasPending;this.requiresInternet=data.requiresInternet!==false;
    if(data.retryAfterMs)this.backoff.postpone(data.retryAfterMs);
    this.changed();
    if(data.needsSubmit||data.retryAfterMs)this.schedule(Math.max(100,this.backoff.delay));
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
      const deferRemote=this.backoff.reason;
      const response=await this.send('NC_INLINE_TICK',{images,readingImages:this.window.targets,retryId,
        deferRemote});
      if(generation!==this.generation||this.disposed)return;
      if(!response?.ok){this.backoff.fail(response?.retryAfterMs);throw Error(response?.error??msg('翻译服务暂不可用'));}
      this.accept(response.data,generation);
      this.backoff.afterTick(delay=>this.schedule(delay),deferRemote,response.data.requiresInternet);
      if(images.length<this.window.targets.length)this.schedule();
    }catch(error){
      if(generation!==this.generation||this.disposed)return;
      for(const image of images)if(!this.results.get(image.id)?.resultKey)this.results.set(image.id,{id:image.id,state:{kind:'error',message:(error as Error).message}});
      this.changed();this.schedule(this.backoff.fail());
    }finally{if(this.busy===generation)this.busy=undefined;if(generation!==this.generation)this.schedule();}
  }
  private async watch(){
    clearTimeout(this.waitTimer);this.waitTimer=undefined;
    if(this.watching||!this.pending||!this.active||this.disposed||document.hidden||this.requiresInternet&&navigator.onLine===false)return;
    // Subscription failures do not delay new-image preparation, and admission limits do not stop accepted tasks.
    const delay=this.waitBackoff.delay;
    if(delay){this.waitTimer=setTimeout(()=>void this.watch(),delay);return;}
    this.watching=true;
    try{
      while(this.pending&&this.active&&!this.disposed&&!document.hidden&&(!this.requiresInternet||navigator.onLine!==false)){
        const generation=this.generation;
        try{
          const response=await this.send('NC_INLINE_WAIT',{images:this.window.targets});
          if(generation!==this.generation)continue;
          if(!response?.ok){this.waitBackoff.fail(response?.retryAfterMs);break;}
          this.waitBackoff.succeeded();this.accept(response.data,generation);
        }catch{
          if(generation!==this.generation)continue;
          this.waitBackoff.fail();break;
        }
      }
    }finally{
      this.watching=false;void this.watch();
    }
  }
  dispose(){
    this.disposed=true;this.active=false;this.generation=++generationSequence;clearTimeout(this.timer);clearTimeout(this.waitTimer);this.waitTimer=undefined;
    void this.send('NC_INLINE_INVALIDATE',{keepIds:[]}).catch(()=>{});this.results.clear();
  }
}
