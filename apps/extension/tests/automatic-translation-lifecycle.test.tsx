import 'fake-indexeddb/auto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {isValidElement,type DependencyList,type EffectCallback,type ImgHTMLAttributes,type ReactElement,type ReactNode,type SetStateAction} from 'react';
import {acquireImage} from '../src/comics/application/image-access';
import {StaleOperation} from '../src/concurrency';
import {ReaderPicture} from '../src/reader/ReaderPicture';
import {readingImage,type ImageLoadState} from '../src/reader/presentation';
import {setTranslationCacheLimitMb,translationCache} from '../src/storage/translations';
import {loadResultBlob,readMaterializedResult,resultBlobKey,validateMaterializedResult} from '../src/storage/translations/results';
import {needsTranslation} from '../src/translation/automatic';
import type {ChannelConnection,RuntimeOptions,TranslationScope} from '../src/translation/channels/contracts';
import {TranslationCoordinator} from '../src/translation/channels/adapters/nodelane/coordinator';
import type {PreparedInput} from '../src/translation/input/prepare';
import {useAutomaticTranslation} from '../src/translation/useAutomaticTranslation';
import type {Job,ReadingEntry,TranslationBatch} from '../src/types';
import {fixture as coordinatorFixture,job,originalInput,snapshot,target} from './translation-fixture';

type Action=()=>void;
interface EffectSlot {deps?:DependencyList;cleanup?:Action}
interface StateSlot<T> {value:T;set:(next:SetStateAction<T>)=>void}
interface CallbackSlot<T> {value:T;deps:DependencyList}
const hooks=vi.hoisted(()=>({active:undefined as Frame|undefined}));
vi.mock('react',async original=>{
  const current=()=>{if(!hooks.active)throw Error('Hook outside fixture render');return hooks.active;};
  const changed=(a:DependencyList|undefined,b:DependencyList|undefined)=>!a||!b||a.length!==b.length||a.some((value,index)=>!Object.is(value,b[index]));
  const effect=(create:EffectCallback,deps?:DependencyList,layout=false)=>{
    const frame=current(),index=frame.cursor++,previous=frame.slots[index] as EffectSlot|undefined;
    if(previous&&!changed(previous.deps,deps))return;
    const slot:EffectSlot={deps};frame.slots[index]=slot;
    if(previous?.cleanup)frame.cleanups.push(previous.cleanup);
    (layout?frame.layouts:frame.effects).push(()=>{slot.cleanup=create()||undefined;});
  };
  return {...await original<typeof import('react')>(),
    useState:<T,>(initial:T|(()=>T))=>{
      const frame=current(),index=frame.cursor++;
      let slot=frame.slots[index] as StateSlot<T>|undefined;
      if(!slot){
        const state:StateSlot<T>={value:typeof initial==='function'?(initial as ()=>T)():initial,set(next){
          const value=typeof next==='function'?(next as (previous:T)=>T)(state.value):next;
          if(!Object.is(value,state.value)){state.value=value;frame.dirty=true;}
        }};
        slot=state;frame.slots[index]=slot;
      }
      return [slot.value,slot.set];
    },
    useRef:<T,>(value:T)=>{const frame=current(),index=frame.cursor++;return frame.slots[index]??(frame.slots[index]={current:value});},
    useCallback:<T,>(callback:T,deps:DependencyList)=>{const frame=current(),index=frame.cursor++,old=frame.slots[index] as CallbackSlot<T>|undefined;if(!old||changed(old.deps,deps))frame.slots[index]={value:callback,deps};return (frame.slots[index] as CallbackSlot<T>).value;},
    useEffect:(create:EffectCallback,deps?:DependencyList)=>effect(create,deps),
    useLayoutEffect:(create:EffectCallback,deps?:DependencyList)=>effect(create,deps,true),
  };
});
vi.mock('../src/reader/prepare-image',()=>({prepareReaderImage:vi.fn(async()=>{})}));

