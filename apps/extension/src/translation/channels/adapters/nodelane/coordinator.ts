import type {PageReference} from '../../../../comics/pages/identity';
import {hashFile} from '../../../../importers/hash';
import {registerOriginal} from '../../../../comics/originals';
import {msg} from '../../../../i18n/runtime';
import {Api,ApiError} from '../../../../api';
import {assertCurrent,RequestPool,UPLOAD_CONCURRENCY} from '../../../../concurrency';
import {mergeJobs} from '../../../../reader/jobs';
import {pageTranslation} from '../../../../reader/presentation';
import type {Entitlements,Job,TranslationSnapshot} from '../../../../types';
import type {ReadingTarget} from '../../../automatic';
import {makeOperation,operationId,quotaErrors} from './operations';
import {readOperation,readOperations,readSync,saveOperation,saveSync,translationScope,withTranslationLock,type LocalOperation,type SyncState} from './store';

interface Options {api:Api;userId:string;language:string;getBlob:(key:string)=>Promise<Blob|undefined>;readOriginal?:(ref:PageReference)=>Promise<{blob:Blob;release:()=>void}>;onInputConsumed?:(blobKey:string)=>Promise<void>;rights:()=>Entitlements|undefined;onJobs:(jobs:Job[])=>Promise<void>;onChange:()=>void;}
const active=(r:LocalOperation)=>r.state==='uncertain'||r.state==='accepted'&&!!r.result&&['needs_input','queued','running','needs_attention'].includes(r.result.state);
/** The reader keeps its display model; server resources are always public translation UUIDs. */
export function translationJob(snapshot:TranslationSnapshot,record?:LocalOperation):Job{
  const unavailable=snapshot.error?.code==='TRANSLATION_UNAVAILABLE';
  const result=snapshot.state==='succeeded'&&snapshot.result?.asset_id&&!unavailable?{key:snapshot.result.asset_id,recoverable:true}:undefined;
  return {id:snapshot.id,input_asset_id:snapshot.input_asset_id??null,output_asset_id:snapshot.result?.asset_id??null,result,mode:snapshot.mode,target_language:snapshot.target_language,status:snapshot.state==='needs_input'?'awaiting_upload':snapshot.state==='needs_attention'?'outcome_unknown':snapshot.state==='succeeded'&&snapshot.result?.kind==='no_text'?'no_text':snapshot.state,phase:snapshot.state,created_at:snapshot.created_at??new Date(record?.createdAt??Date.now()).toISOString(),updated_at:snapshot.updated_at,version:1,quota_pages:0,cache_hit:false,error:snapshot.error??undefined,image_sha256:snapshot.image_sha256??record?.image.sha256,quality_flags:snapshot.result?.quality_flags,result_available:!!snapshot.result&&!unavailable,result_expired:unavailable};
}
/** Current plus three pages is local scheduling, never a server reading session. */
export class TranslationCoordinator {
  readonly scope:string;state:SyncState;records:LocalOperation[]=[];
  private initializing?:Promise<void>;private uploads=new Map<string,Promise<void>>();private uploadPool=new RequestPool(UPLOAD_CONCURRENCY);
  private wanted=new Set<string>();private refreshed=new Set<string>();private etag?:string;private waitKey='';
  private monotonic=new Map<string,{wall:number;until:number}>();private imageLimit?:number;
  constructor(readonly options:Options){this.scope=translationScope(new URL(options.api.base).origin,options.userId);this.state={id:this.scope,jobs:[]};this.imageLimit=options.rights()?.image_rate_limit.limit;}
  async init(){return this.initializing??=(async()=>{this.state=await readSync(this.scope)??this.state;this.records=await readOperations(this.scope);await this.options.onJobs(this.state.jobs);})();}
  private current(){assertCurrent(this.options.api.isCurrent);}
  private async persistState(patch:Partial<SyncState>){await withTranslationLock('sync:'+this.scope,async()=>{this.current();this.state={...await readSync(this.scope)??this.state,...patch};await saveSync(this.state);});}
  private delay(key:string,wall:number){if(!wall)return 0;let value=this.monotonic.get(key);if(!value||value.wall!==wall){value={wall,until:performance.now()+Math.max(0,wall-Date.now())};this.monotonic.set(key,value);}return Math.max(0,value.until-performance.now());}
  private remaining(key:'imageRetryAt'|'controlRetryAt'){return this.delay(key,this.state[key]??0);}
  private recordDelay(record:LocalOperation){return this.delay('retry:'+record.requestId,record.retryAt??0);}
  get controlDelay(){return this.remaining('controlRetryAt');}
  get retryDelay(){
    const imageDelay=this.remaining('imageRetryAt');
    const waits=this.records.filter(r=>this.wanted.has(r.id)&&(['uncertain','local','deferred'].includes(r.state)||r.result?.state==='needs_input'))
      .map(r=>Math.max(this.recordDelay(r),r.state==='local'||r.state==='deferred'?imageDelay:0)).filter(n=>n>0);
    return Math.max(this.controlDelay,waits.length?Math.min(...waits):0);
  }
  get waitingIds(){return this.records.filter(r=>this.wanted.has(r.id)&&r.state==='accepted'&&active(r)&&this.recordDelay(r)<=0).map(r=>r.requestId).sort();}
  get hasPending(){return this.waitingIds.length>0;}
  private async save(record:LocalOperation){this.current();const saved=await readOperation(record.id);if(saved&&saved.requestId!==record.requestId)return;await saveOperation(record);this.records=this.records.filter(r=>r.id!==record.id).concat(record);this.options.onChange();}
  private async receive(record:LocalOperation,result:TranslationSnapshot){
    if(result.id!==record.requestId)throw new ApiError(msg('翻译回执与操作编号不符'),'INVALID_RECEIPT');
    const previous=record.result;record.result=result;record.state='accepted';record.error=result.error?.message;record.errorCode=result.error?.code;record.retryAt=undefined;
    await this.save(record);const job=translationJob(result,record);
    await withTranslationLock('sync:'+this.scope,async()=>{this.current();const saved=await readSync(this.scope)??this.state;this.state={...saved,jobs:mergeJobs(saved.jobs,[job])};await saveSync(this.state);});
    await this.options.onJobs([job]);
    if(result.input_asset_id)await registerOriginal(new URL(this.options.api.base).origin,this.options.userId,record.image.sha256,result.input_asset_id);
    if(result.state==='needs_input'&&this.wanted.has(record.id))this.upload(record);
    // Cache cleanup cannot turn a durable server receipt into an uncertain submission.
    if(record.blobKey&&result.state!=='needs_input')await this.options.onInputConsumed?.(record.blobKey).catch(()=>{});
    if(result.state==='failed'&&previous?.state!=='failed')await this.refreshEntitlements();
  }
  private upload(record:LocalOperation){
    if(this.uploads.has(record.requestId))return;
    const work=this.uploadPool.run(async()=>{try{
      this.current();const lease=record.pageRef?await this.options.readOriginal?.(record.pageRef):undefined;
      let blob:Blob|undefined;try{blob=lease?.blob??(record.blobKey?await this.options.getBlob(record.blobKey):undefined);}finally{lease?.release();}
      if(!blob)throw new ApiError(msg('本地原图尚未就绪，请重新采集。'),'LOCAL_IMAGE_MISSING');
      if(blob.size!==record.image.byte_size||await hashFile(blob)!==record.image.sha256)throw new ApiError('原图内容已变化，原翻译请求已停止。','SOURCE_CHANGED');
      await this.receive(record,await this.options.api.translationInput(record.requestId,blob));
    }catch(error){if(!this.options.api.isCurrent())return;record.error=(error as Error).message;record.errorCode=error instanceof ApiError?error.code:undefined;if(record.errorCode==='SOURCE_CHANGED'){record.state='blocked';record.retryAt=undefined;}else{record.state='uncertain';record.retryAt=Date.now()+15000;}await this.save(record);}finally{this.uploads.delete(record.requestId);this.options.onChange();}});
    this.uploads.set(record.requestId,work);
  }
  async finishUploads(){await Promise.all(this.uploads.values());}
  private async backpressure(error:unknown){if(error instanceof ApiError&&(error.status===429||error.status===503)){const key=error.code==='IMAGE_RATE_LIMITED'?'imageRetryAt':'controlRetryAt';await this.persistState({[key]:Date.now()+(error.retryAfterSeconds??2)*1000});}}
  private async snapshots(records:LocalOperation[],signal?:AbortSignal,wait=false){
    if(!records.length)return;
    const ids=records.map(r=>r.requestId).sort(),key=ids.join(',');if(key!==this.waitKey){this.waitKey=key;this.etag=undefined;}
    try{
      const response=await this.options.api.translations(ids,{signal,wait,etag:wait?this.etag:undefined});this.current();this.etag=response.etag;
      if(response.unchanged)return;
      for(const record of records){const snapshot=response.items.find(item=>item.id===record.requestId);if(snapshot){await this.receive(record,snapshot);this.refreshed.add(record.requestId);}else if(response.missing_ids.includes(record.requestId)){if(record.result){await this.receive(record,{id:record.requestId,state:'failed',mode:record.mode,target_language:record.language,error:{code:'TRANSLATION_UNAVAILABLE',message:msg('译图已失效')},updated_at:new Date().toISOString()});}else{record.state='local';record.retryAt=undefined;await this.save(record);}}}
    }catch(error){await this.backpressure(error);throw error;}
  }
  async wait(signal:AbortSignal){await this.init();const ids=new Set(this.waitingIds),records=this.records.filter(r=>ids.has(r.requestId)).slice(0,32);await this.snapshots(records,signal,true);return records.length>0;}
  async recover(){await this.init();this.state=await readSync(this.scope)??this.state;if(this.controlDelay)return;const records=(await readOperations(this.scope)).filter(r=>this.wanted.has(r.id)&&!this.uploads.has(r.requestId)&&(r.state==='uncertain'||r.result&&!this.refreshed.has(r.requestId))&&this.recordDelay(r)<=0);for(let n=0;n<records.length;n+=32)await this.snapshots(records.slice(n,n+32));}
  async submit(targets:ReadingTarget[],requestCurrent=()=>true){
    await this.init();const previous=[...this.wanted].join(',');this.wanted=new Set(targets.slice(0,4).map(t=>operationId(this.scope,this.options.language,t)));if(previous!==[...this.wanted].join(','))this.options.onChange();this.state=await readSync(this.scope)??this.state;
    for(const record of this.records)if(!this.wanted.has(record.id))this.refreshed.delete(record.requestId);
    if(this.controlDelay)return;
    await this.recover();
    for(const [index,target] of targets.slice(0,4).entries()){
      if(!requestCurrent()||this.controlDelay)break;
      const id=operationId(this.scope,this.options.language,target);
      try{await withTranslationLock(id,async()=>{
        let record=await readOperation(id);
        if(!record){record=await makeOperation(target,this.scope,this.options.language,this.options.getBlob);await saveOperation(record);this.records=this.records.concat(record);}
        this.state=await readSync(this.scope)??this.state;
        const promote=index===0&&record.priority==='prefetch'&&record.state==='accepted'&&['needs_input','queued','running'].includes(record.result?.state??'');
        // Image admission backpressure covers every new page in this scope, including a new window.
        // Accepted requests may still be promoted, recovered and supplied with their original bytes.
        if(record.state==='blocked'||record.state==='accepted'&&!promote||record.state==='uncertain'||this.recordDelay(record)>0||!promote&&this.remaining('imageRetryAt')>0)return;
        if(!requestCurrent())return;
        record.state='uncertain';await this.save(record);
        try{const priority=index===0?'current':'prefetch';const result=await this.options.api.translate(record.requestId,{...record.request,priority});record.priority=priority;this.refreshed.add(record.requestId);await this.receive(record,result);}
        catch(error){this.current();const e=error instanceof ApiError?error:new ApiError((error as Error).message);await this.backpressure(e);const definitive=e.status>=400&&e.status<500;record.state=e.status===429?'deferred':definitive?'blocked':'uncertain';record.error=e.message;record.errorCode=e.code;record.retryAt=record.state==='blocked'?undefined:Date.now()+(e.retryAfterSeconds??2)*1000;await this.save(record);}
      });}catch(error){if(!this.options.api.isCurrent())throw error;target.page.translationError=(error as Error).message;this.options.onChange();}
    }
  }
  async manual(target:ReadingTarget,requestCurrent=()=>true){
    await this.init();const id=operationId(this.scope,this.options.language,target);
    await withTranslationLock(id,async()=>{
      const previous=await readOperation(id),latest=pageTranslation(target.page,target.mode,this.options.language,this.scope);
      if(previous?.state==='uncertain'||previous&&active(previous)||latest.pending||latest.latest?.status==='unknown_released')throw Error(msg('原请求结果待核实，暂不能重复翻译。'));
      const source=previous?.result?.id??latest.latest?.id,state=previous?.result?.state??latest.latest?.status;
      if(previous?.state==='blocked'&&!previous.result){previous.state='local';previous.error=undefined;previous.retryAt=undefined;await saveOperation(previous);return;}
      const action=source?(state==='failed'||state==='cancelled'?{retry_of:source}:{regenerate_of:source}):undefined;
      const record=await makeOperation(target,this.scope,this.options.language,this.options.getBlob,action);await saveOperation(record);this.records=this.records.filter(r=>r.id!==id).concat(record);
    });await this.submit([target],requestCurrent);
  }
  async refreshEntitlements(rights?:Entitlements){
    const changedLimit=rights&&this.imageLimit!==undefined&&this.imageLimit!==rights.image_rate_limit.limit;
    if(rights)this.imageLimit=rights.image_rate_limit.limit;
    if(changedLimit)await this.persistState({imageRetryAt:undefined});
    for(const record of await readOperations(this.scope)){
      if(record.state==='blocked'&&quotaErrors.has(record.errorCode??'')&&!record.result||changedLimit&&record.state==='deferred'&&record.errorCode==='IMAGE_RATE_LIMITED'){
        record.state='local';record.error=undefined;record.retryAt=undefined;await this.save(record);
      }
    }
  }
}
