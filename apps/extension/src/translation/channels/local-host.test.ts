import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {registerLocalHostBackground} from './host-background';
import {registerLocalHost} from './local-host';
import {LOCAL_HOST_MESSAGE,LOCAL_HOST_PATH,localHostRequest} from './host-client';
import type {ChannelLocalHost} from './contracts';

const registry=vi.hoisted(()=>({start:vi.fn()}));
vi.mock('./registry',()=>({channelDefinition:()=>({id:'fixture',startLocalHost:registry.start})}));
type Listener=(request:any,sender:chrome.runtime.MessageSender,reply:(value:any)=>void)=>unknown;
let listeners:Listener[];
const sendMessage=vi.fn<(request:unknown)=>Promise<any>>();
const extensionUrl='chrome-extension://fixture';
const sender={id:'fixture',url:extensionUrl+'/reader.html'};
function request(listener:Listener,action:string,from:chrome.runtime.MessageSender=sender,extra={}){
  let reply!:(value:any)=>void;const response=new Promise<any>(resolve=>{reply=resolve;});
  return listener({type:LOCAL_HOST_MESSAGE,action,...extra},from,reply)===true?response:undefined;
}
beforeEach(()=>{
  listeners=[];registry.start.mockReset();sendMessage.mockReset();let pending:Promise<unknown>=Promise.resolve();
  vi.stubGlobal('navigator',{locks:{request:(_name:string,run:()=>Promise<unknown>)=>{const next=pending.then(run,run);pending=next.catch(()=>{});return next;}}});
  vi.stubGlobal('chrome',{runtime:{id:'fixture',getURL:(path:string)=>extensionUrl+path,onMessage:{addListener:(listener:Listener)=>listeners.push(listener)},sendMessage}});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

function offscreen(){
  let contexts:chrome.runtime.ExtensionContext[]=[];
  const createDocument=vi.fn(async()=>{contexts=[{documentId:crypto.randomUUID()} as chrome.runtime.ExtensionContext];});
  const closeDocument=vi.fn(async()=>{contexts=[];});
  Object.assign(chrome,{offscreen:{createDocument,closeDocument}});
  Object.assign(chrome.runtime,{getContexts:vi.fn(async()=>contexts)});
  sendMessage.mockResolvedValue({ready:true});
  registerLocalHostBackground();
  return {createDocument,closeDocument,contexts:()=>contexts,send:(action:string,from:chrome.runtime.MessageSender=sender)=>request(listeners[0],action,from)};
}
it('creates one hidden document for concurrent requests without using tabs',async()=>{
  const f=offscreen();
  expect(await Promise.all([f.send('ensure'),f.send('ensure'),f.send('ensure')])).toEqual([{ok:true},{ok:true},{ok:true}]);
  expect(f.createDocument).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url:LOCAL_HOST_PATH,reasons:expect.arrayContaining(['WORKERS','BLOBS'])}));
  expect(chrome.tabs).toBeUndefined();
});
it('rechecks idle state without sender documentId and ignores an old close while the new host is ready',async()=>{
  const f=offscreen();await f.send('ensure');
  sendMessage.mockResolvedValueOnce({ready:false});await f.send('ensure');
  expect(f.createDocument).toHaveBeenCalledTimes(2);expect(f.closeDocument).toHaveBeenCalledTimes(1);
  await f.send('close',{...sender,url:extensionUrl+LOCAL_HOST_PATH});
  expect(f.closeDocument).toHaveBeenCalledTimes(1);
  sendMessage.mockResolvedValueOnce({ready:false});
  await f.send('close',{...sender,url:extensionUrl+LOCAL_HOST_PATH});
  expect(f.closeDocument).toHaveBeenCalledTimes(2);
});
it('ignores host lifecycle requests from website content scripts',async()=>{
  const f=offscreen();expect(f.send('ensure',{...sender,url:'https://example.com',tab:{id:1} as chrome.tabs.Tab})).toBeUndefined();
  expect(f.createDocument).not.toHaveBeenCalled();
});
it('does not replay dispatch when acknowledgement is lost',async()=>{
  sendMessage.mockResolvedValueOnce({ok:true}).mockRejectedValueOnce(Error('Lost acknowledgement'));
  await expect(localHostRequest('fixture',{action:'start',id:'page'})).rejects.toThrow('Lost acknowledgement');
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
  expect(chrome.runtime.sendMessage).toHaveBeenNthCalledWith(1,{type:LOCAL_HOST_MESSAGE,action:'ensure'});
  expect(chrome.tabs).toBeUndefined();
});
it('retains busy work and releases idle workers using only the runtime API',async()=>{
  vi.useFakeTimers();let changed!:(busy:boolean)=>void;
  const host:ChannelLocalHost={dispatch:vi.fn(async()=>{changed(true);}),dispose:vi.fn(async()=>{})};
  registry.start.mockImplementation(async(notify:(busy:boolean)=>void)=>{changed=notify;return host;});
  const close=vi.fn(async()=>{});registerLocalHost(close);
  await request(listeners[0],'dispatch',sender,{adapterId:'fixture',message:{action:'start'}});
  await vi.advanceTimersByTimeAsync(120_000);expect(close).not.toHaveBeenCalled();
  changed(false);await vi.advanceTimersByTimeAsync(60_000);
  expect(host.dispose).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();expect(chrome.tabs).toBeUndefined();
});
it('keeps pending dispatch alive and rejects new work while disposing',async()=>{
  vi.useFakeTimers();let accepted!:()=>void,disposed!:()=>void;
  const host:ChannelLocalHost={dispatch:vi.fn(()=>new Promise<void>(resolve=>{accepted=resolve;})),dispose:vi.fn(()=>new Promise<void>(resolve=>{disposed=resolve;}))};
  registry.start.mockResolvedValue(host);const close=vi.fn(async()=>{});registerLocalHost(close);
  const work=request(listeners[0],'dispatch',sender,{adapterId:'fixture',message:{action:'start'}});
  await vi.waitFor(()=>expect(host.dispatch).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(120_000);expect(close).not.toHaveBeenCalled();
  accepted();await work;await vi.advanceTimersByTimeAsync(60_000);
  const reply=vi.fn();listeners[0]({type:LOCAL_HOST_MESSAGE,action:'ping'},sender,reply);expect(reply).toHaveBeenCalledWith({ready:false});
  listeners[0]({type:LOCAL_HOST_MESSAGE,action:'dispatch',adapterId:'fixture'},sender,reply);expect(reply).toHaveBeenLastCalledWith({ok:false,error:'LOCAL_HOST_UNAVAILABLE'});
  disposed();await vi.waitFor(()=>expect(close).toHaveBeenCalledOnce());
});
