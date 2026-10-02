import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ChannelConnection,ChannelRuntime,RuntimeOptions} from '../src/translation/channels/contracts';
import type {PreparedInput} from '../src/translation/input/prepare';
import type {RegionIdentity,RegionImageRequest,RegionRequest,RegionResponse} from '../src/region/protocol';
import type {RegionRecord} from '../src/region/store';
import type {Job} from '../src/types';

type ImageLoad=(request:unknown,signal:AbortSignal)=>Promise<{blob:Blob;current:()=>boolean}>;
const mocks=vi.hoisted(()=>({
  openChannel:vi.fn<()=>Promise<ChannelConnection>>(),subscribe:vi.fn(),capture:vi.fn(),prepare:vi.fn<()=>Promise<PreparedInput>>(),
  localSettings:vi.fn<()=>Promise<Record<string,unknown>>>(),sessionGet:vi.fn<(key:string|null)=>Promise<Record<string,unknown>>>(),tabGet:vi.fn(),
  tabMessage:vi.fn<(tabId:number,message:{type:string},target?:{frameId:number;documentId?:string})=>Promise<unknown>>(),
  serve:vi.fn<(port:unknown,load:ImageLoad,close:()=>void)=>()=>void>(),suspend:vi.fn(async()=>{}),
  read:vi.fn<(id:string)=>Promise<RegionRecord|undefined>>(),forTab:vi.fn<(id:number)=>Promise<RegionRecord|undefined>>(),
  blob:vi.fn<(record:RegionRecord,kind:'source'|'input')=>Promise<Blob|undefined>>(),
  save:vi.fn<(record:RegionRecord,source?:Blob,input?:Blob)=>Promise<void>>(),
  remove:vi.fn<(tabId:number,id?:string)=>Promise<void>>(),list:vi.fn<()=>Promise<RegionRecord[]>>(),
}));
vi.mock('../src/translation/channels',()=>({openActiveChannel:mocks.openChannel,subscribeChannels:mocks.subscribe}));
vi.mock('../src/translation/input/prepare',()=>({prepareTranslationInput:mocks.prepare}));
vi.mock('../src/inline/background',()=>({suspendInline:mocks.suspend}));
vi.mock('../src/inline/blob-transfer',()=>({serveImage:mocks.serve}));
vi.mock('../src/region/capture',()=>({captureRegion:mocks.capture}));
vi.mock('../src/region/store',()=>({readRegion:mocks.read,regionForTab:mocks.forTab,readRegionBlob:mocks.blob,
  saveRegion:mocks.save,removeRegion:mocks.remove,listRegions:mocks.list}));

type Listener=(message:RegionRequest,sender:chrome.runtime.MessageSender,respond:(value:Reply)=>void)=>unknown;
type Reply={ok:boolean;data?:RegionResponse;error?:string};
type Port={name:string;sender?:chrome.runtime.MessageSender;disconnect:()=>void};
let listener:Listener,connect:(port:Port)=>void,activated:(info:{windowId:number})=>void,updated:(id:number,change:{url?:string;status?:string})=>void;
let records:Map<string,RegionRecord>,blobs:Map<string,Blob>,session:Record<string,unknown>,identity:RegionIdentity;
let tab:{id:number;windowId:number;url:string;active:boolean;status:string};
let core:ChannelRuntime,channel:ChannelConnection;
const url='https://source.test/comic',sha='a'.repeat(64),source=new Blob(['synthetic crop'],{type:'image/png'});
const viewport={width:800,height:600,devicePixelRatio:1,scrollX:0,scrollY:0};
const rect={x:20,y:30,width:100,height:80};
const completedJob=(id='selection-job',createdAt='2026-10-02T12:00:00Z'):Job=>({id,image_sha256:sha,mode:'classic',target_language:'zh-Hans',status:'succeeded',
  phase:'completed',quota_pages:0,created_at:createdAt,version:1,cache_hit:false,result_available:true,result:{key:id+'-result',recoverable:false}});
