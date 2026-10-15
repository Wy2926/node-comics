import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {clearImmersiveSources, currentImmersiveSession, isImmersiveSessionCurrent, readImmersiveOriginal, validImmersiveImages} from './resources';
import {IMMERSIVE_SOURCE_PORT, immersiveSessionKey, type ImmersiveSession} from './protocol';

const dependency=vi.hoisted(()=>({activation:vi.fn(),receive:vi.fn(),inline:vi.fn(),resolved:vi.fn()}));
vi.mock('../image-resources',()=>({IMAGE_MEMORY_BYTES:10,DECODED_PAGE_WINDOW:2}));
vi.mock('../inline/activation',()=>({currentInlineActivation:dependency.activation}));
vi.mock('../inline/blob-transfer',()=>({receiveImage:dependency.receive}));
vi.mock('../sources/runtime/source-image',()=>({readInlineSourceImage:dependency.inline,readResolvedSourceImage:dependency.resolved}));

const tabId=37,navigationId='navigation-one',pageUrl='https://comic.example/chapter';
const sender={id:'extension',tab:{id:tabId},frameId:0,documentId:'document-one',url:pageUrl} as chrome.runtime.MessageSender;
let session:ImmersiveSession;
let get:ReturnType<typeof vi.fn>,connect:ReturnType<typeof vi.fn>;
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});
  return {promise,resolve,reject};
}
const blob=(size=2)=>new Blob(['x'.repeat(size)],{type:'image/png'});
const read=(id='a',signal=new AbortController().signal)=>readImmersiveOriginal(sender,navigationId,id,signal);
const started=(count:number)=>vi.waitFor(()=>expect(dependency.inline).toHaveBeenCalledTimes(count),{interval:1,timeout:1000});

beforeEach(()=>{
  clearImmersiveSources(tabId);vi.resetAllMocks();
  session={id:'session-one',navigationId,url:pageUrl,title:'Chapter',direction:'rtl',complete:false,
    images:['a','b','c'].map(id=>({id,url:`https://images.example/${id}.png`,width:800,height:1100}))};
  get=vi.fn(async()=>({[immersiveSessionKey(tabId)]:session}));
  connect=vi.fn(()=>({name:IMMERSIVE_SOURCE_PORT}));
  vi.stubGlobal('chrome',{storage:{session:{get}},tabs:{connect}});
  dependency.activation.mockResolvedValue({activation:{immersive:true},tab:{id:tabId,url:pageUrl}});
  dependency.inline.mockImplementation(async()=>blob());
  dependency.resolved.mockImplementation(async()=>blob());
  dependency.receive.mockImplementation(async()=>blob());
});
afterEach(()=>{clearImmersiveSources(tabId);vi.unstubAllGlobals();});

