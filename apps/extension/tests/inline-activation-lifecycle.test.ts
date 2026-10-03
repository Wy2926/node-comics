import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ChannelConnection,ChannelRuntime,RuntimeOptions} from '../src/translation/channels/contracts';

const mocks=vi.hoisted(()=>({
  getTab:vi.fn(),tabMessage:vi.fn(),localSettings:vi.fn(),openChannel:vi.fn(),init:vi.fn(),
  automatic:vi.fn(),registerAutomatic:vi.fn(),subscribe:vi.fn(),readImage:vi.fn(),prepareImage:vi.fn(),
}));
vi.mock('../src/i18n/runtime',()=>({msg:(text:string)=>text}));
vi.mock('../src/inline/auto-tabs',()=>({automaticTabsAllowed:mocks.automatic,registerAutomaticTabs:mocks.registerAutomatic}));
vi.mock('../src/inline/theme',()=>({registerInlineThemeBackground:()=>{}}));
vi.mock('../src/inline/originals',()=>({InlineOriginals:class {
  async read(){} async remember(){} async uploaded(){} clear(){} forget(){}
}}));
vi.mock('../src/sources',()=>({
  safeImageUrl:(url:string)=>url.startsWith('https://')?url:undefined,readInlineSourceImage:mocks.readImage,
  inlineImageSize:()=>true,isImageReferrerPolicy:()=>true,ImagePermissionsRequired:class extends Error {},
}));
vi.mock('../src/comics/pages/normalize',()=>({prepareComicPage:mocks.prepareImage}));
vi.mock('../src/translation/channels',()=>({openActiveChannel:mocks.openChannel,subscribeChannels:mocks.subscribe}));

type Listener=(message:unknown,sender:chrome.runtime.MessageSender,respond:(value:Reply)=>void)=>unknown;
type Reply={ok:boolean;data?:unknown;error?:string};
const url='https://source.test/chapter';
const tab={id:7,url,active:true,windowId:1} as chrome.tabs.Tab;
const sender:chrome.runtime.MessageSender={id:'test',url,frameId:0,documentId:'doc-7',tab};
const request=(generation=1)=>({type:'NC_INLINE_TICK',navigationId:'nav-7',generation,
  images:[{id:'image-7',url:'https://source.test/image.png',width:500,height:700}]});
const gate=()=>{let finish!:()=>void;const promise=new Promise<void>(resolve=>{finish=resolve;});return {promise,finish};};
let listener:Listener,removed:(id:number)=>void;
let session:Record<string,unknown>,cores:ChannelRuntime[],channels:ChannelConnection[],options:RuntimeOptions[];
let background:typeof import('../src/inline/background');
let locks:ReturnType<typeof vi.fn<(name:string,run:()=>Promise<unknown>)=>Promise<unknown>>>;
const send=(message:unknown)=>new Promise<Reply|undefined>(resolve=>{if(listener(message,sender,resolve)!==true)resolve(undefined);});

