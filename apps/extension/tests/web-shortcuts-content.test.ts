import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {bindWebShortcuts,installWebShortcuts} from '../src/shortcuts/web-content';
import {bindShortcuts} from '../src/shortcuts/runtime';
import type {ShortcutHandlers} from '../src/shortcuts/catalog';

vi.mock('../src/shortcuts/runtime',()=>({bindShortcuts:vi.fn(()=>vi.fn())}));
type Listener=(message:any,sender:chrome.runtime.MessageSender,respond:(value:unknown)=>void)=>void;
const background={id:'extension',url:'chrome-extension://extension/background.js'};
const flush=async()=>{for(let count=0;count<10;count++)await Promise.resolve();};
let listeners:Set<Listener>,hidden:boolean;
let initial:{promise:Promise<any>;resolve:(value:any)=>void};
function deferred(){let resolve!:(value:any)=>void;return {promise:new Promise<any>(done=>{resolve=done;}),resolve};}
function broadcast(message:any,sender:chrome.runtime.MessageSender=background){for(const listener of listeners)listener(message,sender,()=>{});}
const binding=()=>vi.mocked(bindShortcuts).mock.calls.at(-1)!;
const key=(trusted=true)=>({isTrusted:trusted}) as KeyboardEvent;
beforeEach(()=>{
  vi.clearAllMocks();listeners=new Set();hidden=false;initial=deferred();
  vi.stubGlobal('window',{});vi.stubGlobal('document',{get hidden(){return hidden;}});
  vi.stubGlobal('location',{href:'https://source.test/chapter'});
  vi.stubGlobal('chrome',{runtime:{id:'extension',getURL:()=> 'chrome-extension://extension/',
    onMessage:{addListener:(value:Listener)=>listeners.add(value),removeListener:(value:Listener)=>listeners.delete(value)},
    sendMessage:vi.fn((message:{type:string})=>message.type==='NC_SHORTCUTS_GET'?initial.promise:Promise.resolve({ok:true})),
  }});
});
afterEach(()=>vi.unstubAllGlobals());

describe('public content shortcut preferences',()=>{
  it('waits for saved preferences instead of briefly enabling defaults',async()=>{
    const cleanup=bindWebShortcuts({},()=>true),options=binding()[2];
    expect(options.enabled!()).toBe(false);
    initial.resolve({ok:true,overrides:{'web.translate':[]}});await flush();
    expect(options.enabled!()).toBe(true);expect(options.getOverrides()).toEqual({'web.translate':[]});
    hidden=true;expect(options.enabled!()).toBe(false);cleanup();expect(listeners.size).toBe(0);
  });
  it('applies a trusted live change and ignores an older initialization response',async()=>{
    const cleanup=bindWebShortcuts({},()=>true),options=binding()[2];
    broadcast({type:'NC_SHORTCUTS_CHANGED',overrides:{'web.translate':['Ctrl+Alt+KeyT']}});
    initial.resolve({ok:true,overrides:{}});await flush();
    expect(options.getOverrides()).toEqual({'web.translate':['Ctrl+Alt+KeyT']});cleanup();
  });
  it.each([{id:'foreign'}, {tab:{id:7}}, {url:'https://source.test/chapter'}])('ignores a forged preferences broadcast %j',change=>{
    const cleanup=bindWebShortcuts({},()=>true),options=binding()[2];
    broadcast({type:'NC_SHORTCUTS_CHANGED',overrides:{'web.translate':[]}}, {...background,...change} as chrome.runtime.MessageSender);
    expect(options.enabled!()).toBe(false);cleanup();
  });
  it('does not allow synthetic keyboard events to invoke content actions',async()=>{
    const action=vi.fn(),cleanup=bindWebShortcuts({'web.close':action},()=>true);
    initial.resolve({ok:true,overrides:{}});await flush();
    const handlers=binding()[1];expect(handlers['web.close']!(key(false))).toBe(false);expect(action).not.toHaveBeenCalled();
    handlers['web.close']!(key());expect(action).toHaveBeenCalledOnce();cleanup();
  });
});

describe('always-on shortcut entry',()=>{
  it('initializes an HTTP document without secure-context-only randomUUID',()=>{
    const getRandomValues=vi.fn((bytes:Uint8Array)=>{for(let index=0;index<bytes.length;index++)bytes[index]=index;return bytes;});
    vi.stubGlobal('crypto',{getRandomValues});vi.stubGlobal('location',{href:'http://source.test/chapter'});
    const cleanup=installWebShortcuts(),respond=vi.fn();
    for(const listener of listeners)listener({type:'NC_SHORTCUTS_IDENTITY'},background,respond);
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledExactlyOnceWith({instanceId:'000102030405060708090a0b0c0d0e0f',url:'http://source.test/chapter'});
    expect(binding()[1]['web.translate']).toBeTypeOf('function');cleanup();
  });
  it('registers only manual starts and the panel, leaving inactive translation controls untouched',()=>{
    const cleanup=installWebShortcuts();
    expect(Object.keys(binding()[1])).toEqual(['web.translate','web.shortcuts']);cleanup();
  });
  it('sends its own document identity and suppresses overlapping activations',async()=>{
    const cleanup=installWebShortcuts();initial.resolve({ok:true,overrides:{}});await flush();
    const handlers:ShortcutHandlers=binding()[1];
    handlers['web.translate']!(key());expect(handlers['web.translate']!(key())).toBe(false);
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({type:'NC_SHORTCUTS_EXECUTE',action:'web.translate',url:'https://source.test/chapter',instanceId:expect.any(String)});
    await flush();handlers['web.shortcuts']!(key());
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({action:'web.shortcuts'}));cleanup();
  });
  it('answers identity challenges only from the extension background',()=>{
    const cleanup=installWebShortcuts(),respond=vi.fn();
    for(const listener of listeners)listener({type:'NC_SHORTCUTS_IDENTITY'},background,respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({instanceId:expect.any(String),url:'https://source.test/chapter'});
    respond.mockClear();for(const listener of listeners)listener({type:'NC_SHORTCUTS_IDENTITY'},{...background,tab:{id:7} as chrome.tabs.Tab},respond);
    expect(respond).not.toHaveBeenCalled();cleanup();
  });
});
