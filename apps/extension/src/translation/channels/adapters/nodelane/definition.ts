import {Api} from '../../../../api';
import {readAuth,subscribeAuth} from '../../../../auth/storage';
import {sessionAuthorization} from '../../../../auth/session';
import {assertCurrent,RequestPool,UPLOAD_CONCURRENCY} from '../../../../concurrency';
import {msg} from '../../../../i18n/runtime';
import {API_BASE,API_ORIGIN} from '../../../../service';
import {fallbackLanguages,modeLabels,type Capabilities,type Entitlements} from '../../../../types';
import type {ChannelDefinition,ChannelConnection,ChannelRuntime,RuntimeOptions} from '../../contracts';
import {TranslationCoordinator} from './coordinator';
import {operationId} from './operations';
import {translationState} from './state';
import {translationScope} from './store';
import {loadResultBlob} from '../../../../storage/translations/results';

// These baseline choices keep sign-in and cached views reachable without a network request.
// New requests still require a successful policy refresh; the server enforces its actual limits.
const baselineCapabilities=():Capabilities=>({modes:[
  {id:'classic',label:modeLabels.classic,enabled:true,languages:fallbackLanguages.map(language=>language.id)},
  {id:'redraw',label:modeLabels.redraw,enabled:true,languages:['zh-Hans','zh-Hant','en','ja','ko']},
],languages:fallbackLanguages,limits:{max_bytes:20*1024*1024,max_pixels:24_000_000,max_dimension:8192,max_translation_ids:32},entitlements:null,retention_days:0});

export const definition:ChannelDefinition={
  id:'nodelane',label:'NodeLane',configurable:false,fields:[],
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
  async open(profile,_secrets,isCurrent){
    const {session}=await readAuth();let disposed=false;
    const live=()=>!disposed&&isCurrent();
    assertCurrent(live);
    const userId=session?.user.id,scope={key:translationScope(API_ORIGIN,userId??'signed-out')};
    const runtimes=new Set<ChannelRuntime>();
    const authorization=session?sessionAuthorization(session.id):undefined;
    const api=new Api(API_BASE,session?.token??'',new RequestPool(UPLOAD_CONCURRENCY),live,authorization);
    let caps=baselineCapabilities(),rights:Entitlements|undefined,policyError='';
    if(session){
      try{[caps,rights]=await Promise.all([api.capabilities(),api.entitlements()]);assertCurrent(live);}
      catch(error){assertCurrent(live);if((await readAuth()).session?.id!==session.id)throw error;policyError=(error as Error).message;}
    }
    const connection:ChannelConnection={
      key:JSON.stringify([profile.id,profile.revision,session?.id??null]),scope,label:'NodeLane',
      get capabilities(){return caps;},available:!!session,
      unavailable:session?undefined:{kind:'login',message:msg('登录后自动翻译')},
      requiresInternet:true,allowsFeedback:true,isCurrent:live,
      async readResult(job,signal){
        assertCurrent(live);if(!session)throw Error(msg('请先登录'));
        // Reading an existing result must never submit a new translation.
        signal?.throwIfAborted();
        await authorization!.current();
        const blob=await loadResultBlob({scope,job,download:()=>api.translationImage(job.id,signal),isCurrent:()=>live()&&!signal?.aborted});
        await authorization!.current();assertCurrent(live);return blob;
      },
      createRuntime(options:RuntimeOptions){
        let active=true;
        const lifetime=new AbortController(),current=()=>active&&live()&&options.isCurrent();
        const runtimeApi=new Api(API_BASE,session?.token??'',new RequestPool(UPLOAD_CONCURRENCY),current,session?sessionAuthorization(session.id):undefined);
        const core=userId?new TranslationCoordinator({api:runtimeApi,userId,language:options.language,getBlob:options.getBlob,readOriginal:options.readOriginal,onInputConsumed:options.onInputConsumed,rights:()=>rights,onJobs:options.onJobs,onChange:options.onChange}):undefined;
        const requireCore=()=>{assertCurrent(current);if(!core)throw Error(msg('请先登录'));return core;};
        const runtime:ChannelRuntime={
          async init(){assertCurrent(current);await core?.init();},
          async submit(targets,requestCurrent=()=>true){const official=requireCore();if(targets.length&&!rights)await runtime.refresh();await official.submit(targets,()=>current()&&requestCurrent());},
          async manual(target){await runtime.refresh();await requireCore().manual(target,current);},
          async wait(signal){if(!core)return false;return core.wait(AbortSignal.any([signal,lifetime.signal]));},
          get hasPending(){return core?.hasPending??false;},
          get waitingIds(){return core?.waitingIds??[];},
          get retryDelay(){return core?.retryDelay??0;},
          stateFor(target,requested,error=''){
            return translationState({page:target.page,mode:target.mode,language:options.language,userId,origin:API_ORIGIN,active:requested,caps,rights,error:error||policyError,operation:core?.records.find(record=>record.id===operationId(scope.key,options.language,target))});
          },
          async refresh(){
            if(!core)return;assertCurrent(current);
            try{
              const [capabilities,entitlements]=await Promise.all([runtimeApi.capabilities(),runtimeApi.entitlements()]);
              assertCurrent(current);caps=capabilities;rights=entitlements;policyError='';
              await core.refreshEntitlements(rights);options.onChange();
            }catch(error){if(current()){policyError=(error as Error).message;options.onChange();}throw error;}
          },
          dispose(){active=false;lifetime.abort();runtimes.delete(runtime);},
        };
        runtimes.add(runtime);return runtime;
      },
      dispose(){disposed=true;for(const runtime of runtimes)runtime.dispose();runtimes.clear();},
    };
    return connection;
  },
};

export default definition;