/** Like reader-prefetch.test: model React cleanup / child-first effects without a DOM. */
class Frame {
  slots:unknown[]=[];cursor=0;dirty=false;effects:Action[]=[];layouts:Action[]=[];cleanups:Action[]=[];
  render<T>(run:()=>T){this.cursor=0;this.dirty=false;hooks.active=this;try{return run();}finally{hooks.active=undefined;}}
  cleanup(){for(const action of this.cleanups.splice(0))action();}
  create(){for(const action of this.layouts.splice(0))action();for(const action of this.effects.splice(0))action();}
  unmount(){for(const slot of this.slots){const cleanup=(slot as EffectSlot).cleanup;if(cleanup)cleanup();}this.slots=[];}
}
class Visibility extends EventTarget {hidden=false;}
const unmounts:Action[]=[];
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});vi.stubGlobal('document',new Visibility());vi.stubGlobal('window',new EventTarget());vi.stubGlobal('BroadcastChannel',undefined);});
afterEach(async()=>{for(const unmount of unmounts.splice(0))unmount();await translationCache.clear();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

function images(node:ReactNode):ReactElement<ImgHTMLAttributes<HTMLImageElement>>[]{
  if(Array.isArray(node))return node.flatMap(images);
  if(!isValidElement<{children?:ReactNode}>(node))return [];
  return node.type==='img'?[node as ReactElement<ImgHTMLAttributes<HTMLImageElement>>]:images(node.props.children);
}
function channelFixture(scope:TranslationScope={key:crypto.randomUUID()}){
  const session={current:true},download=vi.fn(async(_job:Job,_signal?:AbortSignal):Promise<Blob>=>{throw Error('Unexpected result download');}),translate=vi.fn();
  const runtimes:{options:RuntimeOptions;dispose:ReturnType<typeof vi.fn>;manual:ReturnType<typeof vi.fn>}[]=[];
  const channel:ChannelConnection={key:crypto.randomUUID(),scope,label:'Fixture',available:true,requiresInternet:false,isCurrent:()=>session.current,
    capabilities:{modes:[{id:'classic',label:'Classic',enabled:true}],languages:[{id:'en',label:'English'},{id:'ja',label:'Japanese'}],limits:{max_bytes:1000,max_pixels:1000,max_dimension:1000,max_translation_ids:20},entitlements:null},
    validateResult:vi.fn(async()=>{}),readResult:vi.fn((value:Job,signal?:AbortSignal)=>loadResultBlob({scope,job:value,isCurrent:()=>session.current&&!signal?.aborted,download:()=>download(value,signal)})),dispose(){},
    createRuntime(options){
      const runtime={options,dispose:vi.fn(),manual:vi.fn(async()=>{})};runtimes.push(runtime);
      return {...runtime,init:async()=>{},restore:async()=>{},submit:async targets=>{for(const value of targets)if(needsTranslation(value.page,value.mode,options.language,scope.key))translate(value);},wait:async()=>false,hasPending:false,waitingIds:[],retryDelay:0,stateFor:()=>undefined,refresh:async()=>{}};
    },
  };
  return {channel,session,download,translate,runtimes};
}
async function fixture(){
  const connection=channelFixture(),{scope}=connection.channel;
  const en=job(0,{id:'job-en',status:'succeeded',target_language:'en'}),ja=job(0,{id:'job-ja',status:'succeeded',target_language:'ja'});
  const key=(language:string)=>resultBlobKey(scope,language==='en'?en:ja),original='original:'+scope.key;
  for(const [id,bytes] of [[key('en'),'cached en'],[key('ja'),'cached ja'],[original,'original']])expect(await translationCache.put(id,new Blob([bytes]),{owner:scope.key})).toBe(true);
  const page={...target(0).page,blobKey:original,jobs:[en,ja],translationScope:scope.key};
  let copy:ReadingEntry={id:'book',contentId:'content',title:'Fixture',source:'local',sourceKey:'fixture',generation:1,createdAt:0,updatedAt:0,pages:[page],pageId:page.id,relativeOffset:0,discoveryComplete:true};
  let channel=connection.channel,language='en',translation:ReturnType<typeof useAutomaticTranslation>,load:ImageLoadState|undefined,element:ReactNode,mounted=true;
  const parent=new Frame(),picture=new Frame(),failures:string[]=[];
  const update=(next:ReadingEntry)=>{copy=next;parent.dirty=true;};
  const acquire:Parameters<typeof ReaderPicture>[0]['acquire']=(key,signal,preview)=>acquireImage(key,signal,'current',preview);
  const render=()=>{
    translation=parent.render(()=>useAutomaticTranslation({channel,copies:[copy],updateEntry:update,language,currentId:copy.id}));
    const selected=readingImage(copy.pages[0],'classic',true,language,channel.scope.key);
    element=picture.render(()=>ReaderPicture({acquire,scope:JSON.stringify([channel.scope.key,language,copy.id]),blobKey:selected.key,originalKey:original,job:selected.job,alt:'Page',onImport(){},onLoadState:state=>{load=state;if(state?.error)failures.push(state.error);}}));
    parent.cleanup();picture.cleanup();picture.create();parent.create();
  };
  const settle=async()=>{for(let i=0;i<40;i++){await nextTurn();if(mounted&&(parent.dirty||picture.dirty))render();}};
  const show=async()=>{
    await settle();expect(load?.error).toBeUndefined();
    const pending=images(element).find(image=>image.props.className==='nc-page-image-pending');expect(pending).toBeDefined();
    pending!.props.onLoad!({currentTarget:{naturalWidth:800,naturalHeight:1200}} as React.SyntheticEvent<HTMLImageElement>);
    await settle();expect(load).toMatchObject({key:key(language),phase:'ready'});
  };
  const unmount=()=>{if(!mounted)return;mounted=false;picture.unmount();parent.unmount();};unmounts.push(unmount);
  render();translation!.onReadingWindow([{entryId:copy.id,page,mode:'classic'}],[page]);await show();
  return {...connection,en,ja,key,failures,show,settle,unmount,get copy(){return copy;},get translation(){return translation;},get load(){return load;},switchLanguage(value:string){language=value;render();},replaceChannel(value:ChannelConnection){channel=value;render();}};
}

describe('automatic translation result-reader lifecycle',()=>{
  it('switches en -> ja -> en -> ja from cached results without failures, downloads or regeneration',async()=>{
    const f=await fixture();
    for(const language of ['ja','en','ja']){f.switchLanguage(language);await f.show();await vi.advanceTimersByTimeAsync(0);await f.settle();}
    expect(f.failures).toEqual([]);expect(f.download).not.toHaveBeenCalled();expect(f.translate).not.toHaveBeenCalled();
    expect(f.runtimes).toHaveLength(4);for(const runtime of f.runtimes.slice(0,-1))expect(runtime.dispose).toHaveBeenCalledOnce();
    for(const runtime of f.runtimes)expect(runtime.manual).not.toHaveBeenCalled();
    expect(await(await readMaterializedResult(f.key('en'))).text()).toBe('cached en');
  });
  it.each(['account','same-scope channel'])('unregisters old readers on %s replacement',async replacement=>{
    const f=await fixture(),next=channelFixture(replacement==='account'?undefined:f.channel.scope);
    // Keep the replacement unavailable to inspect cleanup independently of re-registration.
    next.channel.available=false;f.replaceChannel(next.channel);
    await expect(readMaterializedResult(f.key('en'))).rejects.toThrow('Result reader unavailable');
    expect(f.runtimes[0].dispose).toHaveBeenCalledOnce();expect(next.download).not.toHaveBeenCalled();
  });
  it('rechecks channel currentness and authorization before returning cached pixels',async()=>{
    const f=await fixture();f.session.current=false;
    await expect(readMaterializedResult(f.key('en'))).rejects.toThrow(StaleOperation);
    f.session.current=true;vi.mocked(f.channel.validateResult).mockRejectedValueOnce(Error('Access revoked'));
    await expect(readMaterializedResult(f.key('en'))).rejects.toThrow('Access revoked');expect(f.download).not.toHaveBeenCalled();
  });
  it('keeps a known result revocation when the language runtime changes',async()=>{
    const f=await fixture();
    await f.runtimes[0].options.onJobs([{...f.en,result_expired:true,result_available:false}]);
    f.switchLanguage('ja');
    // Validate before the next snapshot reconciliation removes the expired key.
    await expect(validateMaterializedResult(f.key('en'))).rejects.toThrow('图片已过期或无法访问');
    await f.settle();
    expect(f.download).not.toHaveBeenCalled();
  });
  it('releases both languages and their published references when the page leaves the reading window',async()=>{
    const f=await fixture();f.switchLanguage('ja');await f.show();
    f.translation.onReadingWindow([],[]);await f.settle();
    for(const language of ['en','ja'])await expect(readMaterializedResult(f.key(language))).rejects.toThrow('Result reader unavailable');
    expect(f.copy.pages[0].outputBlobs).toEqual({});
  });
  it('releases readers on unmount and does not publish a pending registration afterwards',async()=>{
    const f=await fixture(),authorization=Promise.withResolvers<void>();
    vi.mocked(f.channel.validateResult).mockImplementation(()=>authorization.promise);
    f.switchLanguage('ja');await f.settle();f.unmount();authorization.resolve();await f.settle();
    for(const language of ['en','ja'])await expect(readMaterializedResult(f.key(language))).rejects.toThrow('Result reader unavailable');
    for(const runtime of f.runtimes)expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});

async function prefetchFixture(){
  const connection=channelFixture(),{scope}=connection.channel,frame=new Frame();
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:800,height:1200,close(){}})));
  connection.download.mockResolvedValue(new Blob(['complete translation'],{type:'image/png'}));
  let copy:ReadingEntry={id:'book',contentId:'content',title:'Prefetch',source:'local',sourceKey:'fixture',generation:1,createdAt:0,updatedAt:0,pageId:'page-0',relativeOffset:0,discoveryComplete:true,
    pages:Array.from({length:7},(_,n)=>({...target(n).page,translationScope:scope.key,jobs:[job(n,{target_language:'en'})]}))};
  let translation:ReturnType<typeof useAutomaticTranslation>,mounted=true;
  const update=(next:ReadingEntry)=>{copy=next;frame.dirty=true;};
  const render=()=>{translation=frame.render(()=>useAutomaticTranslation({channel:connection.channel,copies:[copy],updateEntry:update,language:'en',currentId:copy.id}));frame.cleanup();frame.create();};
  const settle=async()=>{for(let i=0;i<40;i++){await nextTurn();if(mounted&&frame.dirty)render();}};
  const window=(indexes:number[])=>translation.onReadingWindow(indexes.map(n=>({entryId:copy.id,page:copy.pages[n],mode:'classic'})),[copy.pages[0]]);
  const emit=async(...values:Job[])=>{const runtime=connection.runtimes.at(-1)!;await runtime.options.onJobs(values);runtime.options.onChange();await settle();};
  const unmount=()=>{if(mounted){mounted=false;frame.unmount();}};unmounts.push(unmount);
  render();window([0,1,2,3]);await settle();
  return {...connection,emit,settle,window,unmount,key:(n:number)=>resultBlobKey(scope,job(n,{status:'succeeded'})),get copy(){return copy;}};
}
const completed=(n:number,extra:Partial<Job>={})=>job(n,{status:'succeeded',target_language:'en',...extra});

