import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ChannelConnection,ChannelRuntime,RuntimeOptions} from '../src/translation/channels/contracts';
import type {Job} from '../src/types';

const mocks=vi.hoisted(()=>({
  getTab:vi.fn(),tabMessage:vi.fn(),localSettings:vi.fn(),openChannel:vi.fn(),init:vi.fn(),
  automatic:vi.fn(),registerAutomatic:vi.fn(),subscribe:vi.fn(),readImage:vi.fn(),prepareImage:vi.fn(),
  inlineSize:vi.fn(),rememberOriginal:vi.fn(),
}));
vi.mock('../src/i18n/runtime',()=>({msg:(text:string)=>text}));
vi.mock('../src/inline/auto-tabs',()=>({automaticTabsAllowed:mocks.automatic,registerAutomaticTabs:mocks.registerAutomatic}));
vi.mock('../src/inline/theme',()=>({registerInlineThemeBackground:()=>{}}));
vi.mock('../src/inline/originals',()=>({InlineOriginals:class {
  async read(){} remember=mocks.rememberOriginal; async uploaded(){} clear(){} forget(){}
}}));
vi.mock('../src/sources',()=>({
  safeImageUrl:(url:string)=>url.startsWith('https://')?url:undefined,readInlineSourceImage:mocks.readImage,
  inlineImageSize:mocks.inlineSize,isImageReferrerPolicy:()=>true,ImagePermissionsRequired:class extends Error {},
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
const imageClick=()=>({menuItemId:'nc-translate-image',editable:false,frameId:0,mediaType:'image',
  srcUrl:request().images[0].url,pageUrl:url}) as chrome.contextMenus.OnClickData;
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
  mocks.inlineSize.mockReturnValue(true);
  mocks.rememberOriginal.mockResolvedValue(undefined);
  const image=new Blob(['synthetic inline source'],{type:'image/png'});
  mocks.readImage.mockResolvedValue(image);
  mocks.prepareImage.mockResolvedValue({blob:image,width:500,height:700,imageSha256:'a'.repeat(64)});
  mocks.openChannel.mockImplementation(async(current:()=>boolean)=>{
    let disposed=false;
    const core:ChannelRuntime={init:mocks.init,restore:vi.fn(async()=>{}),submit:vi.fn(async()=>{}),manual:vi.fn(async()=>{}),wait:vi.fn(async()=>false),
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
afterEach(async()=>{await background.suspendInline(7);vi.unstubAllGlobals();});

describe('inline activation lifetime',()=>{
  it('frees a delivered image slot even during admission backoff, but keeps a newer pending request',async()=>{
    await send(request());
    vi.mocked(cores[0].stateFor).mockReturnValue({kind:'translating',message:'Loading result'});
    const completed:Job={id:'completed',status:'succeeded',phase:'done',mode:'classic',target_language:'zh-Hans',
      created_at:'2026-01-01T00:00:00Z',version:1,quota_pages:1,cache_hit:false,image_sha256:'a'.repeat(64),result:{key:'result',recoverable:true}};
    await options[0].onJobs([completed]);
    expect(await send({...request(),type:'NC_INLINE_WAIT'})).toMatchObject({ok:true,data:{items:[{id:'image-7',pending:false,resultKey:expect.any(String)}]}});
    Object.defineProperty(cores[0],'retryDelay',{value:5000,configurable:true});
    expect(await send({...request(),type:'NC_INLINE_WAIT'})).toMatchObject({ok:true,data:{items:[{pending:false}]}});
    Object.defineProperty(cores[0],'retryDelay',{value:0,configurable:true});
    await options[0].onJobs([{...completed,id:'new-request',status:'queued',result:undefined,created_at:'2026-01-02T00:00:00Z'}]);
    expect(await send({...request(),type:'NC_INLINE_WAIT'})).toMatchObject({ok:true,data:{items:[{pending:true,resultKey:expect.any(String)}]}});
  });
  it('still rejects execution messages larger than five images',async()=>{
    const images=Array.from({length:6},(_,i)=>({id:`image-${i}`,url:`https://source.test/${i}.png`,width:500,height:700}));
    expect(await send({...request(),images})).toMatchObject({ok:false});
    expect(mocks.readImage).not.toHaveBeenCalled();
  });
  it('admits prepared images incrementally and preserves the whole five-image window',async()=>{
    const pending=gate();let number=0;
    mocks.prepareImage.mockImplementation(async({blob}:{blob:Blob})=>({blob,width:500,height:700,imageSha256:String(++number).repeat(64)}));
    mocks.readImage.mockImplementation(async(url:string)=>{if(url.endsWith('/2.png'))await pending.promise;return new Blob([url]);});
    const images=Array.from({length:5},(_,i)=>({id:`image-${i}`,url:`https://source.test/${i}.png`,width:500,height:700}));
    const response=send({...request(),images});
    await vi.waitFor(()=>expect(vi.mocked(cores[0].submit).mock.lastCall?.[0]).toHaveLength(4));
    expect(mocks.readImage).toHaveBeenCalledTimes(5);
    expect(vi.mocked(cores[0].submit).mock.calls.every(([targets])=>targets.length<=4)).toBe(true);
    pending.finish();expect(await response).toMatchObject({ok:true});
    expect(vi.mocked(cores[0].submit).mock.lastCall?.[0]).toHaveLength(5);
    expect(await send({...request(),images})).toMatchObject({ok:true});
    expect(mocks.readImage).toHaveBeenCalledTimes(5);
    expect(vi.mocked(cores[0].submit).mock.lastCall?.[0]).toHaveLength(5);
    expect(await send({...request(),images:[...images,{...images[0],id:'sixth'}]})).toMatchObject({ok:false});
  });
  it('stops old source preparation after a jump without reading its remaining tail',async()=>{
    const signals:AbortSignal[]=[];
    mocks.readImage.mockImplementation((_url:string,_page:string,signal:AbortSignal)=>new Promise((_resolve,reject)=>{signals.push(signal);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
    const images=Array.from({length:5},(_,i)=>({id:`image-${i}`,url:`https://source.test/${i}.png`,width:500,height:700}));
    const old=send({...request(),images});await vi.waitFor(()=>expect(mocks.readImage).toHaveBeenCalledTimes(3));
    await send({type:'NC_INLINE_INVALIDATE',navigationId:'nav-7',generation:2});
    expect(signals.every(signal=>signal.aborted)).toBe(true);expect(await old).toMatchObject({ok:false});
    expect(mocks.prepareImage).not.toHaveBeenCalled();expect(mocks.readImage).toHaveBeenCalledTimes(3);expect(cores[0].submit).not.toHaveBeenCalled();
    mocks.readImage.mockResolvedValue(new Blob(['new']));
    expect(await send(request(2))).toMatchObject({ok:true});expect(cores[0].submit).toHaveBeenCalledOnce();
  });
  it('shares three source slots with cache-miss recovery and preserves accepted-task reads after a jump',async()=>{
    await send(request());
    const restore=mocks.rememberOriginal.mock.calls[0][2] as (signal?:AbortSignal)=>Promise<Blob>;
    mocks.prepareImage.mockImplementation(async({blob}:{blob:Blob})=>({blob,width:500,height:700,imageSha256:'a'.repeat(64)}));
    const reads:Array<{signal:AbortSignal;finish:()=>void}>=[];let active=0,peak=0;
    mocks.readImage.mockImplementation((_url:string,_page:string,signal:AbortSignal)=>new Promise<Blob>((resolve,reject)=>{
      peak=Math.max(peak,++active);
      reads.push({signal,finish:()=>resolve(new Blob(['restored']))});
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    }).finally(()=>{active--;}));
    const images=Array.from({length:3},(_,i)=>({...request().images[0],id:'new-'+i,url:`https://source.test/new-${i}.png`}));
    const preparing=send({...request(2),images});await vi.waitFor(()=>expect(reads).toHaveLength(3));
    const recovered=restore();await Promise.resolve();expect(reads).toHaveLength(3);
    reads[0].finish();await vi.waitFor(()=>expect(reads).toHaveLength(4));
    await send({type:'NC_INLINE_INVALIDATE',navigationId:'nav-7',generation:3,keepIds:[]});
    expect(reads.slice(1,3).every(read=>read.signal.aborted)).toBe(true);
    expect(reads[3].signal.aborted).toBe(false);expect(peak).toBe(3);
    reads[3].finish();expect(await(await recovered).text()).toBe('restored');await preparing;
  });
  it.each(['backoff','offline'] as const)('restores local results without remote work during %s, then resumes admission',async deferRemote=>{
    const open=mocks.openChannel.getMockImplementation()!;
    mocks.openChannel.mockImplementationOnce(async(current:()=>boolean)=>{
      const channel=await open(current);
      vi.mocked(cores[0].restore).mockImplementation(async()=>options[0].onJobs([{id:'cached',status:'succeeded',phase:'done',mode:'classic',target_language:'zh-Hans',created_at:'2026-01-01',version:1,quota_pages:0,cache_hit:true,image_sha256:'a'.repeat(64),result:{key:'cache',recoverable:true}}]));
      return channel;
    });
    expect(await send({...request(),deferRemote,refreshRights:true})).toMatchObject({ok:true,data:{items:[{resultKey:expect.any(String)}]}});
    expect(cores[0].restore).toHaveBeenCalledOnce();expect(cores[0].refresh).not.toHaveBeenCalled();expect(cores[0].submit).not.toHaveBeenCalled();
    expect(await send(request(2))).toMatchObject({ok:true});expect(cores[0].submit).toHaveBeenCalledOnce();
  });
  it('does not block a local channel when the page reports no internet',async()=>{
    const open=mocks.openChannel.getMockImplementation()!;
    mocks.openChannel.mockImplementationOnce(async(current:()=>boolean)=>{const channel=await open(current);channel.requiresInternet=false;return channel;});
    expect(await send({...request(),deferRemote:'offline'})).toMatchObject({ok:true});expect(cores[0].submit).toHaveBeenCalledOnce();
  });
  it('keeps an overlapping source read and lets the new generation finish without the abandoned read',async()=>{
    const pending=gate(),first=request().images[0];let oldSignal!:AbortSignal;
    mocks.readImage.mockImplementation(async(_url:string,_page:string,signal:AbortSignal)=>{oldSignal=signal;await pending.promise;return new Blob(['shared']);});
    const old=send(request());await vi.waitFor(()=>expect(mocks.readImage).toHaveBeenCalledOnce());
    await send({type:'NC_INLINE_INVALIDATE',navigationId:'nav-7',generation:2,keepIds:[first.id]});
    expect(oldSignal.aborted).toBe(false);
    const next=send(request(2));pending.finish();
    expect(await old).toMatchObject({ok:false});expect(await next).toMatchObject({ok:true});
    expect(mocks.readImage).toHaveBeenCalledOnce();
    expect(cores[0].submit).toHaveBeenCalledOnce();
    expect(locks.mock.calls.some(([name])=>name==='nc-inline-step:7')).toBe(false);
  });
  it('publishes a completed image while its neighbour is still being read',async()=>{
    const slow=gate(),images=[request().images[0],{...request().images[0],id:'slow',url:'https://source.test/slow.png'}];
    mocks.readImage.mockImplementation(async(url:string)=>{if(url.endsWith('slow.png'))await slow.promise;return new Blob([url]);});
    const open=mocks.openChannel.getMockImplementation()!;
    mocks.openChannel.mockImplementationOnce(async(current:()=>boolean)=>{
      const channel=await open(current);
      vi.mocked(cores[0].submit).mockImplementation(async()=>{await options[0].onJobs([{id:'done',status:'succeeded',phase:'done',mode:'classic',target_language:'zh-Hans',created_at:'2026-01-01',version:1,quota_pages:0,cache_hit:true,image_sha256:'a'.repeat(64),result:{key:'done-result',recoverable:true}}]);});
      return channel;
    });
    let settled=false;const done=send({...request(),images}).then(value=>{settled=true;return value;});
    await vi.waitFor(()=>expect(mocks.tabMessage).toHaveBeenCalledWith(7,expect.objectContaining({type:'NC_INLINE_UPDATE',generation:1,data:expect.objectContaining({items:expect.arrayContaining([expect.objectContaining({id:'image-7',resultKey:expect.any(String)})])})}),{frameId:0,documentId:'doc-7'}));
    expect(settled).toBe(false);slow.finish();expect(await done).toMatchObject({ok:true});
  });
  it('keeps status waiting independent of a slow neighbouring admission',async()=>{
    const admission=gate(),open=mocks.openChannel.getMockImplementation()!;
    mocks.openChannel.mockImplementationOnce(async(current:()=>boolean)=>{
      const channel=await open(current);
      vi.mocked(cores[0].submit).mockImplementation(()=>admission.promise);
      Object.defineProperty(cores[0],'hasPending',{value:true});
      vi.mocked(cores[0].wait).mockImplementation(async()=>{
        await options[0].onJobs([{id:'from-feed',status:'succeeded',phase:'done',mode:'classic',target_language:'zh-Hans',created_at:'2026-01-01',version:1,quota_pages:0,cache_hit:true,image_sha256:'a'.repeat(64),result:{key:'feed-result',recoverable:true}}]);return true;
      });
      return channel;
    });
    let settled=false;const batch=send(request()).then(value=>{settled=true;return value;});
    await vi.waitFor(()=>expect(cores[0].submit).toHaveBeenCalledOnce());
    expect(await send({...request(),type:'NC_INLINE_WAIT'})).toMatchObject({ok:true,data:{hasPending:true,items:[{resultKey:expect.any(String)}]}});
    expect(cores[0].wait).toHaveBeenCalledOnce();expect(settled).toBe(false);
    admission.finish();expect(await batch).toMatchObject({ok:true});
  });
  it('keeps a completed cached result usable after remote capabilities disable admission',async()=>{
    await send(request());
    await options[0].onJobs([{id:'cached',status:'succeeded',phase:'done',mode:'classic',target_language:'zh-Hans',created_at:'2026-01-01',version:1,quota_pages:0,cache_hit:true,image_sha256:'a'.repeat(64),result:{key:'cache',recoverable:true}}]);
    channels[0].capabilities.modes[0].enabled=false;
    expect(await send(request())).toMatchObject({ok:true,data:{items:[{resultKey:expect.any(String),pending:false}]}});
    expect(mocks.readImage).toHaveBeenCalledOnce();expect(cores[0].submit).toHaveBeenCalledTimes(2);
  });
  it('lets the channel recover accepted receipts and present their state when admission is disabled',async()=>{
    const open=mocks.openChannel.getMockImplementation()!;
    mocks.openChannel.mockImplementationOnce(async(current:()=>boolean)=>{
      const channel=await open(current);channel.capabilities.modes[0].enabled=false;
      vi.mocked(cores[0].restore).mockImplementation(async()=>options[0].onJobs([{id:'accepted',status:'queued',phase:'queued',mode:'classic',target_language:'zh-Hans',created_at:'2026-01-01',version:1,quota_pages:1,cache_hit:false,image_sha256:'a'.repeat(64)}]));
      vi.mocked(cores[0].stateFor).mockReturnValue({kind:'waiting',message:'accepted'});
      Object.defineProperty(cores[0],'hasPending',{value:true});return channel;
    });
    expect(await send(request())).toMatchObject({ok:true,data:{hasPending:true,items:[{pending:true,state:{kind:'waiting',message:'accepted'}}]}});
    expect(cores[0].submit).toHaveBeenCalledOnce();expect(cores[0].stateFor).toHaveBeenCalled();
  });
  it('restores local jobs before a held policy refresh and keeps source preparation independent',async()=>{
    const policy=gate(),open=mocks.openChannel.getMockImplementation()!;let number=0;
    mocks.prepareImage.mockImplementation(async({blob}:{blob:Blob})=>({blob,width:500,height:700,imageSha256:String(++number).repeat(64)}));
    mocks.openChannel.mockImplementationOnce(async(current:()=>boolean)=>{
      const channel=await open(current);
      vi.mocked(cores[0].refresh).mockImplementation(()=>policy.promise);
      vi.mocked(cores[0].restore).mockImplementation(async targets=>{if(targets[0].page.imageSha256==='1'.repeat(64))await options[0].onJobs([{id:'cached',status:'succeeded',phase:'done',mode:'classic',target_language:'zh-Hans',created_at:'2026-01-01',version:1,quota_pages:0,cache_hit:true,image_sha256:'1'.repeat(64),result:{key:'cache',recoverable:true}}]);});
      return channel;
    });
    const images=Array.from({length:5},(_,i)=>({...request().images[0],id:'page-'+i,url:`https://source.test/${i}.png`}));
    const done=send({...request(),images,refreshRights:true});
    await vi.waitFor(()=>expect(mocks.prepareImage).toHaveBeenCalledTimes(5));
    await vi.waitFor(()=>expect(mocks.tabMessage).toHaveBeenCalledWith(7,expect.objectContaining({type:'NC_INLINE_UPDATE',data:expect.objectContaining({items:expect.arrayContaining([expect.objectContaining({id:'page-0',resultKey:expect.any(String)})])})}),expect.anything()));
    expect(cores[0].refresh).toHaveBeenCalledOnce();policy.finish();expect(await done).toMatchObject({ok:true});
    expect(mocks.openChannel).toHaveBeenCalledWith(expect.any(Function),{deferPolicy:true});
  });
  it('does not retry a failed policy read for every later source in the same batch',async()=>{
    const slow=gate(),open=mocks.openChannel.getMockImplementation()!;
    mocks.openChannel.mockImplementationOnce(async(current:()=>boolean)=>{
      const channel=await open(current);vi.mocked(cores[0].refresh).mockRejectedValue(Error('offline'));return channel;
    });
    mocks.readImage.mockImplementation(async(url:string)=>{if(url.endsWith('slow.png'))await slow.promise;return new Blob([url]);});
    const images=[request().images[0],{...request().images[0],id:'slow',url:'https://source.test/slow.png'}];
    expect(await send({...request(),images,refreshRights:true})).toMatchObject({ok:false,error:'offline'});
    slow.finish();await vi.waitFor(()=>expect(mocks.prepareImage).toHaveBeenCalledTimes(2));
    expect(cores[0].refresh).toHaveBeenCalledOnce();expect(cores[0].submit).not.toHaveBeenCalled();
  });
  it('rejects an authorization that resumes from tabs.get after region suspension',async()=>{
    const pending=gate();mocks.getTab.mockImplementationOnce(async()=>{await pending.promise;return {...tab};});
    const response=send(request());await vi.waitFor(()=>expect(mocks.getTab).toHaveBeenCalledOnce());
    await background.suspendInline(7);pending.finish();
    expect(await response).toMatchObject({ok:false});expect(session['nc-inline:7']).toBeUndefined();
    expect(mocks.openChannel).not.toHaveBeenCalled();expect(mocks.readImage).not.toHaveBeenCalled();
  });

  it.each(['nc-inline-context:7'])('rejects an old request queued on %s before opening a channel',async name=>{
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
    expect(mocks.tabMessage).toHaveBeenCalledWith(7,expect.objectContaining({type:'NC_INLINE_START',automatic:false}),{frameId:0,documentId:'doc-7'});
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

describe('selected image activation',()=>{
  it('checks the selected image before stopping, then binds the identity created after stop',async()=>{
    const image=request().images[0];let navigationId='nav-7';
    mocks.tabMessage.mockImplementation(async(_id:number,message:{type:string})=>{
      if(message.type==='NC_INLINE_SELECT_IMAGE')return {ok:true,image:{id:image.id,url:image.url}};
      if(message.type==='NC_INLINE_STOP'){navigationId='nav-after-stop';return {ok:true};}
      if(message.type==='NC_INLINE_IDENTITY')return {url,navigationId,enabled:false};
      return {ok:true};
    });
    await background.activateInlineImage(7,imageClick());
    const types=mocks.tabMessage.mock.calls.map(([,message])=>message.type);
    expect(types.indexOf('NC_INLINE_SELECT_IMAGE')).toBeLessThan(types.indexOf('NC_INLINE_STOP'));
    expect(types.indexOf('NC_INLINE_STOP')).toBeLessThan(types.indexOf('NC_INLINE_IDENTITY'));
    expect(types.indexOf('NC_INLINE_IDENTITY')).toBeLessThan(types.indexOf('NC_INLINE_START'));
    expect(session['nc-inline:7']).toEqual({url,navigationId:'nav-after-stop',documentId:'doc-7',automatic:false,
      image:{id:image.id,url:image.url}});
    expect(mocks.tabMessage).toHaveBeenCalledWith(7,{type:'NC_INLINE_START',automatic:false,imageId:image.id},
      {frameId:0,documentId:'doc-7'});
    expect(await send(request())).toMatchObject({ok:false});
    expect(await send({...request(),navigationId:'nav-after-stop'})).toMatchObject({ok:true});
    expect(mocks.readImage).toHaveBeenCalledWith(image.url,url,expect.any(AbortSignal),undefined,true);
  });

  it('keeps the current activation and channel when the selected element is no longer valid',async()=>{
    expect(await send(request())).toMatchObject({ok:true});
    const saved=structuredClone(session['nc-inline:7']);
    mocks.tabMessage.mockImplementation(async(_id:number,message:{type:string})=>message.type==='NC_INLINE_SELECT_IMAGE'
      ?{ok:false}:{url,navigationId:'nav-7',enabled:true});
    await expect(background.activateInlineImage(7,imageClick())).rejects.toThrow('图片范围无效。');
    expect(session['nc-inline:7']).toEqual(saved);
    expect(mocks.tabMessage.mock.calls.map(([,message])=>message.type)).toEqual(['NC_INLINE_SELECT_IMAGE']);
    expect(channels[0].dispose).not.toHaveBeenCalled();
    expect(options[0].isCurrent()).toBe(true);
    expect(await send(request())).toMatchObject({ok:true});
    expect(mocks.openChannel).toHaveBeenCalledOnce();
  });

  it.each(['id','url'] as const)('rejects a selected image whose %s differs from the stored binding',async field=>{
    const image=request().images[0];
    session['nc-inline:7']={url,navigationId:'nav-7',documentId:'doc-7',automatic:false,image:{id:image.id,url:image.url}};
    const changed={...image,[field]:field==='id'?'another-image':'https://source.test/another.png'};
    expect(await send({...request(),images:[changed]})).toMatchObject({ok:false});
    expect(mocks.openChannel).not.toHaveBeenCalled();
    expect(mocks.readImage).not.toHaveBeenCalled();
  });

  it.each([0,2])('rejects %i images in a selected image activation before reading bytes',async count=>{
    const image=request().images[0];
    session['nc-inline:7']={url,navigationId:'nav-7',documentId:'doc-7',automatic:false,image:{id:image.id,url:image.url}};
    const images=count===0?[]:[image,{...image,id:'another-image',url:'https://source.test/another.png'}];
    expect(await send({...request(),images})).toMatchObject({ok:false});
    expect(mocks.openChannel).not.toHaveBeenCalled();
    expect(mocks.readImage).not.toHaveBeenCalled();
  });

  it('allows a small selected image while retaining the normal page recognition threshold',async()=>{
    const image={...request().images[0],width:64,height:32};
    mocks.inlineSize.mockImplementation((width:number,height:number)=>width>=240&&height>=180);
    const message={...request(),images:[image]};
    expect(await send(message)).toMatchObject({ok:false});
    expect(mocks.inlineSize).toHaveBeenCalledWith(64,32,url);
    expect(mocks.readImage).not.toHaveBeenCalled();
    session['nc-inline:7']={url,navigationId:'nav-7',documentId:'doc-7',automatic:false,image:{id:image.id,url:image.url}};
    expect(await send(message)).toMatchObject({ok:true});
    expect(mocks.inlineSize).toHaveBeenCalledOnce();
    expect(mocks.readImage).toHaveBeenCalledWith(image.url,url,expect.any(AbortSignal),undefined,true);
    expect(cores[0].submit).toHaveBeenCalledOnce();
  });

  it.each([{width:0,height:32},{width:64,height:-1},{width:NaN,height:32},{width:64,height:Infinity}])(
    'rejects invalid geometry for a selected image: %j',async dimensions=>{
      const image={...request().images[0],...dimensions};
      session['nc-inline:7']={url,navigationId:'nav-7',documentId:'doc-7',automatic:false,image:{id:image.id,url:image.url}};
      expect(await send({...request(),images:[image]})).toMatchObject({ok:false});
      expect(mocks.readImage).not.toHaveBeenCalled();
    });

  it('restores only the stored image binding after the background worker restarts',async()=>{
    const image=request().images[0];
    session['nc-inline:7']={url,navigationId:'nav-7',documentId:'doc-7',automatic:false,image:{id:image.id,url:image.url}};
    expect(await send(request())).toMatchObject({ok:true});
    await new Promise(resolve=>setTimeout(resolve,0)); // The retired worker's queued publication is gone on a real restart.
    vi.resetModules();
    background=await import('../src/inline/background');
    background.registerInlineBackground();
    const reads=mocks.readImage.mock.calls.length;
    expect(await send({...request(),images:[{...image,id:'another-image'}]})).toMatchObject({ok:false});
    expect(mocks.readImage).toHaveBeenCalledTimes(reads);
    expect(await send(request())).toMatchObject({ok:true});
    expect(mocks.readImage).toHaveBeenCalledTimes(reads+1);
    expect(mocks.readImage).toHaveBeenLastCalledWith(image.url,url,expect.any(AbortSignal),undefined,true);
    expect(mocks.openChannel).toHaveBeenCalledTimes(2);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
});
