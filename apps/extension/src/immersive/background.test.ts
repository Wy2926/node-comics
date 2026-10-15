import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {registerImmersiveBackground} from './background';
import {activationKey,currentInlineActivation,type InlineActivation} from '../inline/activation';
import {settingsKey} from '../inline/settings';
import {defaults} from '../types';
import type {PageSnapshot,SourceSnapshot} from '../sources/contracts/source';
import {IMMERSIVE_ORIGINAL_PORT,immersiveSessionKey,type ImmersiveImage,type ImmersiveSession} from './protocol';

const dependency=vi.hoisted(()=>({source:vi.fn(),operation:vi.fn(),snapshot:vi.fn(),persistent:vi.fn(),
  clear:vi.fn(),current:vi.fn(),read:vi.fn(),guard:vi.fn(),serve:vi.fn()}));
vi.mock('../sources',async()=>({sourceFor:dependency.source,
  ...(await import('../sources/shared/urls')),...(await import('../sources/shared/referrer'))}));
vi.mock('../sources/runtime/network',()=>({networkOperation:dependency.operation,readNetworkPageSnapshot:dependency.snapshot,readNetworkPages:dependency.persistent}));
vi.mock('./resources',()=>({clearImmersiveSources:dependency.clear,currentImmersiveSession:dependency.current,
  readImmersiveOriginal:dependency.read,isImmersiveSessionCurrent:dependency.guard}));
vi.mock('../inline/blob-transfer',()=>({serveImage:dependency.serve}));

type Listener=(...args:any[])=>any;
function event(){
  const listeners:Listener[]=[];
  return {listeners,addListener:vi.fn((listener:Listener)=>listeners.push(listener)),
    emit:(...args:any[])=>listeners.map(listener=>listener(...args))};
}
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});
  return {promise,resolve,reject};
}
const tabId=37,navigationId='navigation-one',url='https://comic.example/chapter',documentId='document-one';
const sender={id:'extension',frameId:0,tab:{id:tabId},documentId,url} as chrome.runtime.MessageSender;
let stored:Record<string,unknown>,local:Record<string,unknown>,currentUrl:string,activeResourceSession:string|undefined;
let messages:ReturnType<typeof event>,connections:ReturnType<typeof event>,storageChanges:ReturnType<typeof event>;
let removed:ReturnType<typeof event>,updated:ReturnType<typeof event>;
let sessionSet:ReturnType<typeof vi.fn>,sessionRemove:ReturnType<typeof vi.fn>,localSet:ReturnType<typeof vi.fn>,localGet:ReturnType<typeof vi.fn>;
let transfers:Array<{load:(value:unknown,signal:AbortSignal)=>Promise<{blob:Blob;current:()=>boolean}>;controller:AbortController;close:ReturnType<typeof vi.fn<()=>void>>}>;
function manifest(overrides:Partial<PageSnapshot>={}):PageSnapshot{
  return {adapter:'site',url,title:'Chapter',direction:'rtl',discoveryComplete:true,knownTotal:2,note:'',
    items:[{id:'source-0',url:'https://images.example/0.png',order:0,width:800,height:1100,processing:'verified-recipe',contentKey:'content-0'},
      {id:'source-1',url:'https://images.example/1.png',order:1,width:800,height:1100}],...overrides};
}
function sourceSnapshot():SourceSnapshot{
  const value=manifest();
  return {...value,items:value.items.map(({url,processing,...item})=>({...item,resource:{kind:'http' as const,url,processing}}))};
}
const images=()=>manifest().items.map((item,index)=>({id:'bound-'+index,url:item.url,width:item.width,height:item.height}));
function setSource(generic=false){
  dependency.source.mockImplementation((value:string)=>({definition:{id:generic?'generic':'site',
    capabilities:{importable:!generic,pages:true,inline:true,catalog:false}},
  location:{sourceId:generic?'generic':'site',kind:'reader',url:value,pageKey:value}}));
}
function send(type:string,values:Record<string,unknown>={},from=sender):Promise<{ok?:boolean;data?:any;error?:string;ignored?:boolean}>{
  return new Promise(resolve=>{
    const accepted=messages.listeners[0]({type,navigationId,...values},from,resolve);
    if(accepted!==true)resolve({ignored:true});
  });
}
function port(from:chrome.runtime.MessageSender|undefined=sender){
  const value={name:IMMERSIVE_ORIGINAL_PORT,sender:from,disconnect:vi.fn()};
  connections.emit(value);return value;
}
async function changeActivation(value:InlineActivation|undefined){
  const key=activationKey(tabId),oldValue=stored[key];
  if(value)stored[key]=value;else delete stored[key];
  storageChanges.emit({[key]:{oldValue,newValue:value}},'session');
  await new Promise<void>(resolve=>setTimeout(resolve,0));
}
const started=(count:number)=>vi.waitFor(()=>expect(dependency.snapshot).toHaveBeenCalledTimes(count),{interval:1,timeout:1000});