describe('automatic translation result prefetch',()=>{
  it('persists a completed offscreen result before display and reuses it without another download',async()=>{
    const f=await prefetchFixture();await f.emit(completed(1));
    expect(await translationCache.has(f.key(1))).toBe(true);
    expect(f.copy.pages[1].outputBlobs['job-1']).toBe(f.key(1));
    expect(f.copy.pages[1]).toMatchObject({blobKey:'blob-1',width:800,height:1200});
    await f.emit(completed(1));expect(f.download).toHaveBeenCalledOnce();
    const lease=await acquireImage(f.key(1));expect(await lease.blob.text()).toBe('complete translation');lease.release();
    expect(f.download).toHaveBeenCalledOnce();expect(f.translate).not.toHaveBeenCalled();
  });

  it('only warms the current language and requested window, excluding no-text and revoked results',async()=>{
    const f=await prefetchFixture();f.window([0,1,2,3,4,5]);
    await f.emit(completed(0,{status:'no_text'}),completed(1,{target_language:'ja'}),completed(2,{result_expired:true,result_available:false}),completed(3),completed(4),completed(5),completed(6));
    expect(f.download.mock.calls.map(([job])=>job.id)).toEqual(['job-3','job-4']);
    f.window([]);await f.settle();await f.emit(completed(1));
    expect(f.download).toHaveBeenCalledTimes(2);
  });

  it('leaves a failed prefetch successful and lets display retry the same result independently',async()=>{
    const f=await prefetchFixture();f.download.mockRejectedValueOnce(Error('download unavailable'));
    await f.emit(completed(1),completed(2));await f.emit(completed(1),completed(2));
    expect(f.download.mock.calls.map(([job])=>job.id)).toEqual(['job-1','job-2']);
    expect(f.copy.pages[1].jobs[0].status).toBe('succeeded');expect(f.copy.pages[1].translationError).toBeUndefined();
    expect(await translationCache.has(f.key(1))).toBe(false);expect(await translationCache.has(f.key(2))).toBe(true);
    await readMaterializedResult(f.key(1));expect(f.download.mock.calls.map(([job])=>job.id)).toEqual(['job-1','job-2','job-1']);
    expect(f.translate).not.toHaveBeenCalled();expect(f.runtimes[0].manual).not.toHaveBeenCalled();
  });

  it.each(['leave','hidden','unmount','account'])('does not cache a late result after %s',async reason=>{
    const f=await prefetchFixture(),pending=Promise.withResolvers<Blob>();f.download.mockImplementationOnce(()=>pending.promise);
    await f.emit(completed(1),completed(2));expect(f.download).toHaveBeenCalledOnce();
    if(reason==='leave')f.window([]);
    else if(reason==='hidden'){(document as unknown as Visibility).hidden=true;document.dispatchEvent(new Event('visibilitychange'));}
    else if(reason==='account'){f.session.current=false;f.unmount();}
    else f.unmount();
    expect(f.download.mock.calls[0][1]?.aborted).toBe(true);
    pending.resolve(new Blob(['late translation']));await f.settle();
    expect(await translationCache.has(f.key(1))).toBe(false);expect(f.download).toHaveBeenCalledOnce();
    if(reason==='hidden'){
      (document as unknown as Visibility).hidden=false;document.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(0);await f.settle();
      expect(await translationCache.has(f.key(1))).toBe(true);expect(await translationCache.has(f.key(2))).toBe(true);
    }
  });

  it('shares an in-flight prefetch with foreground display instead of downloading twice',async()=>{
    const f=await prefetchFixture(),pending=Promise.withResolvers<Blob>();f.download.mockImplementationOnce(()=>pending.promise);
    await f.emit(completed(1));const shown=readMaterializedResult(f.key(1));await f.settle();
    expect(f.download).toHaveBeenCalledOnce();pending.resolve(new Blob(['shared translation']));
    expect(await(await shown).text()).toBe('shared translation');expect(f.download).toHaveBeenCalledOnce();
  });

  it.each([true,false])('honors the channel internet requirement (%s) while offline',async requiresInternet=>{
    const f=await prefetchFixture();f.channel.requiresInternet=requiresInternet;vi.stubGlobal('navigator',{onLine:false});
    window.dispatchEvent(new Event('offline'));await f.emit(completed(1));
    expect(f.download).toHaveBeenCalledTimes(requiresInternet?0:1);
    vi.stubGlobal('navigator',{onLine:true});window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);await f.settle();
    expect(await translationCache.has(f.key(1))).toBe(true);expect(f.download).toHaveBeenCalledOnce();
  });

  it('lets foreground display recover when its shared prefetch is cancelled',async()=>{
    const f=await prefetchFixture(),pending=Promise.withResolvers<Blob>();f.download.mockImplementationOnce(()=>pending.promise);
    await f.emit(completed(0));const shown=readMaterializedResult(f.key(0));await f.settle();
    f.window([]);pending.resolve(new Blob(['cancelled']));
    expect(await(await shown).text()).toBe('complete translation');expect(f.download).toHaveBeenCalledTimes(2);
    expect(f.translate).not.toHaveBeenCalled();
  });

  it('does not restore a cache entry cleared during prefetch',async()=>{
    const f=await prefetchFixture(),pending=Promise.withResolvers<Blob>();f.download.mockImplementationOnce(()=>pending.promise);
    await f.emit(completed(1));await translationCache.clear();pending.resolve(new Blob(['deleted']));await f.settle();
    await f.emit(completed(1));expect(await translationCache.has(f.key(1))).toBe(false);expect(f.download).toHaveBeenCalledOnce();
    expect(await(await readMaterializedResult(f.key(1))).text()).toBe('complete translation');expect(f.download).toHaveBeenCalledTimes(2);
  });

  it('respects a zero disk budget while reusing bounded session bytes for display',async()=>{
    const f=await prefetchFixture(),budget=(await translationCache.usage()).budgetBytes;
    try{
      await setTranslationCacheLimitMb(0);await f.emit(completed(1));
      expect(await translationCache.has(f.key(1))).toBe(false);
      expect(await(await readMaterializedResult(f.key(1))).text()).toBe('complete translation');expect(f.download).toHaveBeenCalledOnce();
    }finally{await setTranslationCacheLimitMb(budget===Infinity?-1:budget/1024**2);}
  });
});