beforeEach(async()=>{
  vi.resetModules();vi.clearAllMocks();cores=[];channels=[];options=[];
  session={'nc-inline:7':{url,navigationId:'nav-7',documentId:'doc-7',automatic:false}};
  mocks.getTab.mockImplementation(async()=>({...tab}));
  mocks.tabMessage.mockImplementation(async(_id:number,message:{type:string})=>message.type==='NC_REGION_IDENTITY'
    ?{url,enabled:false}:{url,navigationId:'nav-7',enabled:false});
  mocks.localSettings.mockResolvedValue({'nc-reader-settings':{language:'zh-Hans'}});
  mocks.automatic.mockResolvedValue(true);mocks.init.mockResolvedValue(undefined);
  const image=new Blob(['synthetic inline source'],{type:'image/png'});
  mocks.readImage.mockResolvedValue(image);
  mocks.prepareImage.mockResolvedValue({blob:image,width:500,height:700,imageSha256:'a'.repeat(64)});
  mocks.openChannel.mockImplementation(async(current:()=>boolean)=>{
    let disposed=false;
    const core:ChannelRuntime={init:mocks.init,submit:vi.fn(async()=>{}),manual:vi.fn(async()=>{}),wait:vi.fn(async()=>false),
      hasPending:false,waitingIds:[],retryDelay:0,stateFor:vi.fn(),refresh:vi.fn(async()=>{}),dispose:vi.fn()};
    const channel:ChannelConnection={key:'test-channel',scope:{key:'test-scope'},label:'Fixture',
      capabilities:{modes:[{id:'classic',label:'Classic',enabled:true,languages:['zh-Hans']}],languages:[{id:'zh-Hans',label:'Chinese'}],
        limits:{max_bytes:40000000,max_pixels:60000000,max_dimension:20000,max_translation_ids:32},entitlements:null},
      available:true,requiresInternet:true,allowsFeedback:false,isCurrent:()=>!disposed&&current(),
      createRuntime:vi.fn((value:RuntimeOptions)=>{options.push(value);return core;}),readResult:vi.fn(),dispose:vi.fn(()=>{disposed=true;})};
    cores.push(core);channels.push(channel);return channel;
  });
  const tails=new Map<string,Promise<unknown>>();
  locks=vi.fn((name:string,run:()=>Promise<unknown>)=>{
    const pending=(tails.get(name)??Promise.resolve()).then(run);
    tails.set(name,pending.catch(()=>{}));return pending;
  });
  vi.stubGlobal('navigator',{locks:{request:locks}});
  vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('No external requests allowed');}));
  vi.stubGlobal('chrome',{
    runtime:{id:'test',getURL:(path:string)=>'chrome-extension://test/'+path,
      onMessage:{addListener(fn:Listener){listener=fn;}},onConnect:{addListener(){}}},
    storage:{local:{get:mocks.localSettings},session:{
      get:async(key:string)=>structuredClone({[key]:session[key]}),set:async(value:Record<string,unknown>)=>Object.assign(session,structuredClone(value)),
      remove:async(key:string)=>{delete session[key];}},onChanged:{addListener(){}}},
    tabs:{get:mocks.getTab,sendMessage:mocks.tabMessage,create:vi.fn(),query:async()=>[],onRemoved:{addListener(fn:typeof removed){removed=fn;}}},
    scripting:{executeScript:vi.fn(async()=>[{documentId:'doc-7'}])},
  });
  background=await import('../src/inline/background');background.registerInlineBackground();
});
afterEach(()=>{vi.unstubAllGlobals();});