beforeEach(()=>{
  vi.resetAllMocks();currentUrl=url;activeResourceSession=undefined;transfers=[];
  stored={[activationKey(tabId)]:{url,navigationId,documentId,immersive:true}};local={};
  messages=event();connections=event();storageChanges=event();removed=event();updated=event();
  const readStorage=(values:Record<string,unknown>,keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,values[key]]));
  sessionSet=vi.fn(async(values:Record<string,unknown>)=>{Object.assign(stored,values);});
  sessionRemove=vi.fn(async(key:string)=>{delete stored[key];});
  localSet=vi.fn(async(values:Record<string,unknown>)=>{Object.assign(local,values);});
  localGet=vi.fn(async(keys:string|string[])=>readStorage(local,keys));
  vi.stubGlobal('chrome',{runtime:{id:'extension',onMessage:messages,onConnect:connections},
    storage:{session:{get:vi.fn(async(keys:string|string[])=>readStorage(stored,keys)),set:sessionSet,remove:sessionRemove},
      local:{get:localGet,set:localSet},onChanged:storageChanges},
    tabs:{get:vi.fn(async()=>({id:tabId,url:currentUrl,title:'Tab title'})),onRemoved:removed,onUpdated:updated}});
  const locks=new Map<string,Promise<unknown>>();
  vi.stubGlobal('navigator',{locks:{request:vi.fn((name:string,operation:()=>unknown)=>{
    const result=(locks.get(name)??Promise.resolve()).catch(()=>{}).then(operation);locks.set(name,result);
    return result.finally(()=>{if(locks.get(name)===result)locks.delete(name);});
  })}});
  setSource();dependency.operation.mockReturnValue(()=>{});dependency.snapshot.mockResolvedValue(manifest());
  dependency.clear.mockImplementation(()=>{activeResourceSession=undefined;});
  dependency.guard.mockImplementation((_tabId:number,id:string)=>activeResourceSession===id);
  dependency.current.mockImplementation(async(from:chrome.runtime.MessageSender,nav:unknown)=>{
    const active=await currentInlineActivation(from,nav),session=stored[immersiveSessionKey(tabId)] as ImmersiveSession|undefined;
    if(!active?.activation.immersive||!session||session.navigationId!==nav||session.url!==active.tab.url)throw Error('SOURCE_SESSION_EXPIRED');
    return session;
  });
  dependency.read.mockImplementation(async()=>{
    activeResourceSession=(stored[immersiveSessionKey(tabId)] as ImmersiveSession).id;
    return new Blob(['original'],{type:'image/png'});
  });
  dependency.serve.mockImplementation((_port:unknown,load:typeof transfers[number]['load'],onClose:()=>void)=>{
    const controller=new AbortController(),close=vi.fn(()=>{controller.abort();onClose();});
    transfers.push({load,controller,close});return close;
  });
  registerImmersiveBackground();
});
afterEach(()=>vi.unstubAllGlobals());

