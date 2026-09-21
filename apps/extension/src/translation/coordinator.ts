import {msg} from '../i18n/runtime';
import {Api,ApiError} from '../api';
import {assertCurrent,RequestPool,UPLOAD_CONCURRENCY} from '../concurrency';
import {mergeJobs} from '../reader/jobs';
import {pageTranslation} from '../reader/presentation';
import type {Entitlements,Job,Mode,TranslationChanges,TranslationOperation,TranslationPlan} from '../types';
import {makeOperation,operationId,quotaErrors,type ReadingTarget} from './automatic';
import {readOperation,readOperations,readSession,readSync,saveOperation,saveSession,saveSync,translationScope,withTranslationLock,type LocalOperation,type ReadingSession,type SyncState} from './store';

interface Options {api:Api;userId:string;language:string;sessionId:string;getBlob:(key:string)=>Promise<Blob|undefined>;rights:()=>Entitlements|undefined;onJobs:(jobs:Job[])=>Promise<void>;onChange:()=>void;onPolicy?:(rights:Entitlements)=>void;}
const revisionNewer=(a:string|undefined,b:string|undefined)=>!b||a===b||!!a&&(/^\d+$/.test(a)&&/^\d+$/.test(b)?BigInt(a)>BigInt(b):a>b);
/** One shared protocol for reader and content-script driven background steps. No queue preflight. */
export class TranslationCoordinator {
  readonly scope:string;state:SyncState;records:LocalOperation[]=[];session:ReadingSession;
  private initializing?:Promise<void>;private sending=false;private manualPending=false;private sendWaiters:(()=>void)[]=[];private uploads=new Map<string,Promise<void>>();private failures=0;private uploadPool:RequestPool;
  private monotonic=new Map<string,{wall:number;until:number}>();private lastSignature='';private leaseAt=0;
  constructor(readonly options:Options){this.scope=translationScope(new URL(options.api.base).origin,options.userId);this.state={id:this.scope,jobs:[]};this.session={id:this.scope+':'+options.sessionId,sessionId:options.sessionId,sequence:0,priority:{}};this.uploadPool=new RequestPool(UPLOAD_CONCURRENCY);}
  async init(){return this.initializing??= (async()=>{this.state=await readSync(this.scope)??this.state;this.session=await readSession(this.session.id)??this.session;this.options.sessionId=this.session.sessionId;this.records=await readOperations(this.scope);await this.options.onJobs(this.state.jobs);})();}
  private async resetSession(){this.options.sessionId=crypto.randomUUID();this.session={id:this.session.id,sessionId:this.options.sessionId,sequence:0,priority:{}};this.lastSignature='';this.leaseAt=0;await saveSession(this.session);this.options.onChange();}
  private current(){assertCurrent(this.options.api.isCurrent);}
  private async persistState(patch:Partial<SyncState>){await withTranslationLock('sync:'+this.scope,async()=>{this.current();const saved=await readSync(this.scope)??this.state;this.state={...saved,...patch};await saveSync(this.state);});}
  private remaining(key:'imageRetryAt'|'controlRetryAt'){const wall=this.state[key]??0;if(!wall)return 0;let value=this.monotonic.get(key);if(!value||value.wall!==wall){value={wall,until:performance.now()+Math.max(0,wall-Date.now())};this.monotonic.set(key,value);}return Math.max(0,value.until-performance.now());}
  get retryDelay(){
    const waits=this.records.filter(r=>r.state==='uncertain'||r.result?.job?.status==='awaiting_upload'||r.state==='local').map(r=>Math.max(0,(r.retryAt??0)-Date.now()));
    const deadlines=[this.remaining('imageRetryAt'),...waits].filter(n=>n>0);
    return Math.max(this.remaining('controlRetryAt'),deadlines.length?Math.min(...deadlines):0);
  }
  get controlDelay(){return this.remaining('controlRetryAt');}
  private async backpressure(error:unknown){if(error instanceof ApiError&&(error.status===429||error.status===503&&error.retryAfterSeconds)){const key=error.code==='IMAGE_RATE_LIMITED'?'imageRetryAt':'controlRetryAt';await this.persistState({[key]:Date.now()+(error.retryAfterSeconds??1)*1000});}}
  private async policy(revision?:string,rights?:Entitlements,limit?:number){
    const saved=await readSync(this.scope);if(saved&&revisionNewer(saved.policyRevision,this.state.policyRevision))this.state=saved;
    if(!revision||!revisionNewer(revision,this.state.policyRevision))return;
    const changed=revision!==this.state.policyRevision,minuteChanged=limit!=null&&this.state.imageLimit!=null&&limit!==this.state.imageLimit;
    await this.persistState({policyRevision:revision,...(rights?{entitlements:rights}:{}),...(limit!=null?{imageLimit:limit}:{}),...(minuteChanged?{imageRetryAt:undefined}:{})});
    if(changed){if(rights){await this.refreshPolicy(rights);this.options.onPolicy?.(rights);}this.lastSignature='';}
  }
  async consume(changes:TranslationChanges){
    await this.init();this.current();
    const deleted=new Set(changes.deleted_job_ids??[]),tombstones=this.state.jobs.filter(j=>deleted.has(j.id)).map(j=>({...j,status:'cancelled' as const,output_asset_id:null,result_available:false,result_expired:true,updated_at:new Date().toISOString()}));
    await this.policy(changes.policy_revision,changes.entitlements,changes.image_rate_limit?.limit);
    await withTranslationLock('sync:'+this.scope,async()=>{this.current();const saved=await readSync(this.scope)??this.state;const jobs=mergeJobs(saved.jobs,[...changes.items,...tombstones]);const old=Number(saved.cursor??0),next=Number(changes.cursor);this.state={...saved,jobs,cursor:Number.isFinite(next)&&Number.isFinite(old)&&next<old?saved.cursor:changes.cursor};await saveSync(this.state);});
    await this.options.onJobs([...changes.items,...tombstones]);this.options.onChange();
  }
  async wait(signal:AbortSignal){await this.init();try{const changes=await this.options.api.waitForTranslationChanges(this.state.cursor,signal,this.state.policyRevision);await this.consume(changes);return changes;}catch(error){if(error instanceof ApiError&&['CURSOR_EXPIRED','INVALID_CURSOR'].includes(error.code)){await this.persistState({cursor:undefined,jobs:[]});return undefined;}throw error;}}
  private async save(record:LocalOperation){
    await withTranslationLock(record.id,async()=>{this.current();const saved=await readOperation(record.id);
      if(saved&&saved.item.operation_key!==record.item.operation_key)record={...record,id:record.id+':receipt:'+record.item.operation_key};
      await saveOperation(record);this.records=this.records.filter(r=>r.id!==record.id).concat(record);this.options.onChange();
    });
  }
  private async receive(record:LocalOperation,result:TranslationOperation){
    if(result.operation_key!==record.item.operation_key)throw new ApiError(msg("翻译回执与操作编号不符"),'INVALID_RECEIPT');
    if(result.disposition==='not_found'){record.state='local';record.error=undefined;record.retryAt=undefined;await this.save(record);return;}
    record.result=result;record.error=result.message;record.retryAt=undefined;
    record.state=result.job?'accepted':result.disposition==='deferred'?'deferred':'blocked';
    if(result.disposition==='blocked')record.state='blocked';
    await this.save(record);if(result.job)await this.options.onJobs([result.job,...(result.display_jobs??[])]);
    if(result.upload&&result.job?.status==='awaiting_upload')this.upload(record);
  }
  private upload(record:LocalOperation){
    if(this.uploads.has(record.item.operation_key))return;
    const work=this.uploadPool.run(async()=>{try{
      const plan=record.result?.upload;if(!plan)return;this.current();
      const blob=record.blobKey?await this.options.getBlob(record.blobKey):undefined;if(!blob)throw new ApiError(msg("本地原图尚未就绪，请重新采集。"),'LOCAL_IMAGE_MISSING');
      await this.options.api.uploadOriginal(plan,blob);const job=await this.options.api.completeUpload(plan.id);this.current();record.result={...record.result!,job,upload:null};record.error=undefined;record.retryAt=undefined;await this.save(record);await this.options.onJobs([job]);
    }catch(error){if(!this.options.api.isCurrent())return;record.error=(error as Error).message;record.retryAt=Date.now()+15000;await this.save(record);}finally{this.uploads.delete(record.item.operation_key);}});
    this.uploads.set(record.item.operation_key,work);
  }
  async finishUploads(){await Promise.all(this.uploads.values());}
  async recover(){
    await this.init();this.state=await readSync(this.scope)??this.state;if(this.controlDelay)return;
    const records=(await readOperations(this.scope)).filter(r=>!this.uploads.has(r.item.operation_key)&&(r.state==='uncertain'||r.state==='accepted'&&r.result?.job?.status==='awaiting_upload')&&(!r.retryAt||r.retryAt<=Date.now()));
    try{for(let n=0;n<records.length;n+=10){const chunk=records.slice(n,n+10);const response=await this.options.api.resolveOperations(chunk.map(r=>r.item.operation_key));this.current();for(const record of chunk){const result=response.items.find(i=>i.operation_key===record.item.operation_key);if(result)await this.receive(record,result);}}}catch(error){await this.backpressure(error);throw error;}
  }
  async renew(modes:Mode[],takeover=false){
    await this.init();this.state=await readSync(this.scope)??this.state;if(!this.session.sequence||this.controlDelay||!takeover&&performance.now()<this.leaseAt)return;
    const priority_epochs=Object.fromEntries(Object.entries(this.session.priority).map(([mode,p])=>[mode,p.epoch]));
    try{const response=await this.options.api.lease(this.options.sessionId,modes,priority_epochs,takeover);this.current();this.session.priority=response.priority;await saveSession(this.session);this.leaseAt=performance.now()+30000;}
    catch(error){if(error instanceof ApiError&&['READING_SESSION_EXPIRED','READING_SESSION_FENCED','READING_EPOCH_CONFLICT'].includes(error.code)){await this.resetSession();return;}await this.backpressure(error);throw error;}
  }
  async plan(targets:ReadingTarget[],manual=false,requestCurrent=()=>true){
    await this.init();this.state=await readSync(this.scope)??this.state;if(this.sending||this.manualPending&&!manual||this.controlDelay||!targets.length&&!this.session.sequence)return;this.sending=true;
    try{
      this.current();const chosen:LocalOperation[]=[];
      for(const [index,target] of targets.slice(0,manual?1:4).entries()){
        try{
          const id=operationId(this.scope,this.options.language,target);
          const record=await withTranslationLock(id,async()=>{
            let saved=await readOperation(id);
            if(saved&&!manual&&(saved.state==='accepted'||saved.state==='blocked')&&saved.result?.job?.status!=='awaiting_upload'&&saved.item.action&&saved.item.action!=='ensure'){
              await saveOperation({...saved,id:saved.id+':receipt:'+saved.item.operation_key});
              const {action:_action,source_job_id:_source,...item}=saved.item;
              saved={...saved,item:{...item,operation_key:crypto.randomUUID()},state:'local'};await saveOperation(saved);
            }
            if(!saved){const owned=target.page.ownerId===this.options.userId&&target.page.apiOrigin===new URL(this.options.api.base).origin;saved=await makeOperation({...target,page:owned?target.page:{...target.page,assetId:undefined}},this.scope,this.options.language,(this.state.entitlements??this.options.rights())?.modes[target.mode],this.options.getBlob);await saveOperation(saved);}
            return saved;
          });chosen.push(record);
        }catch(error){if(index===0)throw error;/* One unavailable prefetch never blocks the current page. */}
      }
      if(!manual){const pendingManual=chosen.find(r=>r.item.action&&r.item.action!=='ensure');if(pendingManual){chosen.splice(0,chosen.length,pendingManual);manual=true;}}
      const allowNew=this.remaining('imageRetryAt')<=0;
      const signature=JSON.stringify(chosen.map((r,n)=>[r.item.operation_key,n?'prefetch':'current']));
      const retriable=chosen.some(r=>(r.state==='deferred'&&allowNew||r.state==='local')&&(!r.retryAt||r.retryAt<=Date.now()));
      if(signature===this.lastSignature&&!retriable)return;
      if(chosen.some(r=>r.state==='uncertain')){await this.recover();if(chosen.some(r=>this.records.find(v=>v.id===r.id)?.state==='uncertain'))return;for(let i=0;i<chosen.length;i++)chosen[i]=await readOperation(chosen[i].id)??chosen[i];}
      if(!requestCurrent())return;
      const items=chosen.map((r,n)=>({...r.item,role:(n?'prefetch':'current') as 'prefetch'|'current',...(r.result?.job?{job_id:r.result.job.id}:{})}));
      const frozenSignature=JSON.stringify(items);if(this.session.signature!==frozenSignature){this.session.sequence++;this.session.signature=frozenSignature;}
      await saveSession(this.session);
      const request:TranslationPlan={trigger:manual?'manual':'reading',...(!manual?{session_id:this.options.sessionId,sequence:this.session.sequence,priority_epochs:Object.fromEntries(Object.entries(this.session.priority).map(([mode,p])=>[mode,p.epoch]))}:{}),allow_new:allowNew,items};
      for(const record of chosen)if(['local','deferred'].includes(record.state)){record.state='uncertain';await this.save(record);}
      if(!requestCurrent()){for(const record of chosen)if(record.state==='uncertain'){record.state='local';await this.save(record);}return;}
      try{
        const response=await this.options.api.plan(request);this.current();
        if(response.items.length!==items.length||items.some(i=>!response.items.some(r=>r.operation_key===i.operation_key)))throw new ApiError(msg("翻译回执缺少请求页"),'INVALID_RECEIPT');
        await this.policy(response.policy_revision,response.entitlements,response.image_rate_limit?.limit);
        const stalePolicy=!!this.state.policyRevision&&!revisionNewer(response.policy_revision,this.state.policyRevision);
        if(response.priority){this.session.priority=response.priority;await saveSession(this.session);}this.leaseAt=performance.now()+30000;
        let wait=0;
        for(const record of chosen){const result=response.items.find(r=>r.operation_key===record.item.operation_key)!;await this.receive(record,result);if(result.code==='IMAGE_RATE_LIMITED')wait=Math.max(wait,result.retry_after_seconds??response.image_rate_limit?.retry_after_seconds??1);}
        if(wait&&!stalePolicy)await this.persistState({imageRetryAt:Date.now()+wait*1000+Math.random()*100});
        this.lastSignature=signature;this.failures=0;
      }catch(error){
        this.current();const e=error instanceof ApiError?error:new ApiError((error as Error).message);
        const definitive=[401,403,409,422,429].includes(e.status),delay=e.retryAfterSeconds??Math.min(30,2**Math.min(this.failures++,5));
        if(e.code==='IMAGE_RATE_LIMITED')await this.persistState({imageRetryAt:Date.now()+delay*1000});
        else if(e.status===429||e.status===503&&e.retryAfterSeconds)await this.persistState({controlRetryAt:Date.now()+delay*1000});
        if(['STALE_READING_PLAN','READING_SESSION_EXPIRED','READING_SESSION_FENCED','READING_EPOCH_CONFLICT'].includes(e.code))await this.resetSession();
        for(const record of chosen)if(record.state==='uncertain'){if(definitive)record.state=e.status===422||e.status===401||e.status===403?'blocked':'local';record.error=e.message;record.retryAt=Date.now()+delay*1000+Math.random()*100;await this.save(record);}
        throw e;
      }
    }finally{this.sending=false;for(const resolve of this.sendWaiters.splice(0))resolve();}
  }
  async manual(target:ReadingTarget,requestCurrent=()=>true){
    await this.init();this.manualPending=true;
    try{
    while(this.sending)await new Promise<void>(resolve=>this.sendWaiters.push(resolve));
    const id=operationId(this.scope,this.options.language,target),origin=new URL(this.options.api.base).origin;
    const latest=pageTranslation(target.page,target.mode,this.options.language,this.options.userId,origin);
    if(latest.pending||latest.latest?.status==='unknown_released')throw Error(msg("原请求结果待核实，暂不能重复翻译。"));
    await withTranslationLock(id,async()=>{const previous=await readOperation(id);if(previous?.state==='uncertain')throw Error(msg("正在恢复原操作，请稍后重试。"));const previousJob=this.state.jobs.find(job=>job.id===previous?.result?.job?.id)??previous?.result?.job;if(previousJob&&['awaiting_upload','validating_upload','queued','running','outcome_unknown'].includes(previousJob.status))throw Error(msg("此页正在翻译，请等待现有任务完成。"));const record=await makeOperation(target,this.scope,this.options.language,(this.state.entitlements??this.options.rights())?.modes[target.mode],this.options.getBlob,{action:!latest.latest?'ensure':latest.latest.status==='failed'?'retry':'regenerate',sourceJobId:latest.latest?.id});await saveOperation(record);this.records=this.records.filter(r=>r.id!==record.id).concat(record);this.options.onChange();});
    this.lastSignature='';await this.plan([target],true,requestCurrent);
    }finally{this.manualPending=false;}
  }
  async refreshPolicy(rights:Entitlements){const previous=this.state.entitlements;await this.persistState({entitlements:rights,...(previous&&previous.image_rate_limit.limit!==rights.image_rate_limit.limit?{imageRetryAt:undefined}:{})});for(const record of await readOperations(this.scope))if(record.state==='blocked'&&quotaErrors.has(record.result?.code??'')&&!record.result?.job){await withTranslationLock(record.id,async()=>{const latest=await readOperation(record.id);if(latest?.state!=='blocked'||latest.item.operation_key!==record.item.operation_key)return;record.state='local';record.item={...record.item,operation_key:crypto.randomUUID(),expected_kind:rights.modes[record.item.mode].quota_kind,max_quota_pages:rights.modes[record.item.mode].unlimited||(rights.modes[record.item.mode].quota?.available??0)>0?1:0};record.result=undefined;await saveOperation(record);this.records=this.records.filter(r=>r.id!==record.id).concat(record);});}this.lastSignature='';}
}