describe('inline activation lifetime',()=>{
  it('admits prepared images incrementally and preserves the whole five-image window',async()=>{
    const pending=gate();let number=0;
    mocks.prepareImage.mockImplementation(async({blob}:{blob:Blob})=>({blob,width:500,height:700,imageSha256:String(++number).repeat(64)}));
    mocks.readImage.mockImplementation(async(url:string)=>{if(url.endsWith('/2.png'))await pending.promise;return new Blob([url]);});
    const images=Array.from({length:5},(_,i)=>({id:`image-${i}`,url:`https://source.test/${i}.png`,width:500,height:700}));
    const response=send({...request(),images});
    await vi.waitFor(()=>expect(mocks.readImage).toHaveBeenCalledTimes(3));
    expect(cores[0].submit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cores[0].submit).mock.calls.map(([targets])=>targets.length)).toEqual([1,2]);
    pending.finish();expect(await response).toMatchObject({ok:true});
    expect(vi.mocked(cores[0].submit).mock.calls.map(([targets])=>targets.length)).toEqual([1,2,3,4,5]);
    expect(await send({...request(),images})).toMatchObject({ok:true});
    expect(mocks.readImage).toHaveBeenCalledTimes(5);expect(cores[0].submit).toHaveBeenCalledTimes(6);
    expect(await send({...request(),images:[...images,{...images[0],id:'sixth'}]})).toMatchObject({ok:false});
  });
  it('stops old source preparation after a jump without reading its remaining tail',async()=>{
    const pending=gate();mocks.readImage.mockImplementationOnce(async()=>{await pending.promise;return new Blob(['old']);});
    const images=Array.from({length:5},(_,i)=>({id:`image-${i}`,url:`https://source.test/${i}.png`,width:500,height:700}));
    const old=send({...request(),images});await vi.waitFor(()=>expect(mocks.readImage).toHaveBeenCalledOnce());
    await send({type:'NC_INLINE_INVALIDATE',navigationId:'nav-7',generation:2});
    pending.finish();expect(await old).toMatchObject({ok:false});
    expect(mocks.prepareImage).not.toHaveBeenCalled();expect(mocks.readImage).toHaveBeenCalledOnce();expect(cores[0].submit).not.toHaveBeenCalled();
    expect(await send(request(2))).toMatchObject({ok:true});expect(cores[0].submit).toHaveBeenCalledOnce();
  });
  it('rejects an authorization that resumes from tabs.get after region suspension',async()=>{
    const pending=gate();mocks.getTab.mockImplementationOnce(async()=>{await pending.promise;return {...tab};});
    const response=send(request());await vi.waitFor(()=>expect(mocks.getTab).toHaveBeenCalledOnce());
    await background.suspendInline(7);pending.finish();
    expect(await response).toMatchObject({ok:false});expect(session['nc-inline:7']).toBeUndefined();
    expect(mocks.openChannel).not.toHaveBeenCalled();expect(mocks.readImage).not.toHaveBeenCalled();
  });

  it.each(['nc-inline-step:7','nc-inline-context:7'])('rejects an old request queued on %s before opening a channel',async name=>{
    const pending=gate(),holding=locks(name,()=>pending.promise),response=send(request());
    await vi.waitFor(()=>expect(locks.mock.calls.filter(([key])=>key===name)).toHaveLength(2));
    await background.suspendInline(7);pending.finish();await holding;
    expect(await response).toMatchObject({ok:false});expect(mocks.openChannel).not.toHaveBeenCalled();
  });

  it('does not deadlock or restore legacy activation when region suspension owns the activation lock',async()=>{
    session['nc-inline:7']={url,navigationId:'nav-7',automatic:false};
    let old!:ReturnType<typeof send>;
    await locks('nc-inline-activation:7',async()=>{
      old=send(request());
      await vi.waitFor(()=>expect(locks.mock.calls.filter(([name])=>name==='nc-inline-activation:7')).toHaveLength(2));
      await background.suspendInline(7);
    });
    expect(await old).toMatchObject({ok:false});expect(session['nc-inline:7']).toBeUndefined();
    expect(mocks.openChannel).not.toHaveBeenCalled();
  });

  it.each(['settings','channel','init'])('discards context creation suspended while awaiting %s',async stage=>{
    const pending=gate();
    if(stage==='settings')mocks.localSettings.mockImplementationOnce(async()=>{await pending.promise;return {'nc-reader-settings':{language:'zh-Hans'}};});
    else if(stage==='channel'){
      const open=mocks.openChannel.getMockImplementation()!;
      mocks.openChannel.mockImplementationOnce(async(current:()=>boolean)=>{const channel=await open(current);await pending.promise;return channel;});
    }else mocks.init.mockImplementationOnce(()=>pending.promise);
    const response=send(request());
    await vi.waitFor(()=>expect(stage==='settings'?mocks.localSettings:stage==='channel'?mocks.openChannel:mocks.init).toHaveBeenCalledOnce());
    await background.suspendInline(7);pending.finish();
    expect(await response).toMatchObject({ok:false});expect(mocks.readImage).not.toHaveBeenCalled();
    if(stage==='settings')expect(mocks.openChannel).not.toHaveBeenCalled();
    else{
      expect(channels[0].dispose).toHaveBeenCalledOnce();expect(channels[0].isCurrent()).toBe(false);
      expect(cores[0].submit).not.toHaveBeenCalled();
    }
    await background.suspendInline(7);
    if(stage!=='settings')expect(channels[0].dispose).toHaveBeenCalledOnce();
  });

  it('repeated activation rejects earlier authorization but accepts a fresh request with the same document and generation',async()=>{
    const pending=gate();mocks.getTab.mockImplementationOnce(async()=>{await pending.promise;return {...tab};});
    const old=send(request());await vi.waitFor(()=>expect(mocks.getTab).toHaveBeenCalledOnce());
    await background.activateInline(7);pending.finish();
    expect(await old).toMatchObject({ok:false});expect(mocks.openChannel).not.toHaveBeenCalled();
    expect(await send(request())).toMatchObject({ok:true});expect(cores[0].submit).toHaveBeenCalledOnce();
    expect(mocks.tabMessage).toHaveBeenCalledWith(7,{type:'NC_INLINE_START',automatic:false},{frameId:0,documentId:'doc-7'});
  });

  it.each(['authorization','channel'])('a newer close/pause generation stops old %s without reviving work',async stage=>{
    const pending=gate();
    if(stage==='authorization')mocks.getTab.mockImplementationOnce(async()=>{await pending.promise;return {...tab};});
    else{
      const open=mocks.openChannel.getMockImplementation()!;
      mocks.openChannel.mockImplementationOnce(async(current:()=>boolean)=>{const channel=await open(current);await pending.promise;return channel;});
    }
    const old=send(request());await vi.waitFor(()=>expect(stage==='authorization'?mocks.getTab:mocks.openChannel).toHaveBeenCalledOnce());
    expect(await send({type:'NC_INLINE_INVALIDATE',navigationId:'nav-7',generation:2})).toMatchObject({ok:true});
    pending.finish();expect(await old).toMatchObject({ok:false});
    if(stage==='authorization')expect(mocks.openChannel).not.toHaveBeenCalled();
    else{expect(channels[0].dispose).toHaveBeenCalledOnce();expect(cores[0].submit).not.toHaveBeenCalled();}
  });

  it('closing a tab fences old authorization and removes its saved activation',async()=>{
    const pending=gate();mocks.getTab.mockImplementationOnce(async()=>{await pending.promise;return {...tab};});
    const old=send(request());await vi.waitFor(()=>expect(mocks.getTab).toHaveBeenCalledOnce());
    removed(7);pending.finish();expect(await old).toMatchObject({ok:false});
    await vi.waitFor(()=>expect(session['nc-inline:7']).toBeUndefined());expect(mocks.openChannel).not.toHaveBeenCalled();
  });

  it('stopping automatic translation invalidates an in-flight authorized document',async()=>{
    session['nc-inline:7']={url,navigationId:'nav-7',documentId:'doc-7',automatic:true};
    const pending=gate();mocks.getTab.mockImplementationOnce(async()=>{await pending.promise;return {...tab};});
    const old=send(request());await vi.waitFor(()=>expect(mocks.getTab).toHaveBeenCalledOnce());
    mocks.automatic.mockResolvedValue(false);await mocks.registerAutomatic.mock.calls[0][1](7);pending.finish();
    expect(await old).toMatchObject({ok:false});expect(session['nc-inline:7']).toBeUndefined();expect(mocks.openChannel).not.toHaveBeenCalled();
  });

  it('keeps normal activation and reading-window updates on one channel, then stops only local work',async()=>{
    await background.activateInline(7);expect(await send(request())).toMatchObject({ok:true});
    expect(await send({type:'NC_INLINE_INVALIDATE',navigationId:'nav-7',generation:2})).toMatchObject({ok:true});
    expect(await send(request(2))).toMatchObject({ok:true});
    expect(mocks.openChannel).toHaveBeenCalledOnce();expect(mocks.readImage).toHaveBeenCalledOnce();
    expect(cores[0].submit).toHaveBeenCalledTimes(2);expect(options[0].isCurrent()).toBe(true);
    await background.suspendInline(7);
    expect(options[0].isCurrent()).toBe(false);expect(cores[0].dispose).toHaveBeenCalledOnce();
    expect(cores[0].manual).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{enabled:true},{enabled:false,dismissedUrl:url}])('does not let automatic activation reclaim a region-owned page: %j',identity=>{
    mocks.tabMessage.mockResolvedValue({url,...identity});
    return background.activateInline(7,true).then(()=>{
      expect(chrome.scripting.executeScript).not.toHaveBeenCalled();expect(mocks.openChannel).not.toHaveBeenCalled();
    });
  });
});
