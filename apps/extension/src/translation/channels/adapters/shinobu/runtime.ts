import {hashFile,Sha256} from '../../../../importers/hash';
import {parsePageReference} from '../../../../comics/pages/identity';
import {readImageTranslationBinding} from '../../../../comics/repositories/translation-bindings';
import type {Job} from '../../../../types';
import {probeImageMetadata} from '../../../../comics/pages/image-metadata';
import {pageTranslation} from '../../../../reader/presentation';
import {translationCache} from '../../../../storage/translations';
import {MAX_READER_TARGETS} from '../../../../reading-window';
import {targetKey,type ReadingTarget,type TranslationState} from '../../../automatic';
import type {ChannelRuntime,RuntimeOptions,TranslationScope} from '../../contracts';
import {localHostRequest} from '../../host-client';
import {fullFont} from '../../../font-resources';
import {assetRecord} from '../../../../storage/local-assets/store';
import {modelAssets,resourceEvents} from './resources';
import {ENGINE_REVISION,type ShinobuConfig} from './config';
import {TEXT_PROTOCOL_REVISION} from './text/protocol';
import {errorMessage} from './errors';
import {supportsLocalLanguage} from './languages';
import {executionLock,launchLock,operationLock} from './locks';
import {readOperation,saveOperation,readCheckpoint,saveCheckpoint,releaseInput,type LocalOperation} from './operations';
const digest=(value:unknown)=>new Sha256().update(new TextEncoder().encode(JSON.stringify(value))).digest();
export class ShinobuRuntime implements ChannelRuntime{
  private admissionError?:string;private resources?:BroadcastChannel;
  private records=new Map<string,LocalOperation>();private targets:ReadingTarget[]=[];private stopped=false;private pumping=false;private check:(target:ReadingTarget)=>boolean=()=>true;
  private delivered=new Map<string,Job>();
  constructor(readonly scope:TranslationScope,private options:RuntimeOptions,private config:ShinobuConfig,private fontId:string,private token=''){}
  private current=()=>!this.stopped&&this.options.isCurrent();
  private id=(target:ReadingTarget)=>digest([this.scope.key,this.options.language,targetKey(target.entryId,target.page,target.mode)]);
  private changed=()=>{if(this.current())this.options.onChange();};
  private needs=(target:ReadingTarget)=>this.check(target)&&!this.records.has(this.id(target))&&!this.delivered.has(this.id(target))&&!pageTranslation(target.page,target.mode,this.options.language,this.scope.key).latest;
  get waitingIds(){return [...this.records.values()].filter(r=>r.job.status==='running').map(r=>r.job.id);}
  get hasPending(){return this.waitingIds.length>0||!this.admissionError&&this.targets.some(this.needs);}
  get retryDelay(){return 0;}
  async init(){if(!this.resources){this.resources=new BroadcastChannel(resourceEvents);this.resources.onmessage=()=>{this.admissionError=undefined;void this.pump();};}}
  private async adopt(record:LocalOperation){
    const previous=this.records.get(record.id);this.records.set(record.id,record);
    if(previous?.job.id===record.job.id&&previous.job.status===record.job.status&&previous.job.updated_at===record.job.updated_at&&previous.previousResult?.id===record.previousResult?.id)return;
    if(this.current())await this.options.onJobs([...(record.previousResult?[record.previousResult]:[]),record.job]);this.changed();
  }
  private async recover(record:LocalOperation){
    if(record.job.status!=='running')return record;
    await navigator.locks.request(launchLock(record.id),{ifAvailable:true},async launch=>{
      if(!launch)return;
      await navigator.locks.request(operationLock(record.id),{ifAvailable:true},async operation=>{
        if(!operation)return;const saved=await readOperation(record.id);
        if(saved){record=saved;if(saved.job.status==='running'){record={...saved,job:{...saved.job,status:'failed',phase:'failed',error:{code:'INTERRUPTED',message:errorMessage('INTERRUPTED')}}};await saveOperation(record);await releaseInput(saved.job.id);}}
      });
    });return record;
  }
  async restore(targets:ReadingTarget[]){
    for(const target of targets.slice(0,MAX_READER_TARGETS)){
      const id=this.id(target),record=await readOperation(id);
      if(record){await this.adopt(await this.recover(record));continue;}
      // Identical source pages can share a delivered image without sharing a page operation.
      // Read the exact binding before admission; reader hydration may still show another channel.
      if(!target.page.imageSha256)continue;
      const binding=await readImageTranslationBinding(this.scope.key,target.page.imageSha256);
      const payload=binding?.payload as {jobs?:Job[]}|undefined;
      const jobs=Array.isArray(payload?.jobs)?payload.jobs:[];
      const display=pageTranslation({...target.page,translationScope:this.scope.key,jobs},target.mode,this.options.language,this.scope.key);
      const job=display.result??(display.latest?.status==='no_text'?display.latest:undefined);
      if(!job)continue;
      const previous=this.delivered.get(id);this.delivered.set(id,job);
      if(this.current()&&(previous?.id!==job.id||previous.updated_at!==job.updated_at)){await this.options.onJobs([job]);this.changed();}
    }
  }
  async submit(targets:ReadingTarget[],isCurrent:(target:ReadingTarget)=>boolean=()=>true){
    if(!supportsLocalLanguage(this.options.language))return;
    await this.init();
    this.check=isCurrent;this.targets=targets.filter(isCurrent).slice(0,MAX_READER_TARGETS);
    const retain=new Set(this.targets.map(this.id));for(const [id,record] of this.records)if(!retain.has(id)&&record.job.status!=='running')this.records.delete(id);
    for(const id of this.delivered.keys())if(!retain.has(id))this.delivered.delete(id);
    await this.restore(this.targets);void this.pump();
  }
  private async pump(){
    if(this.pumping||!this.current()||this.admissionError)return;this.pumping=true;
    try{
      const target=this.targets.find(this.needs);if(!target)return;
      const assets=[...modelAssets,fullFont(this.fontId)];
      if((await Promise.all(assets.map(assetRecord))).some(record=>record?.state!=='ready'))this.admissionError='ASSET_MISSING';
      if(this.admissionError){this.changed();return;}
      await navigator.locks.request('nc-shinobu-admission',{ifAvailable:true},async lock=>{
        if(!lock||(await navigator.locks.query()).held?.some(l=>l.name===executionLock)||!this.current()||!this.check(target))return;
        const existing=await readOperation(this.id(target));if(existing){await this.adopt(existing);return;}
        await this.begin(target,undefined,()=>this.current()&&this.check(target));
      });
    }catch{this.changed();}finally{this.pumping=false;}
  }
  // Manual requests follow channel lifetime; automatic requests also follow their reading window.
  private async begin(target:ReadingTarget,previous?:LocalOperation,requestCurrent=this.current){
    if(!requestCurrent())return;
    const id=this.id(target),font=fullFont(this.fontId),fingerprint=digest([ENGINE_REVISION,TEXT_PROTOCOL_REVISION,this.config,this.options.language,font.sha256]);
    await navigator.locks.request(launchLock(id),async()=>{
      let dispatched=false;
      let lease:{blob:Blob;release:()=>void}|undefined;
      const now=new Date().toISOString();
      let record:LocalOperation={id,scope:this.scope.key,entryId:target.entryId,pageId:target.page.id,config:this.config,fontId:this.fontId,fingerprint,cacheToken:await translationCache.token(this.scope.key),previousResult:previous?.job.status==='succeeded'?previous.job:previous?.previousResult??this.delivered.get(id),
        job:{id:crypto.randomUUID(),mode:target.mode,target_language:this.options.language,font_id:this.fontId,status:'running',phase:'detecting',created_at:now,updated_at:now,version:1,quota_pages:0,cache_hit:false}};
      try{
        const reference=target.page.blobKey?parsePageReference(target.page.blobKey):undefined;
        if(reference)lease=await this.options.readOriginal?.(reference);
        const source=lease?.blob??(target.page.blobKey?await this.options.getBlob(target.page.blobKey):undefined);
        if(!source)throw Error('SOURCE_MISSING');
        if(!requestCurrent())return;
        const metadata=await probeImageMetadata(source);
        if(!metadata)throw Error('SOURCE_CHANGED');
        const sha=await hashFile(source);if(target.page.imageSha256&&target.page.imageSha256!==sha)throw Error('SOURCE_CHANGED');
        if(!requestCurrent())return;
        record.job.image_sha256=sha;record.fingerprint=digest([fingerprint,sha]);
        if(previous?.fingerprint===record.fingerprint){
          const checkpoint=await readCheckpoint(previous.job.id);
          if(checkpoint?.state==='succeeded'&&checkpoint.updatedAt>Date.now()-86400000)await saveCheckpoint({...checkpoint,id:record.job.id});
        }
        await saveOperation(record,true,source);await this.adopt(record);
        dispatched=true;
        await localHostRequest('shinobu',{action:'start',id,token:this.token});
        if(target.page.blobKey)await this.options.onInputConsumed?.(target.page.blobKey).catch(()=>{});
      }catch(error){
        // A missing ACK cannot overwrite work already accepted by the independent host.
        if(dispatched)return;
        const code=error instanceof Error?error.message:'INTERRUPTED';record={...record,job:{...record.job,status:'failed',phase:'failed',error:{code,message:errorMessage(code)}}};
        await saveOperation(record,true);await releaseInput(record.job.id);await this.adopt(record);
      }finally{lease?.release();}
    });
  }
  async manual(target:ReadingTarget){
    if(!supportsLocalLanguage(this.options.language))throw Error(errorMessage('TEXT_LANGUAGE_UNSUPPORTED'));
    this.admissionError=undefined;
    await navigator.locks.request('nc-shinobu-admission',async()=>{
      if((await navigator.locks.query()).held?.some(l=>l.name===executionLock))throw Error(errorMessage('INTERRUPTED'));
      const previous=await readOperation(this.id(target));await this.begin(target,previous);
    });
  }
  async wait(signal:AbortSignal){signal.throwIfAborted();if(!this.hasPending)return false;await new Promise<void>(resolve=>setTimeout(resolve,750));signal.throwIfAborted();await this.refresh();return this.hasPending;}
  async refresh(){
    if(!this.current())return;
    await this.restore(this.targets);
    const visible=new Set(this.targets.map(this.id));
    for(const record of this.records.values())if(record.job.status==='running'&&!visible.has(record.id)){
      const saved=await readOperation(record.id);if(saved)await this.adopt(await this.recover(saved));
    }
    void this.pump();
  }
  stateFor(target:ReadingTarget,active:boolean,error?:string):TranslationState|undefined{
    if(!supportsLocalLanguage(this.options.language))return active?{kind:'error',message:errorMessage('TEXT_LANGUAGE_UNSUPPORTED'),retryable:false}:undefined;
    const record=this.records.get(this.id(target)),displayed=pageTranslation(target.page,target.mode,this.options.language,this.scope.key);
    if(record?.job.status==='running')return {kind:'translating',message:msgTranslate()};
    if(record?.job.status==='failed')return {kind:'error',message:errorMessage(record.job.error?.code??'PIPELINE_FAILED'),retryable:true,retryAction:'translate'};
    if(error||target.page.translationError||displayed.expired)return {kind:'error',message:error||target.page.translationError||errorMessage('RESULT_NOT_CACHED'),retryable:true,retryAction:'translate'};
    if(displayed.ready||record?.job.status==='no_text'||this.delivered.get(this.id(target))?.status==='no_text')return;
    if(this.admissionError)return {kind:'error',message:errorMessage(this.admissionError),retryable:false};
    return active?{kind:'waiting',message:msgWait()}:undefined;
  }
  dispose(){this.stopped=true;this.resources?.close();this.targets=[];this.delivered.clear();}
}
import {msg} from '../../../../i18n/runtime';
const msgTranslate=()=>msg('翻译中');const msgWait=()=>msg('等待翻译');