describe('immersive background authorization and temporary chapter sessions',()=>{
  it.each([
    {id:'other-extension'}, {frameId:1}, {tab:undefined},
  ])('ignores messages outside the activated top-frame extension sender %j',async(change)=>{
    expect(await send('NC_IMMERSIVE_RESOLVE',{}, {...sender,...change} as chrome.runtime.MessageSender)).toEqual({ignored:true});
    expect(dependency.snapshot).not.toHaveBeenCalled();expect(sessionSet).not.toHaveBeenCalled();
  });

  it.each([
    {values:{navigationId:'stale-navigation'},from:sender},
    {values:{},from:{...sender,documentId:'stale-document'}},
    {values:{},from:{...sender,url:'https://foreign.example/chapter'}},
  ])('rejects stale navigation, document and foreign origin %j',async({values,from})=>{
    expect(await send('NC_IMMERSIVE_RESOLVE',values,from)).toMatchObject({ok:false,error:'SOURCE_SESSION_EXPIRED'});
    expect(dependency.snapshot).not.toHaveBeenCalled();
  });

  it('uses the current tab URL while allowing a same-origin sender URL to lag behind SPA state',async()=>{
    const response=await send('NC_IMMERSIVE_RESOLVE',{}, {...sender,url:'https://comic.example/previous'});
    expect(response.ok).toBe(true);expect(dependency.snapshot).toHaveBeenCalledWith(url,expect.any(AbortSignal));
    currentUrl='https://comic.example/next';
    expect(await send('NC_IMMERSIVE_RESOLVE')).toMatchObject({ok:false,error:'SOURCE_SESSION_EXPIRED'});
  });

  it('still requires the navigation token on browsers without documentId',async()=>{
    stored[activationKey(tabId)]={url,navigationId,immersive:true};
    const from={...sender,documentId:undefined};
    expect((await send('NC_IMMERSIVE_RESOLVE',{},from)).ok).toBe(true);
    expect(await send('NC_IMMERSIVE_RESOLVE',{navigationId:'old'},from)).toMatchObject({ok:false,error:'SOURCE_SESSION_EXPIRED'});
  });

  it('keeps a complete network snapshot temporary and preserves its original processing and identity',async()=>{
    const response=await send('NC_IMMERSIVE_RESOLVE'),session=response.data.session as ImmersiveSession;
    expect(response.ok).toBe(true);expect(session.complete).toBe(true);expect(session.knownTotal).toBe(2);
    expect(session.manifest).toEqual(manifest());
    expect(session.manifest?.items[0]).toMatchObject({processing:'verified-recipe',contentKey:'content-0'});
    expect(session.images).toHaveLength(2);expect(session.images[0].id).not.toBe('source-0');
    expect(stored[immersiveSessionKey(tabId)]).toBe(session);
    expect(Object.keys(stored).sort()).toEqual([activationKey(tabId),immersiveSessionKey(tabId)].sort());
    expect(dependency.persistent).not.toHaveBeenCalled();expect(localSet).not.toHaveBeenCalled();
    await send('NC_IMMERSIVE_RELEASE');expect(stored[immersiveSessionKey(tabId)]).toBeUndefined();
  });

  it('returns explicit network failure without silently saving a partial alternative',async()=>{
    dependency.snapshot.mockRejectedValueOnce(Error('SOURCE_LOGIN_REQUIRED'));
    expect(await send('NC_IMMERSIVE_RESOLVE')).toMatchObject({ok:false,error:'SOURCE_LOGIN_REQUIRED'});
    expect(sessionSet).not.toHaveBeenCalled();
  });
});

