import 'fake-indexeddb/auto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {isValidElement,type DependencyList,type EffectCallback,type ImgHTMLAttributes,type ReactElement,type ReactNode,type SetStateAction} from 'react';
import {acquireImage} from '../src/comics/application/image-access';
import {StaleOperation} from '../src/concurrency';
import {ReaderPicture} from '../src/reader/ReaderPicture';
import {readingImage,type ImageLoadState} from '../src/reader/presentation';
import {translationCache} from '../src/storage/translations';
import {loadResultBlob,readMaterializedResult,resultBlobKey,validateMaterializedResult} from '../src/storage/translations/results';
import {needsTranslation} from '../src/translation/automatic';
import type {ChannelConnection,RuntimeOptions,TranslationScope} from '../src/translation/channels/contracts';
import {useAutomaticTranslation} from '../src/translation/useAutomaticTranslation';
import type {Job,ReadingEntry} from '../src/types';
import {job,target} from './translation-fixture';

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
  const session={current:true},download=vi.fn(async():Promise<Blob>=>{throw Error('Unexpected result download');}),translate=vi.fn();
  const runtimes:{options:RuntimeOptions;dispose:ReturnType<typeof vi.fn>;manual:ReturnType<typeof vi.fn>}[]=[];
  const channel:ChannelConnection={key:crypto.randomUUID(),scope,label:'Fixture',available:true,requiresInternet:false,isCurrent:()=>session.current,
    capabilities:{modes:[{id:'classic',label:'Classic',enabled:true}],languages:[{id:'en',label:'English'},{id:'ja',label:'Japanese'}],limits:{max_bytes:1000,max_pixels:1000,max_dimension:1000,max_translation_ids:20},entitlements:null},
    validateResult:vi.fn(async()=>{}),readResult:vi.fn((value:Job)=>loadResultBlob({scope,job:value,isCurrent:()=>session.current,download})),dispose(){},
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
  const render=()=>{
    translation=parent.render(()=>useAutomaticTranslation({channel,copies:[copy],updateEntry:update,language,currentId:copy.id}));
    const selected=readingImage(copy.pages[0],'classic',true,language,channel.scope.key);
    element=picture.render(()=>ReaderPicture({acquire:acquireImage,scope:JSON.stringify([channel.scope.key,language,copy.id]),blobKey:selected.key,originalKey:original,job:selected.job,alt:'Page',onImport(){},onLoadState:state=>{load=state;if(state?.error)failures.push(state.error);}}));
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
