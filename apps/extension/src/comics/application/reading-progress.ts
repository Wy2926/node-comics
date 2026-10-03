import type {ReadingEntry} from '../../types';
import type {SourceReadingProgress,ProgressCapability} from '../sources/contracts';
import {getSourceDriver} from '../sources/registry';
import {epubLocation} from '../formats/epub-location';
import {entrySource} from './entry-source';

type Binding=Awaited<ReturnType<typeof entrySource>>;
export type ReadingProgressStatus='local'|'pending'|'syncing'|'synced';
type Session={binding:Binding;capability:ProgressCapability;controller:AbortController;observed:number;sent:string;confirmed:boolean;pending?:{value:SourceReadingProgress;key:string};timer?:ReturnType<typeof setTimeout>;running?:Promise<void>};
function key(value:SourceReadingProgress):string {
  const location=value.documentLocation;
  // A precise anchor survives layout and server-derived percentage normalization.
  if(location?.cfi)return JSON.stringify(['epub-cfi',location.href,location.cfi]);
  if(location)return JSON.stringify(['epub-resource',location.href,location.progression]);
  return JSON.stringify(['page',value.pageIndex]);
}
function position(copy:ReadingEntry):SourceReadingProgress|undefined {
  if(copy.document){const location=epubLocation(copy.document,copy.documentLocation);return location?{documentLocation:location,updatedAt:copy.lastReadAt}:undefined;}
  const pageIndex=copy.pages.findIndex(page=>page.id===copy.pageId);
  return pageIndex<0?undefined:{pageIndex,updatedAt:copy.lastReadAt};
}

/** One visible reader, one latest pending location. Fetching images never enters this path. */
export class ReadingProgress {
  private active?:Session;
  private opening?:AbortController;
  private epoch=0;
  private closing:Promise<void>=Promise.resolve();
  constructor(private readonly onError:(error:unknown)=>void=()=>{},private readonly onStatus:(status:ReadingProgressStatus)=>void=()=>{}){}

  async open(copy:ReadingEntry,signal?:AbortSignal):Promise<ReadingEntry> {
    const closing=this.close(),epoch=this.epoch;
    const controller=new AbortController();
    this.opening=controller;
    const readSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const assertOpen=()=>{readSignal.throwIfAborted();if(epoch!==this.epoch)throw new DOMException('Reader changed','AbortError');};
    try{
      await closing;assertOpen();
      const binding=await entrySource(copy.id,copy.contentId,controller.signal);
      const capability=getSourceDriver(binding.connection.provider)?.progress;
      assertOpen();
      if(!capability){controller.abort();return copy;}
      this.onStatus('syncing');
      let restored=copy,remote:SourceReadingProgress|undefined|null,readFailed=false;
      try{remote=await capability.read({...binding.context,signal:readSignal});}
      catch(error){assertOpen();readFailed=true;this.onError(error);}
      // Revocation is not an offline resume. Never activate a stale source binding.
      await binding.assertCurrent();assertOpen();
      const hasLocalPosition=Number.isFinite(copy.lastReadAt)&&!!position(copy);
      // Network availability does not make a remote location newer than offline reading.
      // Missing/equal timestamps never replace an existing local anchor, for either format.
      if(remote&&(!hasLocalPosition||
        Number.isFinite(remote.updatedAt)&&remote.updatedAt!>copy.lastReadAt!)){
        const lastReadAt=Number.isFinite(remote.updatedAt)?remote.updatedAt:0;
        if(copy.document){const location=epubLocation(copy.document,remote.documentLocation);if(location)restored={...copy,documentLocation:location,lastReadAt};}
        else if(Number.isSafeInteger(remote.pageIndex)&&remote.pageIndex!>=0&&remote.pageIndex!<copy.pages.length)
          restored={...copy,pageId:copy.pages[remote.pageIndex!].id,relativeOffset:0,lastReadAt};
      }
      if(remote===null||remote?.snapshot){controller.abort();this.onStatus('local');return restored;}
      const initial=position(restored);
      const confirmed=!!remote&&!!initial&&key(remote)===key(initial);
      this.active={binding,capability,controller,observed:restored.lastReadAt??0,sent:initial?key(initial):'',confirmed};
      this.onStatus(readFailed?'pending':confirmed?'synced':'local');
      // A known older remote location can be updated with already-persisted local reading.
      // Never push on an unsuccessful read or when the server supplied no comparable date.
      if(remote&&hasLocalPosition&&Number.isFinite(remote.updatedAt)&&copy.lastReadAt!>remote.updatedAt!&&initial&&key(initial)!==key(remote)){
        this.active.sent=key(remote);
        this.active.pending={value:initial,key:key(initial)};
        this.onStatus('pending');
        const session=this.active;
        session.timer=setTimeout(()=>void this.send(session),500);
      }
      return restored;
    }catch(error){controller.abort();throw error;}
    finally{if(this.opening===controller)this.opening=undefined;}
  }

  update(copy:ReadingEntry):void {
    const session=this.active;
    if(!session||copy.id!==session.binding.entry.id||copy.contentId!==session.binding.entry.contentId||!copy.lastReadAt||copy.lastReadAt<=session.observed)return;
    session.observed=copy.lastReadAt;
    const value=position(copy);if(!value)return;
    const signature=key(value);
    // Returning to the sent location must also supersede an earlier queued page.
    session.pending=signature===session.sent&&!session.running?undefined:{value,key:signature};
    clearTimeout(session.timer);
    if(session.pending){this.onStatus('pending');session.timer=setTimeout(()=>void this.send(session),500);}
    else this.onStatus(session.confirmed?'synced':'local');
  }

  private send(session:Session):Promise<void> {
    clearTimeout(session.timer);
    if(session.running)return session.running;
    const running=(async()=>{
      while(session.pending&&!session.controller.signal.aborted){
        const pending=session.pending;session.pending=undefined;
        if(pending.key===session.sent)continue;
        try{
          await session.binding.assertCurrent();
          if(this.active===session)this.onStatus('syncing');
          // An unacknowledged write may have reached the source; the old position is no longer known.
          session.sent='';session.confirmed=false;
          await session.capability.write(session.binding.context,pending.value);
          await session.binding.assertCurrent();session.sent=pending.key;session.confirmed=true;
          if(this.active===session)this.onStatus('synced');
        }catch(error){if(!session.controller.signal.aborted){this.onError(error);if(this.active===session)this.onStatus('pending');}}
      }
    })();
    session.running=running.finally(()=>{session.running=undefined;});
    return session.running;
  }

  flush():Promise<void> {return this.active?this.send(this.active):this.closing;}
  close():Promise<void> {
    this.epoch++;this.opening?.abort();this.opening=undefined;
    const session=this.active;this.active=undefined;
    this.onStatus('local');
    if(session)this.closing=Promise.all([this.closing,this.send(session)]).then(()=>{session.controller.abort();});
    return this.closing;
  }
}