const sender:chrome.runtime.MessageSender={id:'test',url,frameId:0,documentId:'doc-7',tab:{id:7,url,active:true,autoDiscardable:true,
  discarded:false,frozen:false,groupId:-1,highlighted:true,incognito:false,index:0,pinned:false,selected:true,windowId:1}};
const base=()=>({navigationId:identity.navigationId,generation:identity.generation,selectionId:identity.selectionId});
const message=(type:RegionRequest['type']):RegionRequest=>({type,...base(),...(type==='NC_REGION_CAPTURE'?{rect,viewport}:{})});
const send=(request:RegionRequest,from=sender)=>new Promise<Reply|undefined>(resolve=>{if(listener(request,from,resolve)!==true)resolve(undefined);});
const gate=()=>{let finish!:()=>void;const promise=new Promise<void>(resolve=>{finish=resolve;});return {promise,finish};};
async function worker(){vi.resetModules();const module=await import('../src/region/background');module.registerRegionBackground();await Promise.resolve();return module;}

beforeEach(async()=>{
  vi.clearAllMocks();records=new Map();blobs=new Map();
  tab={id:7,windowId:1,url,active:true,status:'complete'};
  identity={url,navigationId:'nav-7',generation:1,selectionId:'selection-7',enabled:true,viewport};
  session={'nc-region:7':{url,navigationId:identity.navigationId,documentId:'doc-7',windowId:1}};
  mocks.read.mockImplementation(async id=>records.get(id));mocks.forTab.mockImplementation(async id=>[...records.values()].find(record=>record.tabId===id));
  mocks.list.mockImplementation(async()=>[...records.values()]);
  mocks.blob.mockImplementation(async(record,kind)=>blobs.get(record.id+':'+(kind==='input'&&record.inputIsSource?'source':kind)));
  mocks.save.mockImplementation(async(record,crop,input)=>{
    if(!crop&&!records.has(record.id))throw Error('REGION_SOURCE_MISSING');
    if(crop)for(const previous of records.values())if(previous.tabId===record.tabId&&previous.id!==record.id){
      records.delete(previous.id);blobs.delete(previous.id+':source');blobs.delete(previous.id+':input');
    }
    records.set(record.id,structuredClone(record));
    if(crop)blobs.set(record.id+':source',crop);if(input&&!record.inputIsSource)blobs.set(record.id+':input',input);
  });
  mocks.remove.mockImplementation(async(tabId,id)=>{for(const record of records.values())if(record.tabId===tabId&&(!id||record.id===id)){
    records.delete(record.id);blobs.delete(record.id+':source');blobs.delete(record.id+':input');
  }});
  mocks.capture.mockResolvedValue({blob:source,sha256:sha,width:100,height:80,rect});
  mocks.prepare.mockResolvedValue({image:{sha256:sha,byte_size:source.size,content_type:source.type,normalization_version:1},sourceSha256:sha,width:100,height:80});
  core={init:vi.fn(async()=>{}),submit:vi.fn(async()=>{}),manual:vi.fn(async()=>{}),wait:vi.fn(async()=>false),hasPending:false,
    waitingIds:[],retryDelay:0,stateFor:vi.fn(()=>undefined),refresh:vi.fn(async()=>{}),dispose:vi.fn()};
  channel={key:'channel-session-1',scope:{key:'account-1'},label:'Fixture',available:true,requiresInternet:true,allowsFeedback:true,isCurrent:()=>true,
    capabilities:{modes:[{id:'classic',label:'Classic',enabled:true}],languages:[{id:'zh-Hans',label:'Chinese'}],
      limits:{max_bytes:128*1024*1024,max_dimension:100000,max_pixels:100000**2,max_translation_ids:32},entitlements:null},
    createRuntime:vi.fn((_options:RuntimeOptions)=>core),readResult:vi.fn(async()=>source),dispose:vi.fn()};
  mocks.openChannel.mockResolvedValue(channel);mocks.serve.mockImplementation((_port,_load,onClose)=>vi.fn(onClose));
  mocks.localSettings.mockResolvedValue({'nc-reader-settings':{language:'zh-Hans'}});
  mocks.sessionGet.mockImplementation(async key=>key===null?{...session}:{[key]:session[key]});mocks.tabGet.mockImplementation(async()=>({...tab}));
  mocks.tabMessage.mockImplementation(async()=>({...identity}));
  const lockTails=new Map<string,Promise<void>>();
  vi.stubGlobal('navigator',{locks:{request:<T>(name:string,run:()=>Promise<T>)=>{
    const result=(lockTails.get(name)??Promise.resolve()).then(run);
    lockTails.set(name,result.then(()=>{},()=>{}));return result;
  }}});
  vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('No external calls allowed');}));
  vi.stubGlobal('chrome',{
    runtime:{id:'test',getURL:(path:string)=>'chrome-extension://test'+path,
      onMessage:{addListener(fn:Listener){listener=fn;}},onConnect:{addListener(fn:typeof connect){connect=fn;}}},
    storage:{local:{get:mocks.localSettings},
      session:{get:mocks.sessionGet,set:async(data:Record<string,unknown>)=>Object.assign(session,data),
        remove:async(key:string)=>{delete session[key];}},onChanged:{addListener(){}}},
    tabs:{get:mocks.tabGet,sendMessage:mocks.tabMessage,create:vi.fn(async()=>({id:8})),
      onActivated:{addListener(fn:typeof activated){activated=fn;}},onUpdated:{addListener(fn:typeof updated){updated=fn;}},onRemoved:{addListener(){}}},
    scripting:{executeScript:vi.fn(async()=>[{documentId:'doc-7'}])},
  });
  await worker();
});
afterEach(()=>{vi.unstubAllGlobals();});