/** Exercise real persisted intents and SSE scheduling together, including overlapping warmup ticks. */
async function schedulingFixture(prepare:(page:number,signal?:AbortSignal)=>Promise<PreparedInput>,indexes=[0,1,2,3]){
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance','Date']});
  const f=coordinatorFixture(),connection=channelFixture({key:f.core.scope}),frame=new Frame();
  const streams=new Set<{ids:string[];deliver:(batch:TranslationBatch|undefined)=>void}>();
  vi.mocked(f.api.translationEvents).mockImplementation(async function*(ids,signal){
    const stream={ids,deliver:(_batch:TranslationBatch|undefined)=>{}};streams.add(stream);
    try{while(!signal.aborted){
      const event=Promise.withResolvers<TranslationBatch|undefined>();stream.deliver=event.resolve;
      const abort=()=>event.resolve(undefined);signal.addEventListener('abort',abort,{once:true});
      const batch=await event.promise;signal.removeEventListener('abort',abort);
      if(!batch)return;yield batch;
    }}finally{streams.delete(stream);}
  });
  const preparation=vi.fn(prepare);let core!:TranslationCoordinator,options!:RuntimeOptions,submit!:ReturnType<typeof vi.spyOn>;
  connection.channel.createRuntime=value=>{
    options=value;f.api.isCurrent=value.isCurrent;
    core=new TranslationCoordinator({api:f.api,userId:f.userId,language:value.language,getBlob:value.getBlob,rights:()=>f.rights,onJobs:value.onJobs,onChange:value.onChange,
      prepareInput:(target,_current,_limits,signal)=>preparation(Number(target.page.id.replace('page-','')),signal)});
    submit=vi.spyOn(core,'submit');
    return {init:()=>core.init(),restore:targets=>core.restore(targets),submit:(...args)=>core.submit(...args),manual:target=>core.manual(target),wait:signal=>core.wait(signal),
      get hasPending(){return core.hasPending;},get waitingIds(){return core.waitingIds;},get retryDelay(){return core.retryDelay;},stateFor:()=>undefined,refresh:async()=>{},dispose:()=>core.stopWatching()};
  };
  let copy:ReadingEntry={id:'book',contentId:'content',title:'Scheduling',source:'local',sourceKey:'fixture',generation:1,createdAt:0,updatedAt:0,pageId:'page-0',relativeOffset:0,discoveryComplete:true,
    pages:Array.from({length:8},(_,n)=>target(n).page)};
  let translation!:ReturnType<typeof useAutomaticTranslation>,mounted=true,renders=0;
  const update=(next:ReadingEntry)=>{copy=next;frame.dirty=true;};
  const render=()=>{renders++;translation=frame.render(()=>useAutomaticTranslation({channel:connection.channel,copies:[copy],updateEntry:update,language:'en',currentId:copy.id}));frame.cleanup();frame.create();};
  const settle=async()=>{for(let i=0;i<60;i++){await nextTurn();if(mounted&&frame.dirty)render();}};
  const advance=async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);await settle();await vi.advanceTimersByTimeAsync(0);await settle();};
  const window=(indexes:number[],visible=copy.pages)=>translation.onReadingWindow(indexes.map(n=>({entryId:copy.id,page:copy.pages[n],mode:'classic'})),visible);
  const unmount=()=>{if(mounted){mounted=false;frame.unmount();}};unmounts.push(unmount);
  const submitted=()=>f.submit.mock.calls.map(([,body])=>Number(copy.pages.find(page=>'image' in body&&page.imageSha256===body.image.sha256)!.id.replace('page-','')));
  render();window(indexes);await settle();await advance(0);
  return {...f,...connection,preparation,settle,advance,window,unmount,submitted,streams,get core(){return core;},get options(){return options;},get submissions(){return submit.mock.calls.length;},get renders(){return renders;},get copy(){return copy;}};
}

