import {Api} from '../../../../api';
import {readAuth,subscribeAuth} from '../../../../auth/storage';
import {sessionAuthorization} from '../../../../auth/session';
import {assertCurrent,RequestPool,UPLOAD_CONCURRENCY} from '../../../../concurrency';
import {msg} from '../../../../i18n/runtime';
import {API_BASE,API_ORIGIN} from '../../../../service';
import {fallbackLanguages,modeLabels,supportsLanguage,type Capabilities,type Entitlements} from '../../../../types';
import type {ChannelDefinition,ChannelConnection,ChannelRuntime,RuntimeOptions} from '../../contracts';
import {TranslationCoordinator,translationJob} from './coordinator';
import {translationState} from './state';
import {translationScope,readEntryOperations,blockEntryOperations,removeEntryOperations,readImageJobsPage} from './store';
import {loadDeliveredResult,registerResultReader,releaseResultReaders,resultBlobKey} from '../../../../storage/translations/results';
import {TRANSLATION_MAX_BYTES,TRANSLATION_MAX_DIMENSION,TRANSLATION_MAX_PIXELS} from '../../../input/limits';
import {loadTranslationInput} from '../../../input/load';
import {readChannelSettings,updateChannelSettings} from '../../configuration';
import {selectedModelAvailable} from '../../../../../../../backend/shared/translation-models';
import {pageTranslation} from '../../../../reader/presentation';

// These baseline choices keep sign-in and cached views reachable without a network request.
// New requests still require a successful policy refresh; the server enforces its actual limits.
const baselineCapabilities=():Capabilities=>({modes:[
  {id:'classic',label:modeLabels.classic,enabled:true,languages:fallbackLanguages.map(language=>language.id)},
],languages:fallbackLanguages,limits:{max_bytes:TRANSLATION_MAX_BYTES,max_pixels:TRANSLATION_MAX_PIXELS,max_dimension:TRANSLATION_MAX_DIMENSION,max_translation_ids:32},entitlements:null});

