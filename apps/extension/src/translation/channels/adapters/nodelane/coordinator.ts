import type {PageReference} from '../../../../comics/pages/identity';
import {hashFile,Sha256} from '../../../../importers/hash';
import {msg} from '../../../../i18n/runtime';
import {Api,ApiError} from '../../../../api';
import {assertCurrent,RequestPool,UPLOAD_CONCURRENCY} from '../../../../concurrency';
import {pageTranslation} from '../../../../reader/presentation';
import type {Capabilities,Entitlements,Job,TranslationSnapshot,TranslationBatch} from '../../../../types';
import {MAX_READING_TARGETS,type ReadingTarget} from '../../../automatic';
import {makeOperation,operationId,quotaErrors} from './operations';
import {readOperation,readOperations,readPageOperations,readJobs,readSync,saveOperation,updateOperation,saveReceipt,saveSync,translationScope,withTranslationLock,type LocalOperation,type SyncState} from './store';
import {LegacyRequestGuard} from './legacy-requests';
import {InputChangedError,prepareTranslationInput,type PreparedInput} from '../../../input/prepare';
import {cacheInput} from '../../../input/cache';
import {loadTranslationInput} from '../../../input/load';
import {translationSize} from '../../../input/limits';

interface Options {api:Api;userId:string;language:string;modelId?:string;modelAvailable?:()=>boolean;onModelRejected?:()=>Promise<void>;getBlob:(key:string)=>Promise<Blob|undefined>;readOriginal?:(ref:PageReference)=>Promise<{blob:Blob;release:()=>void}>;prepareInput?:(target:ReadingTarget,current:()=>boolean,limits?:Capabilities['limits'])=>Promise<PreparedInput>;limits?:()=>Capabilities['limits'];tiles?:()=>boolean;rights:()=>Entitlements|undefined;onJobs:(jobs:Job[])=>Promise<void>;onChange:()=>void;}
const active=(r:LocalOperation)=>r.state==='uncertain'||r.state==='accepted'&&!!r.result&&['needs_input','queued','running','needs_attention'].includes(r.result.state);
const policyKey=(rights:Entitlements|undefined)=>rights?new Sha256().update(new TextEncoder().encode(JSON.stringify(rights))).digest():undefined;
/** The reader keeps its display model; server resources are always public translation UUIDs. */
export function translationJob(snapshot:TranslationSnapshot,record?:LocalOperation):Job{
  const unavailable=snapshot.error?.code==='TRANSLATION_UNAVAILABLE';
  const result=snapshot.state==='succeeded'&&snapshot.result&&!unavailable?{key:snapshot.result.artifact?.sha256??snapshot.id,recoverable:true}:undefined;
  return {id:snapshot.id,result,delivery:snapshot.result??undefined,model:snapshot.model,requested_model_id:snapshot.requested_model_id??record?.modelId,mode:snapshot.mode,target_language:snapshot.target_language,status:snapshot.state==='needs_input'?'awaiting_upload':snapshot.state==='needs_attention'?'outcome_unknown':snapshot.state==='succeeded'&&snapshot.result?.kind==='no_text'?'no_text':snapshot.state,phase:snapshot.state,created_at:snapshot.created_at??new Date(record?.createdAt??Date.now()).toISOString(),updated_at:snapshot.updated_at,version:1,quota_pages:0,cache_hit:false,error:snapshot.error??undefined,image_sha256:snapshot.image_sha256??record?.image.sha256,source_image_sha256:record?.sourceSha256,input_profile:record?.inputProfile,quality_flags:snapshot.result?.quality_flags,result_available:!!snapshot.result&&!unavailable,result_expired:unavailable};
}
/** Current plus three pages is local scheduling, never a server reading session. */
export class TranslationCoordinator {
  readonly scope:string;state:SyncState;records:LocalOperation[]=[];
  private initializing?:Promise<void>;private uploads=new Map<string,Promise<void>>();private uploadPool=new RequestPool(UPLOAD_CONCURRENCY);
  private wanted=new Set<string>();private refreshed=new Set<string>();
  private historyKey='';
  private stream?:{ids:Set<string>;records:LocalOperation[];controller:AbortController;events:AsyncGenerator<TranslationBatch>;signal:AbortSignal;abort:()=>void};
  private monotonic=new Map<string,{wall:number;until:number}>();private imageLimit?:number;private rightsKey?:string;
  private legacy:LegacyRequestGuard;
  constructor(readonly options:Options){this.scope=translationScope(new URL(options.api.base).origin,options.userId);this.state={id:this.scope};this.imageLimit=options.rights()?.image_rate_limit.limit;this.rightsKey=policyKey(options.rights());this.legacy=new LegacyRequestGuard(options.api,options.userId,options.language);}
  async init(){return this.initializing??=(async()=>{this.state=await readSync(this.scope)??this.state;})();}
  private async createOperation(target:ReadingTarget,current:()=>boolean,action?:{retry_of:string}|{regenerate_of:string},previous?:LocalOperation){
    // retry_of/regenerate_of inherit the server's frozen image, including requests made before resizing.
    const previousSize=previous?.result?.result??previous?.inputSize;
    const prepared:PreparedInput=action&&previous?{image:previous.image,sourceSha256:previous.sourceSha256??previous.image.sha256,width:previousSize?.width??target.page.width,height:previousSize?.height??target.page.height,profile:previous.inputProfile}:this.options.prepareInput?await this.options.prepareInput(target,current,this.options.limits?.()):await prepareTranslationInput(target.page,async()=>{
      const ref=target.page.blobKey;
      return ref?this.options.getBlob(ref):undefined;
    },current,this.options.limits?.(),!!action||!!this.options.tiles?.());
    if(action&&previous&&target.page.imageSha256&&prepared.sourceSha256!==target.page.imageSha256)throw Error(msg('原图内容已变化，请重新加载后翻译。'));
    if(!action&&Math.max(prepared.width,prepared.height)>16383){
      if(!this.options.tiles?.())throw new ApiError(msg('翻译服务暂不可用'),'RESULT_FORMAT_UNAVAILABLE',503);
      prepared.resultFormat='overlay-tiles-v1';
    }
    const modelId=action&&'retry_of' in action?previous?.modelId:this.options.modelId;
    const record=makeOperation(target,this.scope,this.options.language,prepared,action,modelId);
    if(previous)record.createdAt=Math.max(record.createdAt,previous.createdAt+1);
    if(prepared.blob)await cacheInput(this.scope,record.image.sha256,prepared.blob);
    assertCurrent(current);await saveOperation(record);
    return record;
  }
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
    return Math.max(this.controlDelay,waits.length?Math.min(...waits):this.wanted.size?imageDelay:0);
  }
  get waitingIds(){return this.records.filter(r=>this.wanted.has(r.id)&&r.state==='accepted'&&active(r)&&this.recordDelay(r)<=0).map(r=>r.requestId).sort();}
  get hasPending(){return this.waitingIds.length>0;}
  private remember(record:LocalOperation){this.records=this.records.filter(r=>r.id!==record.id);if(this.wanted.has(record.id)){this.records.push(record);this.options.onChange();}}
  private async save(record:LocalOperation){this.current();if(await updateOperation(record))this.remember(record);}
  private async restoreHistory(targets:ReadingTarget[]){
    const hashes=targets.flatMap(target=>target.page.imageSha256?[target.page.imageSha256]:[]);
    const ids=[...targets.flatMap(target=>target.page.translationScope===this.scope?target.page.jobs.map(job=>job.id):[]),...this.records.map(record=>record.requestId)];
    const key=JSON.stringify([hashes,ids,this.records.map(record=>record.result)]);if(this.historyKey===key)return;
    const jobs=await readJobs(this.scope,hashes,ids);this.current();
    await this.options.onJobs(jobs);this.historyKey=key;
  }
  private async receive(record:LocalOperation,result:TranslationSnapshot){
    if(result.id!==record.requestId)throw new ApiError(msg('翻译回执与操作编号不符'),'INVALID_RECEIPT');
    // Server/SSE still asks for the same frozen input. A reload or another
    // event must not turn an unreproducible local image into an automatic retry.
    if(record.state==='blocked'&&record.errorCode==='SOURCE_CHANGED'&&result.state==='needs_input')return;
    const previous=record.result;record.result=result;record.state='accepted';record.error=result.error?.message;record.errorCode=result.error?.code;record.retryAt=undefined;
    this.current();const job=translationJob(result,record);
    const current=await saveReceipt(record,job);if(current)this.remember(record);
    await this.options.onJobs([job]);
    if(current&&result.state==='needs_input'&&this.wanted.has(record.id))this.upload(record);
    if(result.state==='failed'&&previous?.state!=='failed')await this.refreshEntitlements();
  }
  private upload(record:LocalOperation){
    if(this.uploads.has(record.requestId))return;
    const work=this.uploadPool.run(async()=>{try{
      let lease:{blob:Blob;release:()=>void}|undefined,blob:Blob|undefined;
      try{
        blob=await loadTranslationInput(this.scope,{sha256:record.image.sha256,sourceSha256:record.sourceSha256,profile:record.inputProfile,size:record.inputSize},async()=>{
          lease=record.pageRef?await this.options.readOriginal?.(record.pageRef):undefined;
          return lease?.blob??(record.blobKey?this.options.getBlob(record.blobKey):undefined);
        },this.options.api.isCurrent);
      }finally{lease?.release();}
      if(!blob)throw new ApiError(msg('本地原图尚未就绪，请重新采集。'),'LOCAL_IMAGE_MISSING');
      if(blob.size!==record.image.byte_size||await hashFile(blob)!==record.image.sha256)throw new ApiError(msg('原图内容已变化，请重新加载后翻译。'),'SOURCE_CHANGED');
      await this.receive(record,await this.options.api.translationInput(record.requestId,blob));
    }catch(error){if(!this.options.api.isCurrent())return;record.error=(error as Error).message;record.errorCode=error instanceof ApiError||error instanceof InputChangedError?error.code:undefined;if(record.errorCode==='SOURCE_CHANGED'){record.state='blocked';record.retryAt=undefined;}else{record.state='uncertain';record.retryAt=Date.now()+15000;}await this.save(record);}finally{this.uploads.delete(record.requestId);this.options.onChange();}});
    this.uploads.set(record.requestId,work);
  }
  async finishUploads(){await Promise.all(this.uploads.values());}
  private async pageOperation(target:ReadingTarget){
    const records=await readPageOperations(this.scope,target.entryId,target.page.id,target.mode,this.options.language);
    // A changed preference never abandons an uncertain/uploading/queued request.
    return records.filter(record=>record.id===operationId(this.scope,this.options.language,target,record.modelId))
      .sort((a,b)=>Number(active(b))-Number(active(a))||b.createdAt-a.createdAt||b.requestId.localeCompare(a.requestId))[0];
  }
  private async backpressure(error:unknown){if(error instanceof ApiError&&(error.status===429||error.status===503)){const key=error.code==='IMAGE_RATE_LIMITED'?'imageRetryAt':'controlRetryAt';await this.persistState({[key]:Date.now()+(error.retryAfterSeconds??2)*1000});}}
  private async applySnapshots(records:LocalOperation[],response:TranslationBatch){
    for(const old of records){const record=await readOperation(old.id);if(!record||record.requestId!==old.requestId)continue;const snapshot=response.items.find(item=>item.id===record.requestId);if(snapshot){await this.receive(record,snapshot);if(this.wanted.has(record.id))this.refreshed.add(record.requestId);}else if(response.missing_ids.includes(record.requestId)){if(record.result){await this.receive(record,{id:record.requestId,state:'failed',mode:record.mode,target_language:record.language,error:{code:'TRANSLATION_UNAVAILABLE',message:msg('译图已失效')},updated_at:new Date().toISOString()});}else{record.state='local';record.retryAt=undefined;await this.save(record);}}}
  }
  private async snapshots(records:LocalOperation[],signal?:AbortSignal){
    if(!records.length)return;
    try{
      const response=await this.options.api.translations(records.map(r=>r.requestId).sort(),{signal});this.current();
      if(response.unchanged)return;
      await this.applySnapshots(records,response);
    }catch(error){await this.backpressure(error);throw error;}
  }
  stopWatching(){const stream=this.stream;if(!stream)return;this.stream=undefined;stream.signal.removeEventListener('abort',stream.abort);stream.controller.abort();void stream.events.return(undefined).catch(()=>{});}
  async wait(signal:AbortSignal){
    await this.init();signal.throwIfAborted();const ids=this.waitingIds;
    if(!ids.length){this.stopWatching();return false;}
    if(this.stream&&(this.stream.signal!==signal||ids.some(id=>!this.stream!.ids.has(id))))this.stopWatching();
    if(!this.stream){
      const controller=new AbortController(),abort=()=>this.stopWatching();
      this.stream={ids:new Set(ids),records:this.records.filter(record=>ids.includes(record.requestId)),controller,signal,abort,events:this.options.api.translationEvents(ids,controller.signal)};
      signal.addEventListener('abort',abort,{once:true});
    }
    const stream=this.stream;
    try{
      const next=await stream.events.next();this.current();signal.throwIfAborted();
      if(next.done){this.stopWatching();return this.hasPending;}
      await this.applySnapshots(stream.records,next.value);
      if(!this.hasPending)this.stopWatching();return true;
    }catch(error){if(this.stream===stream)this.stopWatching();await this.backpressure(error);throw error;}
  }
  private async recover(){if(this.controlDelay)return;const records=this.records.filter(r=>!this.uploads.has(r.requestId)&&(r.state==='uncertain'||r.result&&!this.refreshed.has(r.requestId))&&this.recordDelay(r)<=0);for(let n=0;n<records.length;n+=32)await this.snapshots(records.slice(n,n+32));}
  async submit(targets:ReadingTarget[],requestCurrent=()=>true){
    await this.init();const window=targets.slice(0,MAX_READING_TARGETS),previous=[...this.wanted].join(',');
    const ids=await Promise.all(window.map(async target=>(await this.pageOperation(target))?.id??operationId(this.scope,this.options.language,target,this.options.modelId)));
    this.wanted=new Set(ids);if(previous!==[...this.wanted].join(','))this.options.onChange();this.state=await readSync(this.scope)??this.state;
    for(const record of this.records)if(!this.wanted.has(record.id)){this.refreshed.delete(record.requestId);this.monotonic.delete('retry:'+record.requestId);}
    this.records=(await readOperations([...this.wanted])).filter(record=>this.wanted.has(record.id));
    await this.restoreHistory(window);
    if(this.controlDelay)return;
    await this.recover();
    for(const [index,target] of window.entries()){
      if(!requestCurrent()||this.controlDelay)break;
      try{await withTranslationLock(operationId(this.scope,this.options.language,target),async()=>{
        let record=await this.pageOperation(target);
        if(!record){
          if(this.remaining('imageRetryAt')>0||this.options.modelAvailable?.()===false)return;
          // A previously delivered job without a local intent stays visible until explicit retranslation.
          if(pageTranslation(target.page,target.mode,this.options.language,this.scope).latest)return;
          await this.legacy.check(target);record=await this.createOperation(target,()=>requestCurrent()&&this.options.api.isCurrent());
        }
        if(record.id!==ids[index]){this.wanted.delete(ids[index]);this.wanted.add(record.id);}
        this.remember(record);
        await this.restorePolicy(record);
        this.state=await readSync(this.scope)??this.state;
        // Image admission backpressure covers every new page in this scope, including a new window.
        // Accepted requests can be recovered and supplied with their original bytes.
        if(record.state==='blocked'||record.state==='accepted'||record.state==='uncertain'||this.recordDelay(record)>0||this.remaining('imageRetryAt')>0)return;
        if(!requestCurrent())return;
        record.state='uncertain';await this.save(record);
        try{const result=await this.options.api.translate(record.requestId,record.request);if(this.wanted.has(record.id))this.refreshed.add(record.requestId);await this.receive(record,result);}
        catch(error){this.current();const e=error instanceof ApiError?error:new ApiError((error as Error).message);await this.backpressure(e);const definitive=e.status>=400&&e.status<500||e.code==='TRANSLATION_MODEL_UNAVAILABLE';record.state=e.status===429?'deferred':definitive?'blocked':'uncertain';record.error=e.message;record.errorCode=e.code;if(quotaErrors.has(e.code))record.deniedPolicy=this.rightsKey;if(e.code==='IMAGE_RATE_LIMITED')record.deniedImageLimit=this.imageLimit;record.retryAt=record.state==='blocked'?undefined:Date.now()+(e.retryAfterSeconds??2)*1000;await this.save(record);if(['TRANSLATION_MODEL_NOT_ALLOWED','TRANSLATION_MODEL_INVALID','TRANSLATION_MODEL_UNAVAILABLE','DAILY_QUOTA_EXHAUSTED'].includes(e.code))await this.options.onModelRejected?.().catch(()=>undefined);
        }
      });}catch(error){if(!this.options.api.isCurrent())throw error;const message=(error as Error).message;if(target.page.translationError!==message){target.page.translationError=message;this.options.onChange();}}
    }
  }
  async manual(target:ReadingTarget,requestCurrent=()=>true){
    await this.init();const id=operationId(this.scope,this.options.language,target);
    await withTranslationLock(id,async()=>{
      const previous=await this.pageOperation(target),latest=pageTranslation(target.page,target.mode,this.options.language,this.scope);
      if(!previous)await this.legacy.check(target,true);
      if(previous?.state==='uncertain'||previous&&active(previous)||latest.pending||latest.latest?.status==='unknown_released')throw Error(msg('原请求结果待核实，暂不能重复翻译。'));
      if(this.options.modelAvailable?.()===false)throw Error(msg('此翻译方式暂不可用'));
      const sameModel=(previous?.modelId??latest.latest?.requested_model_id??undefined)===this.options.modelId;
      const source=previous?.result?.id??latest.latest?.id,state=previous?.result?.state??latest.latest?.status;
      const frozen=previous?.result?.result??previous?.inputSize??latest.latest?.delivery,profile=previous?.inputProfile??latest.latest?.input_profile;
      const sourceSha=previous?.sourceSha256??latest.latest?.source_image_sha256,planned=translationSize(target.page.width,target.page.height);
      // Only an explicit retry with the same materialized source may replace a mis-sized input.
      // Normal retries and unknown outcomes keep their frozen bytes and request semantics.
      const rebuild=!!profile&&!!target.page.imageSha256&&sourceSha===target.page.imageSha256&&!!frozen&&(frozen.width!==planned.width||frozen.height!==planned.height);
      if(previous?.state==='blocked'&&!previous.result&&sameModel){
        if(rebuild||previous.errorCode==='INVALID_REQUEST'&&'image' in previous.request&&previous.request.image.content_type==='image/avif'){
          // Rejected descriptors may be corrected only under a new explicit UUID.
          const record=await this.createOperation(target,()=>requestCurrent()&&this.options.api.isCurrent());this.remember(record);
        }else{previous.state='local';previous.error=undefined;previous.retryAt=undefined;await saveOperation(previous);}
        return;
      }
      const failed=state==='failed'||state==='cancelled';
      const action=source&&!rebuild?failed?(sameModel?{retry_of:source}:undefined):{regenerate_of:source}:undefined;
      const record=await this.createOperation(target,()=>requestCurrent()&&this.options.api.isCurrent(),action,previous);this.remember(record);
    });await this.submit([target],requestCurrent);
  }
  async refreshEntitlements(rights?:Entitlements){
    // Focus/manual policy reads can return the same cache. They must not reopen
    // quota-denied automatic submissions on every click.
    if(rights){const key=policyKey(rights);if(key===this.rightsKey)return;this.rightsKey=key;}
    const changedLimit=rights&&this.imageLimit!==undefined&&this.imageLimit!==rights.image_rate_limit.limit;
    if(rights)this.imageLimit=rights.image_rate_limit.limit;
    if(changedLimit)await this.persistState({imageRetryAt:undefined});
    for(const record of await readOperations([...this.wanted]))await this.restorePolicy(record,true,!!changedLimit);
  }
  private async restorePolicy(record:LocalOperation,changedPolicy=false,changedLimit=false){
    const quota=record.state==='blocked'&&quotaErrors.has(record.errorCode??'')&&!record.result;
    const rate=record.state==='deferred'&&record.errorCode==='IMAGE_RATE_LIMITED';
    if(quota&&(changedPolicy||record.deniedPolicy!==undefined&&record.deniedPolicy!==this.rightsKey)||rate&&(changedLimit||record.deniedImageLimit!==undefined&&record.deniedImageLimit!==this.imageLimit)){
      record.state='local';record.error=undefined;record.retryAt=undefined;await this.save(record);
    }else if(quota&&record.deniedPolicy===undefined&&this.rightsKey!==undefined){record.deniedPolicy=this.rightsKey;await this.save(record);}
  }
}