describe('automatic translation scheduling',()=>{
  it('does not lose the successor tick when the warmup deadline passes between selecting targets and scheduling',async()=>{
    const f=await schedulingFixture(async n=>originalInput(n),[0,1,2,3,4,5,6]);
    expect(f.submitted()).toEqual([0]);
    vi.spyOn(performance,'now').mockReturnValueOnce(149.8).mockReturnValueOnce(149.9).mockReturnValue(150);
    await f.advance(150);await f.advance(1);
    expect(f.submitted()).toEqual([0,1,2,3,4,5,6]);
  });

  it('observes submitted pages while another source is slow or failed, then advances without waiting for the old window',async()=>{
    const held=Promise.withResolvers<PreparedInput>();
    const f=await schedulingFixture(async n=>{if(n===1)return held.promise;if(n===2)throw Error('Source unavailable');return originalInput(n);},[0,1,2,3,4,5,6]);
    expect(f.submitted()).toEqual([0]);expect([...f.streams].some(stream=>stream.ids.includes(f.submit.mock.calls[0][0]))).toBe(true);
    await f.advance(150);expect(f.submitted()).toEqual([0,3,4,5,6]);expect(f.copy.pages[2].translationError).toBe('Source unavailable');
    const [id,body]=f.submit.mock.calls[0],stream=[...f.streams].find(stream=>stream.ids.includes(id))!;
    stream.deliver({items:[snapshot(id,body,{state:'running'})],missing_ids:[]});await f.settle();
    expect(f.copy.pages[0].jobs[0].status).toBe('running');
    f.window([7]);await f.advance(150);expect(f.submitted()).toEqual([0,3,4,5,6,7]);
    expect(f.preparation.mock.calls.find(([n])=>n===1)![1]?.aborted).toBe(true);
    held.resolve(originalInput(1));await f.settle();expect(f.submitted()).toEqual([0,3,4,5,6,7]);
    expect([...f.streams].every(stream=>stream.ids.includes(f.submit.mock.calls.at(-1)![0]))).toBe(true);
  });

  it('expires warmup while the first page is slow, retains both current pages and five successors, and never admits an eighth target',async()=>{
    const held=Promise.withResolvers<PreparedInput>(),f=await schedulingFixture(async n=>n===0?held.promise:originalInput(n),[0,1,2,3,4,5,6,7]);
    expect(f.submitted()).toEqual([]);await f.advance(150);
    expect(f.submitted()).toEqual([1,2,3,4,5,6]);expect(f.preparation.mock.calls.map(([n])=>n)).toEqual([0,1,2,3,4,5,6]);
    held.resolve(originalInput(0));await f.settle();expect(f.submitted()).toEqual([1,2,3,4,5,6,0]);
    expect(f.copy.pages[7].jobs).toEqual([]);
  });

  it('limits preparation to five active pages and cancels the queued old tail when the window changes',async()=>{
    const held=Array.from({length:7},()=>Promise.withResolvers<PreparedInput>());
    const f=await schedulingFixture(async n=>held[n]?.promise??originalInput(n),[0,1,2,3,4,5,6]);
    await f.advance(150);expect(f.preparation.mock.calls.map(([n])=>n)).toEqual([0,1,2,3,4]);
    held[1].resolve(originalInput(1));await f.settle();
    expect(f.submitted()).toEqual([1]);expect(f.preparation.mock.calls.map(([n])=>n)).toEqual([0,1,2,3,4,5]);
    f.window([7]);await f.advance(150);
    expect(f.submitted()).toEqual([1,7]);expect(f.preparation.mock.calls.map(([n])=>n)).toEqual([0,1,2,3,4,5,7]);
    for(const [n,signal] of f.preparation.mock.calls)if(n<7)expect(signal?.aborted).toBe(true);
    held.forEach((value,n)=>value.resolve(originalInput(n)));await f.settle();expect(f.submitted()).toEqual([1,7]);
  });

  it('stays idle after admission instead of resubmitting on coordinator notifications',async()=>{
    const f=await schedulingFixture(async n=>originalInput(n));await f.advance(150);
    expect(f.submitted()).toEqual([0,1,2,3]);const count=f.submissions,requests=f.submit.mock.calls.length,renders=f.renders;
    await f.advance(5000);expect(f.submissions).toBe(count);expect(f.renders).toBe(renders);
    for(let i=0;i<10;i++)f.options.onChange();await f.advance(0);
    expect(f.submissions).toBe(count);expect(f.submit).toHaveBeenCalledTimes(requests);expect(f.streams.size).toBe(1);
  });

  it('does not cancel preparation or reconnect SSE when only display resources change',async()=>{
    const held=Promise.withResolvers<PreparedInput>(),f=await schedulingFixture(async n=>n===1?held.promise:originalInput(n));
    await f.advance(150);const signal=f.preparation.mock.calls.find(([n])=>n===1)![1],streams=[...f.streams];
    f.window([0,1,2,3],[{...f.copy.pages[0],blobKey:'new-display-reference'}]);await f.advance(0);
    expect(signal?.aborted).toBe(false);expect([...f.streams]).toEqual(streams);
    expect(f.preparation.mock.calls.filter(([n])=>n===1)).toHaveLength(1);
    held.resolve(originalInput(1));await f.settle();expect(f.submitted()).toEqual([0,2,3,1]);
  });

  it('recovers the same UUID after leaving a window during admission without blocking the next page',async()=>{
    const f=await schedulingFixture(async n=>originalInput(n),[0]),held=Promise.withResolvers<ReturnType<typeof snapshot>>();
    f.submit.mockImplementationOnce(()=>held.promise);
    f.window([5]);await f.advance(80);const [id,body,signal]=f.submit.mock.calls.at(-1)!;
    expect(f.submitted()).toEqual([0,5]);
    f.window([6]);await f.advance(80);expect(signal?.aborted).toBe(true);expect(f.submitted()).toEqual([0,5,6]);
    const accepted=snapshot(id,body,{state:'running'});held.resolve(accepted);await f.settle();
    vi.mocked(f.api.translations).mockImplementation(async ids=>({items:ids.includes(id)?[accepted]:[],missing_ids:ids.filter(value=>value!==id),unchanged:false as const,etag:'"recovered"'}));
    f.window([5]);await f.advance(2001);
    expect(f.copy.pages[5].jobs[0]).toMatchObject({id,status:'running'});
    expect(f.submit.mock.calls.filter(([value])=>value===id)).toHaveLength(1);
  });

  it.each(['hidden','offline','unmount'])('releases preparation on %s and ignores late bytes',async reason=>{
    const held=Promise.withResolvers<PreparedInput>(),f=await schedulingFixture(async n=>n===0?held.promise:originalInput(n));
    if(reason==='hidden'){(document as unknown as Visibility).hidden=true;document.dispatchEvent(new Event('visibilitychange'));}
    else if(reason==='offline'){f.channel.requiresInternet=true;vi.stubGlobal('navigator',{onLine:false});window.dispatchEvent(new Event('offline'));}
    else f.unmount();
    expect(f.preparation.mock.calls[0][1]?.aborted).toBe(true);
    if(reason!=='unmount'){
      f.window([6]);
      if(reason==='hidden'){(document as unknown as Visibility).hidden=false;document.dispatchEvent(new Event('visibilitychange'));}
      else{vi.stubGlobal('navigator',{onLine:true});window.dispatchEvent(new Event('online'));}
      await f.advance(80);expect(f.submitted()).toEqual([6]);
    }
    held.resolve(originalInput(0));await f.settle();expect(f.submitted()).toEqual(reason==='unmount'?[]:[6]);
  });
});