export const definition:ChannelDefinition={
  id:'nodelane',label:'NodeLane',configurable:false,fields:[],
  get description(){return msg('使用 NodeLane 官方翻译服务，翻译时需登录账号。');},
  async inspectLocalEntry(entryId){
    const refs=new Map<string,{imageSha256?:string;scope:string;key:string}>(),images=new Set<string>();let after:string|undefined;
    do{
      const records=await readEntryOperations(entryId,after);
      for(const record of records){
        const imageSha256=record.sourceSha256??record.image.sha256;
        const add=(job:Parameters<typeof resultBlobKey>[1])=>{if(job.result){const key=resultBlobKey({key:record.scope},job);refs.set(key,{imageSha256:job.source_image_sha256??imageSha256,scope:record.scope,key});}};
        if(record.result)add(translationJob(record.result,record));
        const imageKey=JSON.stringify([record.scope,imageSha256]);if(images.has(imageKey))continue;images.add(imageKey);
        let jobAfter:string|undefined;
        do{const jobs=await readImageJobsPage(record.scope,imageSha256,jobAfter);jobs.forEach(add);jobAfter=jobs.length===100?jobs.at(-1)!.id:undefined;}while(jobAfter);
      }
      after=records.length===100?records.at(-1)!.id:undefined;
    }while(after);
    return [...refs.values()];
  },
  removeLocalEntry:removeEntryOperations,
  blockLocalEntry:blockEntryOperations,
  subscribe(listener){
    let stopped=false,revision=0;
    const initial=readAuth().then(value=>value.session?.id??null);
    let previous=initial;
    const unsubscribe=subscribeAuth(()=>{
      const request=++revision;
      void(async()=>{
        const before=await previous,next=(await readAuth()).session?.id??null;
        if(stopped||request!==revision)return;
        previous=Promise.resolve(next);
        if(before!==next)listener();
      })();
    });
    return()=>{stopped=true;unsubscribe();};
  },
  async open(profile,_secrets,isCurrent,openOptions){
    const {session}=await readAuth();let disposed=false;
    const live=()=>!disposed&&isCurrent();
    assertCurrent(live);
    const userId=session?.user.id,scope={key:translationScope(API_ORIGIN,userId??'signed-out')};
    const runtimes=new Set<ChannelRuntime>();
    const authorization=session?sessionAuthorization(session.id):undefined;
    const api=new Api(API_BASE,session?.token??'',new RequestPool(UPLOAD_CONCURRENCY),live,authorization);
    let caps=baselineCapabilities(),rights:Entitlements|undefined,policyError='';
    const selectedModel=(await readChannelSettings()).modelPreferences?.[scope.key];
    if(session&&!openOptions?.deferPolicy){
      try{caps=await api.capabilities();rights=await api.entitlements();assertCurrent(live);}
      catch(error){assertCurrent(live);if((await readAuth()).session?.id!==session.id)throw error;policyError=(error as Error).message;}
    }else if(!session&&!openOptions?.deferPolicy){
      try{caps=await api.capabilities();assertCurrent(live);}catch{assertCurrent(live);}
    }
    const connection:ChannelConnection={
      key:JSON.stringify([profile.id,profile.revision,session?.id??null,selectedModel??null]),scope,label:'NodeLane',
      get modelSelection(){return {value:selectedModel,models:caps.translation_models,async select(value?:string){
        assertCurrent(live);
        if(value&&!selectedModelAvailable(caps.translation_models,value))throw Error(msg('此翻译方式暂不可用'));
        await updateChannelSettings(settings=>{const modelPreferences={...settings.modelPreferences};if(value)modelPreferences[scope.key]=value;else delete modelPreferences[scope.key];return {...settings,modelPreferences};});
      }};},
      get capabilities(){return caps;},available:!!session,
      unavailable:session?undefined:{kind:'login',message:msg('登录后自动翻译')},
      requiresInternet:true,allowsFeedback:true,analyticsCategory:'official',isCurrent:live,
      async readResult(job,signal,original){
        assertCurrent(live);if(!session)throw Error(msg('请先登录'));
        // Reading an existing result must never submit a new translation.
        signal?.throwIfAborted();
        await authorization!.current();
        registerResultReader(scope,job,()=>connection.readResult(job,undefined,original));
        const current=()=>live()&&!signal?.aborted;
        const input=async()=>{
          const result=job.delivery;if(!result)return undefined;
          return loadTranslationInput(scope.key,{sha256:result.input_sha256,sourceSha256:job.source_image_sha256,profile:job.input_profile,size:result},async()=>original?.(),current);
        };
        const blob=await loadDeliveredResult({scope,job,original:input,download:()=>api.translationImage(job.id,signal),isCurrent:current});
        await authorization!.current();assertCurrent(live);return blob;
      },
      createRuntime(options:RuntimeOptions){
        let active=true;
        const current=()=>active&&live()&&options.isCurrent();
        const runtimeApi=new Api(API_BASE,session?.token??'',new RequestPool(UPLOAD_CONCURRENCY),current,session?sessionAuthorization(session.id):undefined);
        const modelId=options.modelId??selectedModel;
        const core=userId?new TranslationCoordinator({api:runtimeApi,userId,language:options.language,modelId,canSubmit:target=>!!caps.modes.find(mode=>mode.id===target.mode)?.enabled&&supportsLanguage(caps,target.mode,options.language)&&selectedModelAvailable(caps.translation_models,modelId),onModelRejected:async()=>{const fresh=await runtimeApi.capabilities();assertCurrent(current);caps=fresh;options.onChange();},getBlob:options.getBlob,readOriginal:options.readOriginal,prepareInput:options.prepareInput,limits:()=>caps.limits,tiles:()=>caps.representations?.includes('overlay-tiles-v1')??false,rights:()=>rights,onJobs:options.onJobs,onChange:options.onChange}):undefined;
        const requireCore=()=>{assertCurrent(current);if(!core)throw Error(msg('请先登录'));return core;};
        const runtime:ChannelRuntime={
          async init(){assertCurrent(current);await core?.init();},
          async restore(targets){await requireCore().restore(targets);},
          async submit(targets,requestCurrent=()=>true){
            const official=requireCore();
            // A completed local result is usable without a network policy read.
            if(!rights&&targets.some(target=>!pageTranslation(target.page,target.mode,options.language,scope.key).latest))await runtime.refresh();
            await official.submit(targets,target=>current()&&requestCurrent(target));
          },
          async manual(target){await runtime.refresh();await requireCore().manual(target,current);},
          async wait(signal){if(!core)return false;return core.wait(signal);},
          get hasPending(){return core?.hasPending??false;},
          get waitingIds(){return core?.waitingIds??[];},
          get retryDelay(){return core?.retryDelay??0;},
          stateFor(target,requested,error=''){
            return translationState({page:target.page,mode:target.mode,language:options.language,modelId,userId,origin:API_ORIGIN,active:requested,caps,rights,error:error||policyError,operation:core?.records.find(record=>record.entryId===target.entryId&&record.pageId===target.page.id&&record.mode===target.mode)});
          },
          async refresh(){
            if(!core)return;assertCurrent(current);
            try{
              const capabilities=await runtimeApi.capabilities(),entitlements=await runtimeApi.entitlements();
              assertCurrent(current);caps=capabilities;rights=entitlements;policyError='';
              await core.refreshEntitlements(rights);options.onChange();
            }catch(error){if(current()){policyError=(error as Error).message;options.onChange();}throw error;}
          },
          dispose(){active=false;core?.stopWatching();runtimes.delete(runtime);},
        };
        runtimes.add(runtime);return runtime;
      },
      dispose(){disposed=true;releaseResultReaders(scope);for(const runtime of runtimes)runtime.dispose();runtimes.clear();},
    };
    return connection;
  },
};

export default definition;