describe('bound current-tab image scope',()=>{
  it('keeps generic sessions partial even when a caller supplies a complete snapshot',async()=>{
    setSource(true);
    const resolve=await send('NC_IMMERSIVE_RESOLVE');expect(resolve.data.session).toBeUndefined();expect(dependency.snapshot).not.toHaveBeenCalled();
    const bound=images();bound[1].url=bound[0].url;
    const response=await send('NC_IMMERSIVE_BIND',{images:bound,snapshot:sourceSnapshot(),complete:true,knownTotal:999,title:'Chosen region'});
    expect(response.ok).toBe(true);expect(response.data.complete).toBe(false);expect(response.data.manifest).toBeUndefined();
    expect(response.data.knownTotal).toBeUndefined();expect(response.data.images).toEqual(bound);
  });

  it.each([
    {name:'duplicate ids',value:()=>[images()[0],images()[0]]},
    {name:'wrong page handle',value:()=>[{...images()[0],url:'page-image:someone-else'}]},
    {name:'raw Blob URL',value:()=>[{...images()[0],url:'blob:https://comic.example/original'}]},
    {name:'javascript URL',value:()=>[{...images()[0],url:'javascript:alert(1)'}]},
    {name:'credential-bearing URL',value:()=>[{...images()[0],url:'https://user:secret@images.example/a'}]},
    {name:'negative width',value:()=>[{...images()[0],width:-1}]},
    {name:'non-finite height',value:()=>[{...images()[0],height:Infinity}]},
    {name:'invalid referrer policy',value:()=>[{...images()[0],referrerPolicy:'arbitrary'}]},
    {name:'oversized id',value:()=>[{...images()[0],id:'x'.repeat(81)}]},
    {name:'too many slots',value:()=>Array.from({length:1501},(_,i)=>({...images()[0],id:String(i)}))},
  ])('rejects out-of-scope generic image data: $name',async({value})=>{
    setSource(true);
    expect(await send('NC_IMMERSIVE_BIND',{images:value()})).toMatchObject({ok:false,error:'SOURCE_PAGES_INVALID'});
    expect(sessionSet).not.toHaveBeenCalled();
  });

  it('allows only matching registered page handles and validated image referrer policies',async()=>{
    setSource(true);
    const value=[{id:'canvas',url:'page-image:canvas',width:800,height:1100},
      {...images()[0],referrerPolicy:'no-referrer'}];
    const result=await send('NC_IMMERSIVE_BIND',{images:value});
    expect(result.ok).toBe(true);expect(result.data.images).toEqual(value);
  });

  it('preserves verified page recipes on dedicated bindings and rejects scope/URL mismatches',async()=>{
    const valid=await send('NC_IMMERSIVE_BIND',{images:images(),snapshot:sourceSnapshot()});
    expect(valid.ok).toBe(true);expect(valid.data.manifest.items[0].processing).toBe('verified-recipe');
    const wrong=images();wrong[0].url='https://images.example/unrelated.png';
    expect(await send('NC_IMMERSIVE_BIND',{images:wrong,snapshot:sourceSnapshot()})).toMatchObject({ok:false,error:'SOURCE_PAGES_INVALID'});
    expect(await send('NC_IMMERSIVE_BIND',{images:images().slice(0,1),snapshot:sourceSnapshot()})).toMatchObject({ok:false,error:'SOURCE_PAGES_INVALID'});
    expect(await send('NC_IMMERSIVE_BIND',{images:images(),snapshot:{...sourceSnapshot(),adapter:'foreign'}})).toMatchObject({ok:false,error:'INVALID_SOURCE_PAGES'});
  });
});