describe('shared immersive original resources',()=>{
  it('shares a pending source read and reuses its completed Blob for view and translation',async()=>{
    const pending=deferred<Blob>(),original=blob();dependency.inline.mockReturnValue(pending.promise);
    const view=read(),translation=read();await started(1);
    pending.resolve(original);
    expect(await view).toBe(original);expect(await translation).toBe(original);
    expect(await read()).toBe(original);expect(dependency.inline).toHaveBeenCalledTimes(1);
    expect(dependency.inline).toHaveBeenCalledWith(session.images[0].url,pageUrl,expect.any(AbortSignal),undefined);
  });

  it('cancels one consumer without aborting a shared original needed by another',async()=>{
    const pending=deferred<Blob>(),cancelled=new AbortController();dependency.inline.mockReturnValue(pending.promise);
    const view=read('a',cancelled.signal),translation=read();
    const viewRejected=expect(view).rejects.toThrow();await started(1);
    const sourceSignal=dependency.inline.mock.calls[0][2] as AbortSignal;
    cancelled.abort();await viewRejected;
    expect(sourceSignal.aborted).toBe(false);
    const original=blob();pending.resolve(original);expect(await translation).toBe(original);
  });

  it('aborts upstream only after its final consumer leaves',async()=>{
    const pending=deferred<Blob>(),first=new AbortController(),second=new AbortController();dependency.inline.mockReturnValue(pending.promise);
    const one=read('a',first.signal),two=read('a',second.signal);
    const failedOne=expect(one).rejects.toThrow(),failedTwo=expect(two).rejects.toThrow();await started(1);
    const sourceSignal=dependency.inline.mock.calls[0][2] as AbortSignal;
    first.abort();await failedOne;expect(sourceSignal.aborted).toBe(false);
    second.abort();await failedTwo;expect(sourceSignal.aborted).toBe(true);
    pending.resolve(blob());
  });

  it('does not let a late failure from cancelled work delete a replacement read for the same slot',async()=>{
    const old=deferred<Blob>(),replacement=deferred<Blob>(),cancelled=new AbortController();
    dependency.inline.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    const abandoned=read('a',cancelled.signal),abandonedRejected=expect(abandoned).rejects.toThrow();await started(1);
    cancelled.abort();await abandonedRejected;
    const current=read();await started(2);
    old.reject(Error('late old failure'));
    await new Promise<void>(resolve=>setTimeout(resolve,0));
    const another=read();
    await new Promise<void>(resolve=>setTimeout(resolve,0));
    expect(dependency.inline).toHaveBeenCalledTimes(2);
    const original=blob();replacement.resolve(original);
    expect(await current).toBe(original);expect(await another).toBe(original);
    expect(await read()).toBe(original);expect(dependency.inline).toHaveBeenCalledTimes(2);
  });

  it('allows a failed original to be retried without retaining a failed promise',async()=>{
    dependency.inline.mockRejectedValueOnce(Error('temporary failure'));
    await expect(read()).rejects.toThrow('temporary failure');
    await expect(read()).resolves.toBeInstanceOf(Blob);
    expect(dependency.inline).toHaveBeenCalledTimes(2);
  });

  it('does not start a resource read after caller cancellation during authorization',async()=>{
    const authorization=deferred<Record<string,ImmersiveSession>>(),controller=new AbortController();
    get.mockReturnValueOnce(authorization.promise);
    const pending=read('a',controller.signal),rejected=expect(pending).rejects.toThrow();
    controller.abort();authorization.resolve({[immersiveSessionKey(tabId)]:session});await rejected;
    expect(dependency.inline).not.toHaveBeenCalled();
  });
});

describe('bounded original retention',()=>{
  it('delivers an oversized Blob but does not retain it after its final consumer releases it',async()=>{
    const oversized=blob(11);dependency.inline.mockResolvedValue(oversized);
    expect(await read()).toBe(oversized);
    expect(isImmersiveSessionCurrent(tabId,session.id)).toBe(true);
    expect(await read()).toBe(oversized);
    expect(dependency.inline).toHaveBeenCalledTimes(2);
  });

  it('applies the byte budget across retained originals',async()=>{
    dependency.inline.mockImplementation(async()=>blob(6));
    await read('a');await read('b');
    expect(dependency.inline).toHaveBeenCalledTimes(2);
    await read('b');expect(dependency.inline).toHaveBeenCalledTimes(2);
    await read('a');expect(dependency.inline).toHaveBeenCalledTimes(3);
  });

  it('trims the last simultaneous batch on release without waiting for another source completion',async()=>{
    const pending=[deferred<Blob>(),deferred<Blob>(),deferred<Blob>()];
    pending.forEach(item=>dependency.inline.mockReturnValueOnce(item.promise));
    const requests=['a','b','c'].map(id=>read(id));await started(3);
    pending.forEach(item=>item.resolve(blob()));await Promise.all(requests);
    await read('b');await read('c');expect(dependency.inline).toHaveBeenCalledTimes(3);
    await read('a');expect(dependency.inline).toHaveBeenCalledTimes(4);
  });
});