describe('region background capture and admission',()=>{
  it('freezes capture-only bytes without admitting a task until the trusted submit step',async()=>{
    expect(await send(message('NC_REGION_CAPTURE'))).toMatchObject({ok:true,data:{submitted:false,width:100,height:80}});
    expect(records.get('selection-7')?.submitted).toBe(false);expect(blobs.get('selection-7:source')).toBe(source);
    expect(mocks.openChannel).not.toHaveBeenCalled();expect(mocks.prepare).not.toHaveBeenCalled();expect(core.submit).not.toHaveBeenCalled();
    const saved=records.get('selection-7');expect(saved).not.toHaveProperty('windowId');expect(saved).not.toHaveProperty('documentId');expect(saved).not.toHaveProperty('viewport');
  });
  it('checks capture before rate limiting, immediately before pixels and after pixels without an outer duplicate',async()=>{
    mocks.sessionGet.mockClear();mocks.tabGet.mockClear();mocks.tabMessage.mockClear();
    expect(await send(message('NC_REGION_CAPTURE'))).toMatchObject({ok:true});
    expect(mocks.sessionGet).toHaveBeenCalledTimes(3);expect(mocks.tabGet).toHaveBeenCalledTimes(3);
    expect(mocks.tabMessage).toHaveBeenCalledTimes(3);
    for(const call of mocks.tabMessage.mock.calls)expect(call).toEqual([7,{type:'NC_REGION_IDENTITY'},{frameId:0,documentId:'doc-7'}]);
  });
  const stepTypes:RegionRequest['type'][]=['NC_REGION_SUBMIT','NC_REGION_TICK','NC_REGION_WAIT','NC_REGION_RETRY'];
  it.each(stepTypes)('performs exactly one authorization IPC sequence for %s',async type=>{
    await send(message('NC_REGION_CAPTURE'));await send(message('NC_REGION_SUBMIT'));
    mocks.sessionGet.mockClear();mocks.tabGet.mockClear();mocks.tabMessage.mockClear();
    expect(await send(message(type))).toMatchObject({ok:true});
    expect(mocks.sessionGet).toHaveBeenCalledExactlyOnceWith('nc-region:7');expect(mocks.tabGet).toHaveBeenCalledExactlyOnceWith(7);
    expect(mocks.tabMessage).toHaveBeenCalledExactlyOnceWith(7,{type:'NC_REGION_IDENTITY'},{frameId:0,documentId:'doc-7'});
  });
  it('authorizes a queued submit inside its lock and rejects a changed selection before preparing input',async()=>{
    await send(message('NC_REGION_CAPTURE'));const pending=gate();
    vi.stubGlobal('navigator',{locks:{request:<T>(_name:string,run:()=>Promise<T>)=>pending.promise.then(run)}});
    mocks.sessionGet.mockClear();mocks.tabGet.mockClear();mocks.tabMessage.mockClear();
    const response=send(message('NC_REGION_SUBMIT'));await Promise.resolve();
    expect(mocks.sessionGet).not.toHaveBeenCalled();identity={...identity,generation:2,selectionId:'new-selection'};pending.finish();
    expect(await response).toMatchObject({ok:false});expect(mocks.tabMessage).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();expect(core.submit).not.toHaveBeenCalled();
  });
  it('rejects a capture if its window switches tabs before the pixels return',async()=>{
    const pending=gate();mocks.capture.mockImplementationOnce(async()=>{await pending.promise;return {blob:source,sha256:sha,width:100,height:80,rect};});
    const response=send(message('NC_REGION_CAPTURE'));await vi.waitFor(()=>expect(mocks.capture).toHaveBeenCalledOnce());
    tab.active=false;activated({windowId:1});pending.finish();
    expect(await response).toMatchObject({ok:false});expect(mocks.save).not.toHaveBeenCalled();expect(mocks.openChannel).not.toHaveBeenCalled();
  });
  it('invalidates capture when closed before any source row exists',async()=>{
    const pending=gate();mocks.capture.mockImplementationOnce(async()=>{await pending.promise;return {blob:source,sha256:sha,width:100,height:80,rect};});
    const response=send(message('NC_REGION_CAPTURE'));await vi.waitFor(()=>expect(mocks.capture).toHaveBeenCalledOnce());
    expect(await send(message('NC_REGION_CLOSE'))).toMatchObject({ok:true});pending.finish();
    expect(await response).toMatchObject({ok:false});expect(mocks.save).not.toHaveBeenCalled();expect(records.size).toBe(0);
  });
  it('does not let an old close invalidate a newer selection capture',async()=>{
    await send(message('NC_REGION_CAPTURE'));const close=message('NC_REGION_CLOSE');
    identity={...identity,generation:2,selectionId:'selection-new'};
    const pending=gate();mocks.capture.mockImplementationOnce(async()=>{await pending.promise;return {blob:source,sha256:sha,width:100,height:80,rect};});
    const response=send(message('NC_REGION_CAPTURE'));await vi.waitFor(()=>expect(mocks.capture).toHaveBeenCalledTimes(2),{timeout:3000});
    await send(close);pending.finish();expect(await response).toMatchObject({ok:true,data:{selectionId:'selection-new'}});
    expect(records.size).toBe(1);expect(records.has('selection-new')).toBe(true);
  });
  it('prepares and persists input once when the trusted submit step is repeated',async()=>{
    await send(message('NC_REGION_CAPTURE'));
    const result=await Promise.all([send(message('NC_REGION_SUBMIT')),send(message('NC_REGION_SUBMIT'))]);
    expect(result.every(value=>value?.ok)).toBe(true);expect(mocks.prepare).toHaveBeenCalledOnce();expect(channel.createRuntime).toHaveBeenCalledOnce();
    expect(core.init).toHaveBeenCalledOnce();expect(records.get('selection-7')).toMatchObject({submitted:true,scope:'account-1',language:'zh-Hans'});
    const calls=vi.mocked(core.submit).mock.calls;expect(calls).toHaveLength(2);expect(calls[0][0]).toEqual(calls[1][0]);
  });
  it('does not admit a task if exact input cannot be saved',async()=>{
    await send(message('NC_REGION_CAPTURE'));mocks.save.mockRejectedValueOnce(Error('disk full'));
    expect(await send(message('NC_REGION_SUBMIT'))).toMatchObject({ok:false});
    expect(channel.createRuntime).not.toHaveBeenCalled();expect(core.submit).not.toHaveBeenCalled();
  });
  it.each(['channel','settings'])('disposes a channel when closed while awaiting %s and never creates a runtime',async stage=>{
    await send(message('NC_REGION_CAPTURE'));const pending=gate();
    if(stage==='channel')mocks.openChannel.mockImplementationOnce(async()=>{await pending.promise;return channel;});
    else mocks.localSettings.mockImplementationOnce(async()=>{await pending.promise;return {'nc-reader-settings':{language:'zh-Hans'}};});
    const response=send(message('NC_REGION_SUBMIT'));
    await vi.waitFor(()=>expect(stage==='channel'?mocks.openChannel:mocks.localSettings).toHaveBeenCalledOnce());
    expect(await send(message('NC_REGION_CLOSE'))).toMatchObject({ok:true});pending.finish();
    expect(await response).toMatchObject({ok:false});expect(channel.dispose).toHaveBeenCalledOnce();
    expect(channel.createRuntime).not.toHaveBeenCalled();expect(mocks.prepare).not.toHaveBeenCalled();expect(core.submit).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
    // A second close must not find a stale context and dispose the same channel again.
    await send(message('NC_REGION_CLOSE'));expect(channel.dispose).toHaveBeenCalledOnce();
  });
  it('filters unrelated channel history before attaching jobs or exposing a region result',async()=>{
    await send(message('NC_REGION_CAPTURE'));await send(message('NC_REGION_SUBMIT'));
    const options=vi.mocked(channel.createRuntime).mock.calls[0][0];
    const foreign:Job={id:'foreign-image-job',image_sha256:'b'.repeat(64),mode:'classic',target_language:'zh-Hans',status:'succeeded',
      phase:'completed',quota_pages:0,created_at:'2026-10-02T12:00:00Z',version:1,cache_hit:false,result_available:true,
      result:{key:'foreign-image-result',recoverable:false}};
    await options.onJobs([foreign]);
    expect(records.get('selection-7')?.page?.jobs).toEqual([]);
    const empty=await send(message('NC_REGION_TICK'));expect(empty).toMatchObject({ok:true});expect(empty?.data?.resultKey).toBeUndefined();
    expect(channel.readResult).not.toHaveBeenCalled();
    const own:Job={...foreign,id:'selection-job',image_sha256:sha,result:{key:'selection-result',recoverable:false}};
    mocks.save.mockClear();
    await options.onJobs([foreign,own]);
    expect(records.get('selection-7')?.page?.jobs).toEqual([]);expect(mocks.save).not.toHaveBeenCalled();
    const result=await send(message('NC_REGION_TICK'));
    expect(result?.data?.resultKey).toBe(JSON.stringify(['account-1','selection-job','selection-result']));
    expect(vi.mocked(core.submit).mock.calls.at(-1)?.[0][0].page.jobs).toEqual([own]);
  });
  it('closes local state without retrying, cancelling or deleting a remote task',async()=>{
    await send(message('NC_REGION_CAPTURE'));await send(message('NC_REGION_SUBMIT'));
    expect(await send(message('NC_REGION_CLOSE'))).toMatchObject({ok:true});
    expect(records.size).toBe(0);expect(blobs.size).toBe(0);expect(core.dispose).toHaveBeenCalledOnce();
    expect(core.submit).toHaveBeenCalledOnce();expect(core.manual).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  const recoveryTypes:RegionRequest['type'][]=['NC_REGION_TICK','NC_REGION_WAIT'];
  it.each(recoveryTypes)('recovers the same stored target after worker restart with %s',async type=>{
    await send(message('NC_REGION_CAPTURE'));await send(message('NC_REGION_SUBMIT'));
    const original=vi.mocked(core.submit).mock.calls[0][0];await worker();
    expect(await send(message(type))).toMatchObject({ok:true,data:{submitted:true}});
    expect(mocks.capture).toHaveBeenCalledOnce();expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(vi.mocked(core.submit).mock.calls.at(-1)?.[0]).toEqual(original);
    if(type==='NC_REGION_WAIT')expect(core.wait).toHaveBeenCalledOnce();
  });
  it.each(['init','submit'])('rehydrates channel-owned jobs during %s on the first WAIT after worker restart and then serves the result',async restoreStage=>{
    await send(message('NC_REGION_CAPTURE'));await send(message('NC_REGION_SUBMIT'));
    const job=completedJob(),firstOptions=vi.mocked(channel.createRuntime).mock.calls[0][0];
    await firstOptions.onJobs([job]);expect(records.get('selection-7')?.page?.jobs).toEqual([]);
    let restored:RuntimeOptions|undefined;
    vi.mocked(channel.createRuntime).mockImplementation(options=>{restored=options;return core;});
    const restore=async()=>{if(!restored)throw Error('Runtime is not initialized');await restored.onJobs([job]);};
    if(restoreStage==='init')vi.mocked(core.init).mockImplementation(restore);else vi.mocked(core.submit).mockImplementation(restore);
    await worker();mocks.save.mockClear();
    const response=await send(message('NC_REGION_WAIT')),resultKey=JSON.stringify(['account-1',job.id,job.result?.key]);
    expect(response).toMatchObject({ok:true,data:{resultKey}});expect(core.wait).toHaveBeenCalledOnce();expect(core.manual).not.toHaveBeenCalled();
    connect({name:'NC_REGION_IMAGE',sender,disconnect:vi.fn()});const load=mocks.serve.mock.calls.at(-1)![1];
    const result=await load({...base(),selectionId:'selection-7',kind:'result',resultKey},new AbortController().signal);
    expect(result.blob).toBe(source);expect(result.current()).toBe(true);expect(channel.readResult).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();expect(mocks.capture).toHaveBeenCalledOnce();expect(mocks.prepare).toHaveBeenCalledOnce();
  });
  it('does not restore a submitted selection into a different account scope',async()=>{
    await send(message('NC_REGION_CAPTURE'));await send(message('NC_REGION_SUBMIT'));
    channel.scope={key:'another-account'};await worker();
    expect(await send(message('NC_REGION_TICK'))).toMatchObject({ok:false});
    expect(channel.dispose).toHaveBeenCalledOnce();expect(core.submit).toHaveBeenCalledOnce();expect(mocks.prepare).toHaveBeenCalledOnce();
  });
  it('clears a persisted selection when its original document no longer exists',async()=>{
    await send(message('NC_REGION_CAPTURE'));identity={...identity,navigationId:'different-document'};await worker();
    await vi.waitFor(()=>expect(records.size).toBe(0));expect(mocks.openChannel).not.toHaveBeenCalled();
  });
  it('does not retain a capture committed after navigation cleanup',async()=>{
    const pending=gate();mocks.save.mockImplementationOnce(async(record,crop)=>{await pending.promise;records.set(record.id,record);if(crop)blobs.set(record.id+':source',crop);});
    const response=send(message('NC_REGION_CAPTURE'));await vi.waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce());
    updated(7,{status:'loading'});await vi.waitFor(()=>expect(mocks.remove).toHaveBeenCalled());pending.finish();
    expect(await response).toMatchObject({ok:false});await vi.waitFor(()=>expect(records.size).toBe(0));
  });
  it('targets the original document and preserves a new selection during delayed settings cleanup',async()=>{
    await send(message('NC_REGION_CAPTURE'));const pending=gate();
    mocks.tabMessage.mockImplementation(async(_tabId,request)=>{
      if(request.type==='NC_REGION_CONFIG_CHANGED'){await pending.promise;return {ok:true};}
      return {...identity};
    });
    mocks.subscribe.mock.calls[0][0]();
    await vi.waitFor(()=>expect(mocks.tabMessage).toHaveBeenCalledWith(7,{type:'NC_REGION_CONFIG_CHANGED'},{frameId:0,documentId:'doc-7'}));
    identity={...identity,generation:2,selectionId:'selection-after-settings'};
    expect(await send(message('NC_REGION_CAPTURE'))).toMatchObject({ok:true,data:{selectionId:'selection-after-settings'}});
    pending.finish();await vi.waitFor(()=>expect(mocks.remove).toHaveBeenCalledWith(7,'selection-7'));
    expect(records.size).toBe(1);expect(records.has('selection-after-settings')).toBe(true);
    expect(blobs.get('selection-after-settings:source')).toBe(source);
  });
});

describe('region source image authorization',()=>{
  it('bounds per-tab transfers and releases the slot after disconnect',()=>{
    const ports=Array.from({length:3},()=>({name:'NC_REGION_IMAGE',sender,disconnect:vi.fn()}));
    for(const port of ports)connect(port);
    expect(mocks.serve).toHaveBeenCalledTimes(2);expect(ports[2].disconnect).toHaveBeenCalledOnce();
    mocks.serve.mock.results[0].value();connect({name:'NC_REGION_IMAGE',sender,disconnect:vi.fn()});
    expect(mocks.serve).toHaveBeenCalledTimes(3);
  });
  it.each([{id:'another-extension'},{frameId:1},{tab:undefined}])('rejects an untrusted image port sender: %j',change=>{
    const port={name:'NC_REGION_IMAGE',sender:{...sender,...change},disconnect:vi.fn()};connect(port);
    expect(port.disconnect).toHaveBeenCalledOnce();expect(mocks.serve).not.toHaveBeenCalled();
  });
  it('rejects a stale document before loading any local crop',async()=>{
    await send(message('NC_REGION_CAPTURE'));const port={name:'NC_REGION_IMAGE',sender:{...sender,documentId:'old-doc'},disconnect:vi.fn()};connect(port);
    const load=mocks.serve.mock.calls[0][1],request:RegionImageRequest={...base(),selectionId:'selection-7',kind:'source'};
    await expect(load(request,new AbortController().signal)).rejects.toThrow();expect(mocks.blob).not.toHaveBeenCalled();
  });
  it('serves only the selected crop after checking document and selection identity',async()=>{
    await send(message('NC_REGION_CAPTURE'));const port={name:'NC_REGION_IMAGE',sender,disconnect:vi.fn()};connect(port);
    const load=mocks.serve.mock.calls[0][1],request:RegionImageRequest={...base(),selectionId:'selection-7',kind:'source'};
    const result=await load(request,new AbortController().signal);expect(result.blob).toBe(source);expect(result.current()).toBe(true);
    await send(message('NC_REGION_CLOSE'));expect(result.current()).toBe(false);
  });
});

describe('region result recovery',()=>{
  it('requires an explicit manual retry for missing local results and keeps the frozen selection unchanged',async()=>{
    await send(message('NC_REGION_CAPTURE'));await send(message('NC_REGION_SUBMIT'));
    const options=vi.mocked(channel.createRuntime).mock.calls[0][0],job=completedJob();await options.onJobs([job]);
    const saved=structuredClone(records.get('selection-7')),resultKey=JSON.stringify(['account-1',job.id,job.result?.key]);
    const missing=Object.assign(Error('Local result was cleared'),{code:'RESULT_NOT_CACHED'});
    vi.mocked(channel.readResult).mockRejectedValueOnce(missing);mocks.save.mockClear();
    connect({name:'NC_REGION_IMAGE',sender,disconnect:vi.fn()});const load=mocks.serve.mock.calls.at(-1)![1];
    await expect(load({...base(),selectionId:'selection-7',kind:'result',resultKey},new AbortController().signal)).rejects.toBe(missing);
    const response=await send(message('NC_REGION_TICK'));
    expect(response?.data?.resultKey).toBeUndefined();expect(response?.data?.state).toEqual({kind:'error',message:missing.message,retryable:true,retryAction:'translate'});
    expect(core.manual).not.toHaveBeenCalled();expect(mocks.prepare).toHaveBeenCalledOnce();expect(mocks.capture).toHaveBeenCalledOnce();
    const retried=completedJob('retried-job','2026-10-02T12:01:00Z');
    vi.mocked(core.manual).mockImplementation(async()=>{await options.onJobs([retried]);});
    const retry=await send(message('NC_REGION_RETRY')),newKey=JSON.stringify(['account-1',retried.id,retried.result?.key]);
    expect(core.manual).toHaveBeenCalledOnce();expect(retry?.data?.resultKey).toBe(newKey);expect(retry?.data?.state).toBeUndefined();
    expect((await load({...base(),selectionId:'selection-7',kind:'result',resultKey:newKey},new AbortController().signal)).blob).toBe(source);
    await expect(load({...base(),selectionId:'selection-7',kind:'result',resultKey},new AbortController().signal)).rejects.toThrow();
    expect(records.get('selection-7')).toEqual(saved);expect(mocks.save).not.toHaveBeenCalled();
  });
  it('keeps a failed download reloadable under the same result identity without creating a manual retry',async()=>{
    await send(message('NC_REGION_CAPTURE'));await send(message('NC_REGION_SUBMIT'));
    const options=vi.mocked(channel.createRuntime).mock.calls[0][0],job=completedJob();await options.onJobs([job]);
    const resultKey=JSON.stringify(['account-1',job.id,job.result?.key]);vi.mocked(channel.readResult).mockRejectedValueOnce(Error('Network unavailable'));
    connect({name:'NC_REGION_IMAGE',sender,disconnect:vi.fn()});const load=mocks.serve.mock.calls.at(-1)![1];
    await expect(load({...base(),selectionId:'selection-7',kind:'result',resultKey},new AbortController().signal)).rejects.toThrow('Network unavailable');
    expect((await send(message('NC_REGION_TICK')))?.data?.resultKey).toBe(resultKey);
    expect((await load({...base(),selectionId:'selection-7',kind:'result',resultKey},new AbortController().signal)).blob).toBe(source);
    expect(core.manual).not.toHaveBeenCalled();
  });
  it('does not let a stale missing-result response mark a newer result as unavailable',async()=>{
    await send(message('NC_REGION_CAPTURE'));await send(message('NC_REGION_SUBMIT'));
    const options=vi.mocked(channel.createRuntime).mock.calls[0][0],old=completedJob();await options.onJobs([old]);
    const pending=gate();vi.mocked(channel.readResult).mockImplementationOnce(async()=>{await pending.promise;throw Object.assign(Error('Old result missing'),{code:'RESULT_NOT_CACHED'});});
    connect({name:'NC_REGION_IMAGE',sender,disconnect:vi.fn()});const load=mocks.serve.mock.calls.at(-1)![1];
    const loading=load({...base(),selectionId:'selection-7',kind:'result',resultKey:JSON.stringify(['account-1',old.id,old.result?.key])},new AbortController().signal);
    const rejected=expect(loading).rejects.toMatchObject({code:'RESULT_NOT_CACHED'});await vi.waitFor(()=>expect(channel.readResult).toHaveBeenCalledOnce());
    const latest=completedJob('latest-job','2026-10-02T12:01:00Z');await options.onJobs([latest]);pending.finish();await rejected;
    const response=await send(message('NC_REGION_TICK'));
    expect(response?.data?.resultKey).toBe(JSON.stringify(['account-1',latest.id,latest.result?.key]));expect(response?.data?.state).toBeUndefined();
    expect(vi.mocked(core.submit).mock.calls.at(-1)?.[0][0].page.translationError).toBeUndefined();
  });
});