describe('request replacement and original chunk lifetime',()=>{
  it('preserves session identity, cached originals and loaded chunks across a strict generic append',async()=>{
    setSource(true);
    const initial=await send('NC_IMMERSIVE_BIND',{images:images()});
    port();const transfer=transfers[0];
    const loaded=await transfer.load({navigationId,id:initial.data.images[0].id},transfer.controller.signal);
    expect(loaded.current()).toBe(true);dependency.clear.mockClear();
    const appended=[...images(),{id:'bound-2',url:'https://images.example/2.png',width:800,height:1200}];
    const latest=await send('NC_IMMERSIVE_BIND',{images:appended,title:'Updated title'});
    expect(latest.ok).toBe(true);expect(latest.data.id).toBe(initial.data.id);
    expect(latest.data.images).toEqual(appended);expect(latest.data.title).toBe('Updated title');
    expect(stored[immersiveSessionKey(tabId)]).toBe(latest.data);
    expect(dependency.clear).not.toHaveBeenCalled();expect(transfer.close).not.toHaveBeenCalled();
    expect(loaded.current()).toBe(true);
  });

  it('compares immutable slots by field values, independently of property order',async()=>{
    setSource(true);
    const initial=await send('NC_IMMERSIVE_BIND',{images:images()});
    const reordered=images().map(image=>({height:image.height,width:image.width,url:image.url,id:image.id}));
    dependency.clear.mockClear();
    const unchanged=await send('NC_IMMERSIVE_BIND',{images:reordered});
    expect(unchanged.ok).toBe(true);expect(unchanged.data.id).toBe(initial.data.id);
    expect(dependency.clear).not.toHaveBeenCalled();
  });

  it('allows an original already being read to finish after generic lazy append',async()=>{
    setSource(true);
    const initial=await send('NC_IMMERSIVE_BIND',{images:images()}),pending=deferred<Blob>();
    dependency.read.mockImplementationOnce(()=>{activeResourceSession=initial.data.id;return pending.promise;});
    port();const transfer=transfers[0];
    const reading=transfer.load({navigationId,id:initial.data.images[0].id},transfer.controller.signal);
    await vi.waitFor(()=>expect(dependency.read).toHaveBeenCalledOnce(),{interval:1,timeout:1000});
    dependency.clear.mockClear();
    const appended=await send('NC_IMMERSIVE_BIND',{images:[...images(),{id:'bound-2',url:'https://images.example/2.png',width:800,height:1200}]});
    expect(appended.data.id).toBe(initial.data.id);
    expect(transfer.controller.signal.aborted).toBe(false);expect(transfer.close).not.toHaveBeenCalled();
    expect(dependency.clear).not.toHaveBeenCalled();
    const blob=new Blob(['in-flight original'],{type:'image/png'});pending.resolve(blob);
    const loaded=await reading;expect(loaded.blob).toBe(blob);expect(loaded.current()).toBe(true);
  });

  it.each([
    {name:'removed page',change:(value:ImmersiveImage[])=>value.slice(0,1)},
    {name:'reordered pages',change:(value:ImmersiveImage[])=>value.toReversed()},
    {name:'replaced slot id',change:(value:ImmersiveImage[])=>[{...value[0],id:'new-slot'},value[1]]},
    {name:'changed original URL',change:(value:ImmersiveImage[])=>[{...value[0],url:'https://images.example/replaced.png'},value[1]]},
    {name:'changed width',change:(value:ImmersiveImage[])=>[{...value[0],width:900},value[1]]},
    {name:'changed height',change:(value:ImmersiveImage[])=>[{...value[0],height:1200},value[1]]},
    {name:'changed referrer policy',change:(value:ImmersiveImage[])=>[{...value[0],referrerPolicy:'no-referrer' as const},value[1]]},
  ])('retires cached originals and loaded chunks for generic replacement: $name',async({change})=>{
    setSource(true);
    const initial=await send('NC_IMMERSIVE_BIND',{images:images()});
    port();const transfer=transfers[0];
    const loaded=await transfer.load({navigationId,id:initial.data.images[0].id},transfer.controller.signal);
    expect(loaded.current()).toBe(true);dependency.clear.mockClear();
    const latest=await send('NC_IMMERSIVE_BIND',{images:change(images())});
    expect(latest.ok).toBe(true);expect(latest.data.id).not.toBe(initial.data.id);
    expect(dependency.clear).toHaveBeenCalledWith(tabId);expect(transfer.close).toHaveBeenCalledOnce();
    expect(loaded.current()).toBe(false);
  });

  it('retires a partial binding when a verified manifest replaces it, even if slots are unchanged',async()=>{
    const initial=await send('NC_IMMERSIVE_BIND',{images:images()});
    expect(initial.data.manifest).toBeUndefined();
    port();const transfer=transfers[0];
    const loaded=await transfer.load({navigationId,id:initial.data.images[0].id},transfer.controller.signal);
    dependency.clear.mockClear();
    const latest=await send('NC_IMMERSIVE_BIND',{images:images(),snapshot:sourceSnapshot()});
    expect(latest.ok).toBe(true);expect(latest.data.id).not.toBe(initial.data.id);
    expect(latest.data.manifest.items[0].processing).toBe('verified-recipe');
    expect(dependency.clear).toHaveBeenCalledWith(tabId);expect(transfer.close).toHaveBeenCalledOnce();
    expect(loaded.current()).toBe(false);
  });

  it('RELEASE cancels old network work and prevents a late snapshot from recreating the session',async()=>{
    const pending=deferred<PageSnapshot>();dependency.snapshot.mockReturnValueOnce(pending.promise);
    const old=send('NC_IMMERSIVE_RESOLVE');await started(1);
    const signal=dependency.snapshot.mock.calls[0][1] as AbortSignal;
    expect((await send('NC_IMMERSIVE_RELEASE')).ok).toBe(true);expect(signal.aborted).toBe(true);
    pending.resolve(manifest());expect((await old).ok).toBe(false);
    expect(stored[immersiveSessionKey(tabId)]).toBeUndefined();expect(sessionSet).not.toHaveBeenCalled();
  });

  it('RELEASE also cancels a resolver suspended while reading settings, before any network starts',async()=>{
    const pending=deferred<Record<string,unknown>>();
    localGet.mockReturnValueOnce(pending.promise);
    const old=send('NC_IMMERSIVE_RESOLVE');
    await vi.waitFor(()=>expect(chrome.storage.local.get).toHaveBeenCalledOnce(),{interval:1,timeout:1000});
    expect((await send('NC_IMMERSIVE_RELEASE')).ok).toBe(true);
    pending.resolve({});expect((await old).ok).toBe(false);
    expect(dependency.snapshot).not.toHaveBeenCalled();expect(sessionSet).not.toHaveBeenCalled();
  });

  it('serializes release behind an in-flight storage write and removes its stale session',async()=>{
    const writing=deferred<void>();
    sessionSet.mockImplementationOnce(async(value:Record<string,unknown>)=>{await writing.promise;Object.assign(stored,value);});
    const old=send('NC_IMMERSIVE_RESOLVE');
    await vi.waitFor(()=>expect(sessionSet).toHaveBeenCalledOnce(),{interval:1,timeout:1000});
    const release=send('NC_IMMERSIVE_RELEASE');
    const signal=dependency.snapshot.mock.calls[0][1] as AbortSignal;
    await vi.waitFor(()=>expect(signal.aborted).toBe(true),{interval:1,timeout:1000});
    writing.resolve();expect((await old).ok).toBe(false);expect((await release).ok).toBe(true);
    expect(stored[immersiveSessionKey(tabId)]).toBeUndefined();
  });

  it('a new resolve cancels old network work and only the new generation can save',async()=>{
    const previous=deferred<PageSnapshot>(),next=deferred<PageSnapshot>();
    dependency.snapshot.mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise);
    const old=send('NC_IMMERSIVE_RESOLVE');await started(1);
    const latest=send('NC_IMMERSIVE_RESOLVE');await started(2);
    expect((dependency.snapshot.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    next.resolve(manifest({title:'New generation'}));const accepted=await latest;
    previous.resolve(manifest({title:'Stale generation'}));expect((await old).ok).toBe(false);
    expect((stored[immersiveSessionKey(tabId)] as ImmersiveSession).id).toBe(accepted.data.session.id);
    expect((stored[immersiveSessionKey(tabId)] as ImmersiveSession).title).toBe('New generation');
  });

  it('rejects unauthorized original ports and stale navigation reads',async()=>{
    expect(port({...sender,frameId:1}).disconnect).toHaveBeenCalledOnce();
    expect(port({...sender,id:'foreign'}).disconnect).toHaveBeenCalledOnce();
    expect(dependency.serve).not.toHaveBeenCalled();
    await send('NC_IMMERSIVE_RESOLVE');port();const transfer=transfers[0];
    await expect(transfer.load({navigationId:'old',id:'image'},transfer.controller.signal)).rejects.toThrow('SOURCE_SESSION_EXPIRED');
    expect(dependency.read).not.toHaveBeenCalled();
  });

  it('limits original transfer ports and releases their slots on close',()=>{
    port();port();port();const extra=port();expect(extra.disconnect).toHaveBeenCalledOnce();
    expect(dependency.serve).toHaveBeenCalledTimes(3);
    transfers[0].close();port();expect(dependency.serve).toHaveBeenCalledTimes(4);
  });

  it('closes loaded chunks and clears caches when immersion activation is removed',async()=>{
    const resolved=await send('NC_IMMERSIVE_RESOLVE');port();const transfer=transfers[0];
    const loaded=await transfer.load({navigationId,id:resolved.data.session.images[0].id},transfer.controller.signal);
    expect(loaded.current()).toBe(true);
    await changeActivation(undefined);
    expect(transfer.close).toHaveBeenCalledOnce();expect(loaded.current()).toBe(false);
    expect(dependency.clear).toHaveBeenCalledWith(tabId);expect(stored[immersiveSessionKey(tabId)]).toBeUndefined();
  });

  it.each([
    {navigationId:'navigation-two'}, {documentId:'document-two'}, {url:'https://comic.example/next'},
  ])('invalidates loaded old chunks when an immersive activation changes identity %j',async(change)=>{
    const resolved=await send('NC_IMMERSIVE_RESOLVE');port();const transfer=transfers[0];
    const loaded=await transfer.load({navigationId,id:resolved.data.session.images[0].id},transfer.controller.signal);
    await changeActivation({url,navigationId,documentId,immersive:true,...change});
    expect(transfer.close).toHaveBeenCalledOnce();expect(loaded.current()).toBe(false);
    expect(stored[immersiveSessionKey(tabId)]).toBeUndefined();
  });

  it('cancels old network work on an immersive activation identity change',async()=>{
    const pending=deferred<PageSnapshot>();dependency.snapshot.mockReturnValueOnce(pending.promise);
    const old=send('NC_IMMERSIVE_RESOLVE');await started(1);
    await changeActivation({url,navigationId:'next-navigation',documentId,immersive:true});
    expect((dependency.snapshot.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    pending.resolve(manifest());expect((await old).ok).toBe(false);
    expect(sessionSet).not.toHaveBeenCalled();
  });

  it('keeps a chunk guard false after session resources are synchronously revoked',async()=>{
    const resolved=await send('NC_IMMERSIVE_RESOLVE');port();const transfer=transfers[0];
    const loaded=await transfer.load({navigationId,id:resolved.data.session.images[0].id},transfer.controller.signal);
    dependency.clear(tabId);expect(loaded.current()).toBe(false);
  });

  it('clears pending work when a tab starts loading or is removed',async()=>{
    const pending=deferred<PageSnapshot>();dependency.snapshot.mockReturnValueOnce(pending.promise);
    const old=send('NC_IMMERSIVE_RESOLVE');await started(1);
    updated.emit(tabId,{status:'loading'});expect((dependency.snapshot.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    pending.resolve(manifest());expect((await old).ok).toBe(false);
    removed.emit(tabId);await new Promise<void>(resolve=>setTimeout(resolve,0));
    expect(sessionRemove).toHaveBeenCalledWith(immersiveSessionKey(tabId));
  });
});

describe('reader settings whitelist',()=>{
  it('updates presentation only and preserves translation/account-adjacent preferences',async()=>{
    local[settingsKey]={...defaults,language:'ja',autoTranslateTabs:false,cacheLimitMb:2048,accentTheme:'mint',textScale:1.2};
    const result=await send('NC_IMMERSIVE_SETTINGS',{settings:{layout:'single',direction:'rtl',fit:'width',readerBackground:'night',
      language:'bad',autoTranslateTabs:true,cacheLimitMb:0,accentTheme:'rose',textScale:9,token:'injected'}});
    expect(result.ok).toBe(true);
    expect(local[settingsKey]).toEqual({...defaults,layout:'single',direction:'rtl',fit:'width',readerBackground:'night',
      language:'ja',autoTranslateTabs:false,cacheLimitMb:2048,accentTheme:'mint',textScale:1.2});
    expect(sessionSet).not.toHaveBeenCalled();expect(dependency.snapshot).not.toHaveBeenCalled();
  });

  it('ignores invalid presentation values without cancelling current discovery',async()=>{
    const pending=deferred<PageSnapshot>();dependency.snapshot.mockReturnValueOnce(pending.promise);
    const resolve=send('NC_IMMERSIVE_RESOLVE');await started(1);
    const result=await send('NC_IMMERSIVE_SETTINGS',{settings:{layout:'grid',direction:'vertical',fit:'unbounded',readerBackground:'custom'}});
    expect(result.data).toEqual(defaults);expect((dependency.snapshot.mock.calls[0][1] as AbortSignal).aborted).toBe(false);
    pending.resolve(manifest());expect((await resolve).ok).toBe(true);
  });
});