describe('original document and session authorization',()=>{
  it('provides a synchronous guard invalidated by release and changed sessions',async()=>{
    expect(isImmersiveSessionCurrent(tabId,session.id)).toBe(false);
    await read();expect(isImmersiveSessionCurrent(tabId,session.id)).toBe(true);
    clearImmersiveSources(tabId);expect(isImmersiveSessionCurrent(tabId,session.id)).toBe(false);
    session={...session,id:'session-two'};await read();
    expect(isImmersiveSessionCurrent(tabId,'session-one')).toBe(false);
    expect(isImmersiveSessionCurrent(tabId,'session-two')).toBe(true);
  });

  it('invalidates the guard before upstream abort listeners run',async()=>{
    const pending=deferred<Blob>();dependency.inline.mockReturnValue(pending.promise);
    const current=read(),rejected=expect(current).rejects.toThrow();await started(1);
    const sourceSignal=dependency.inline.mock.calls[0][2] as AbortSignal;
    const guardAtAbort=vi.fn(()=>isImmersiveSessionCurrent(tabId,session.id));
    sourceSignal.addEventListener('abort',guardAtAbort,{once:true});
    clearImmersiveSources(tabId);
    expect(guardAtAbort).toHaveReturnedWith(false);
    pending.resolve(blob());await rejected;
  });

  it('rechecks cancellation after awaiting final session authorization',async()=>{
    const finalAuthorization=deferred<Record<string,ImmersiveSession>>();
    get.mockResolvedValueOnce({[immersiveSessionKey(tabId)]:session}).mockReturnValueOnce(finalAuthorization.promise);
    const pending=read(),rejected=expect(pending).rejects.toThrow();
    await vi.waitFor(()=>expect(get).toHaveBeenCalledTimes(2),{interval:1,timeout:1000});
    clearImmersiveSources(tabId);finalAuthorization.resolve({[immersiveSessionKey(tabId)]:session});
    await rejected;expect(isImmersiveSessionCurrent(tabId,session.id)).toBe(false);
  });

  it('rejects resources from a session replaced during its read',async()=>{
    const pending=deferred<Blob>();dependency.inline.mockReturnValue(pending.promise);
    const request=read(),rejected=expect(request).rejects.toThrow('SOURCE_SESSION_EXPIRED');await started(1);
    session={...session,id:'replacement'};pending.resolve(blob());await rejected;
    expect(isImmersiveSessionCurrent(tabId,'session-one')).toBe(false);
  });

  it('uses only registered adapter processing for complete chapter resources',async()=>{
    session.manifest={url:pageUrl,title:'Chapter',adapter:'adapter',direction:'rtl',discoveryComplete:true,knownTotal:3,note:'',
      items:session.images.map((image,order)=>({...image,order,processing:'verified-recipe'}))};
    await read();
    expect(dependency.resolved).toHaveBeenCalledWith({url:session.images[0].url,pageUrl,sourceId:'adapter',processing:'verified-recipe'},expect.any(AbortSignal));
    expect(dependency.inline).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
  });

  it('uses the original tab document for page-bound Blob and canvas handles',async()=>{
    session.images[0].url='page-image:a';await read();
    expect(connect).toHaveBeenCalledWith(tabId,{name:IMMERSIVE_SOURCE_PORT,frameId:0,documentId:sender.documentId});
    expect(dependency.receive).toHaveBeenCalledWith(expect.anything(),{navigationId,id:'a'},expect.any(AbortSignal),expect.any(Function));
    const guard=dependency.receive.mock.calls[0][3] as ()=>boolean;
    expect(guard()).toBe(true);clearImmersiveSources(tabId);expect(guard()).toBe(false);
    expect(dependency.inline).not.toHaveBeenCalled();
  });

  it('rejects missing slots, inactive immersion and mismatched source URLs',async()=>{
    await expect(read('missing')).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
    dependency.activation.mockResolvedValueOnce({activation:{immersive:false},tab:{url:pageUrl}});
    await expect(currentImmersiveSession(sender,navigationId)).rejects.toThrow('SOURCE_SESSION_EXPIRED');
    session.url='https://comic.example/next';
    await expect(read()).rejects.toThrow('SOURCE_SESSION_EXPIRED');
    expect(dependency.inline).not.toHaveBeenCalled();
  });

  it('accepts translation handles only for registered unique slots',()=>{
    const image={id:'a',url:'page-image:a',width:800,height:1100};
    expect(validImmersiveImages(session,[image],2)).toBe(true);
    expect(validImmersiveImages(session,[image,image],2)).toBe(false);
    expect(validImmersiveImages(session,[{...image,id:'missing',url:'page-image:missing'}],2)).toBe(false);
    expect(validImmersiveImages(session,[{...image,url:'https://arbitrary.example/image'}],2)).toBe(false);
    expect(validImmersiveImages(session,[image],0)).toBe(false);
  });
});
