import {MAX_READING_TARGETS} from '../reading-window';
import {abortable} from '../concurrency';
import {readMaterializedResult} from '../storage/translations/results';

/** Warm complete result bytes without mounting images or retaining a second cache. */
export class TranslationResultPrefetch {
  private keys:string[]=[];
  private attempted=new Set<string>();
  private pending?:{key:string;controller:AbortController};

  constructor(private readonly read=readMaterializedResult){}

  update(keys:readonly string[]){
    this.keys=[...new Set(keys)].slice(0,MAX_READING_TARGETS);
    for(const key of this.attempted)if(!this.keys.includes(key))this.attempted.delete(key);
    if(this.pending&&!this.keys.includes(this.pending.key))this.pending.controller.abort();
    this.start();
  }

  private start(){
    if(this.pending)return;
    const key=this.keys.find(key=>!this.attempted.has(key));if(!key)return;
    this.attempted.add(key);
    const pending={key,controller:new AbortController()};this.pending=pending;
    void this.load(pending);
  }

  private async load(pending:NonNullable<TranslationResultPrefetch['pending']>){
    try{await abortable(this.read(pending.key,pending.controller.signal),pending.controller.signal);}
    catch{/* Speculative failures do not change successful jobs; display can retry the same result. */}
    finally{this.pending=undefined;this.start();}
  }

  dispose(){this.update([]);}
}
