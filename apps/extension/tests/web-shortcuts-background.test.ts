import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {registerWebShortcutsBackground} from '../src/shortcuts/web-background';
import {activateInline} from '../src/inline/background';
import {activateRegion} from '../src/region/background';
import {requireHostAccess} from '../src/host-permissions';
import {loadShortcutOverrides} from '../src/shortcuts/store';

vi.mock('../src/inline/background',()=>({activateInline:vi.fn(async()=>{})}));
vi.mock('../src/region/background',()=>({activateRegion:vi.fn(async()=>{})}));
vi.mock('../src/host-permissions',()=>({requireHostAccess:vi.fn(async()=>{})}));
vi.mock('../src/shortcuts/store',async original=>({...await original<typeof import('../src/shortcuts/store')>(),loadShortcutOverrides:vi.fn(async()=>({'web.translate':['Ctrl+Alt+KeyT'],'app.library':['Alt+KeyB']}))}));
vi.mock('../src/i18n/runtime',()=>({msg:(value:string)=>value}));

type Listener=(message:any,sender:chrome.runtime.MessageSender,respond:(value:any)=>void)=>unknown;
const sender:chrome.runtime.MessageSender={id:'extension',url:'https://source.test/chapter',frameId:0,documentId:'document-7',tab:{id:7} as chrome.tabs.Tab};
let listener:Listener,changed:(changes:Record<string,chrome.storage.StorageChange>,area:string)=>void,nativeCommand:(command:string,tab?:chrome.tabs.Tab)=>void;
let tab:Partial<chrome.tabs.Tab>,identity:{instanceId:string;url:string};
const command=(action='web.translate')=>({type:'NC_SHORTCUTS_EXECUTE',action,url:'https://source.test/chapter',instanceId:'instance-7'});
const flush=async()=>{for(let count=0;count<10;count++)await Promise.resolve();};
async function send(message:any,from=sender){
  let result:any;
  const owned=listener(message,from,value=>{result=value;});
  await flush();return {owned,result};
}
beforeEach(()=>{
  vi.clearAllMocks();
  tab={id:7,url:sender.url,active:true};identity={instanceId:'instance-7',url:sender.url!};
  vi.stubGlobal('chrome',{
    runtime:{id:'extension',getURL:(path:string)=>'chrome-extension://extension'+path,onMessage:{addListener:(value:Listener)=>{listener=value;}}},
    storage:{onChanged:{addListener:(value:typeof changed)=>{changed=value;}}},
    commands:{onCommand:{addListener:(value:typeof nativeCommand)=>{nativeCommand=value;}}},
    tabs:{get:vi.fn(async()=>tab),create:vi.fn(async()=>({id:8})),query:vi.fn(async(options:{active?:boolean})=>options.active?[tab]:[{id:7},{id:8}]),sendMessage:vi.fn(async(_id:number,message:{type:string})=>message.type==='NC_SHORTCUTS_ERROR'?{ok:true}:identity)},
  });
  registerWebShortcutsBackground();
});
afterEach(()=>vi.unstubAllGlobals());

describe('website shortcut protocol',()=>{
  it.each([{id:'other'}, {frameId:1}, {tab:undefined}, {url:'chrome://settings'}, {url:'chrome-extension://extension/reader.html'}])('ignores an unauthorized sender %j',async change=>{
    const value=await send(command(),{...sender,...change});
    expect(value).toEqual({owned:undefined,result:undefined});expect(activateRegion).not.toHaveBeenCalled();
  });
  it('does not claim another background protocol',async()=>{
    expect(await send({type:'NC_TRANSLATE_REGION'})).toEqual({owned:undefined,result:undefined});
  });
  it('returns only sanitized preferences to a content script',async()=>{
    expect(await send({type:'NC_SHORTCUTS_GET'})).toEqual({owned:true,result:{ok:true,overrides:{'web.translate':['Ctrl+Alt+KeyT']}}});
    expect(loadShortcutOverrides).toHaveBeenCalledOnce();expect(chrome.tabs.get).not.toHaveBeenCalled();
  });
  it.each(['web.translate','web.shortcuts'])('executes only the own active document for %s',async action=>{
    expect((await send({...command(action),tabId:99})).result).toEqual({ok:true});
    expect(chrome.tabs.get).toHaveBeenCalledWith(7);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7,{type:'NC_SHORTCUTS_IDENTITY'},{frameId:0,documentId:'document-7'});
    if(action==='web.translate')expect(activateInline).toHaveBeenCalledExactlyOnceWith(7);
    if(action==='web.shortcuts'){
      expect(chrome.tabs.create).toHaveBeenCalledWith({url:'chrome-extension://extension/reader.html#settings/shortcuts'});
      expect(requireHostAccess).not.toHaveBeenCalled();
    }else expect(requireHostAccess).toHaveBeenCalledOnce();
  });
  it.each(['web.region','web.pause','web.close','reader.translation','anything'])('rejects unsupported backend action %s',async action=>{
    expect((await send(command(action))).result).toMatchObject({ok:false});
    expect(activateInline).not.toHaveBeenCalled();expect(activateRegion).not.toHaveBeenCalled();
  });
  it.each(['inactive','url','origin','instance','identity-url'])('rejects %s before activation',async change=>{
    if(change==='inactive')tab.active=false;
    if(change==='url')tab.url='https://source.test/other';
    if(change==='instance')identity.instanceId='new-document';
    if(change==='identity-url')identity.url='https://source.test/other';
    const result=await send(command(),change==='origin'?{...sender,url:'https://foreign.test/chapter'}:sender);
    expect(result.result).toMatchObject({ok:false});expect(activateInline).not.toHaveBeenCalled();expect(activateRegion).not.toHaveBeenCalled();
  });
  it('fails closed when permissions have been removed',async()=>{
    vi.mocked(requireHostAccess).mockRejectedValueOnce(Error('restricted'));
    expect((await send(command())).result).toEqual({ok:false,error:'restricted'});expect(activateRegion).not.toHaveBeenCalled();
  });
  it('broadcasts only normalized versioned bindings, not unrelated storage',async()=>{
    changed({'nc-reader-settings':{newValue:{token:'secret'}}},'local');await flush();
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    changed({'nc-shortcuts':{newValue:{version:1,overrides:{'web.translate':['Ctrl+Alt+KeyT'],'app.library':['Alt+KeyB'],unknown:['KeyA']},token:'secret'}}},'local');await flush();
    expect(chrome.tabs.query).toHaveBeenCalledWith({url:['http://*/*','https://*/*']});
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7,{type:'NC_SHORTCUTS_CHANGED',overrides:{'web.translate':['Ctrl+Alt+KeyT']}},{frameId:0});
  });
  it('resets content bindings when the stored version is unsupported',async()=>{
    changed({'nc-shortcuts':{newValue:{version:2,overrides:{'web.translate':['Ctrl+Alt+KeyT']}}}},'local');await flush();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7,{type:'NC_SHORTCUTS_CHANGED',overrides:{}},{frameId:0});
  });
  it('does not broadcast an older change after a slower tab lookup',async()=>{
    let finish!:(tabs:chrome.tabs.Tab[])=>void;
    const pending=new Promise<chrome.tabs.Tab[]>(resolve=>{finish=resolve;});
    vi.mocked(chrome.tabs.query).mockImplementationOnce(()=>pending);
    changed({'nc-shortcuts':{newValue:{version:1,overrides:{'web.translate':['Ctrl+Alt+KeyT']}}}},'local');
    changed({'nc-shortcuts':{newValue:{version:1,overrides:{'web.translate':[]}}}},'local');await flush();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    finish([{id:7} as chrome.tabs.Tab]);await flush();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7,{type:'NC_SHORTCUTS_CHANGED',overrides:{'web.translate':[]}},{frameId:0});
  });
});

describe('native region shortcut authorization',()=>{
  it('reuses region activation only from the registered native command',async()=>{
    nativeCommand('nc-translate-region',tab as chrome.tabs.Tab);await flush();
    expect(requireHostAccess).toHaveBeenCalledOnce();expect(activateRegion).toHaveBeenCalledExactlyOnceWith(7);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it.each(['unknown','inactive','restricted','navigated'])('ignores an invalid command target: %s',async reason=>{
    const source={...tab} as chrome.tabs.Tab;
    if(reason==='inactive')tab.active=false;
    if(reason==='restricted')tab.url='chrome://settings';
    if(reason==='navigated')tab.url='https://source.test/changed';
    nativeCommand(reason==='unknown'?'unknown':'nc-translate-region',source);await flush();
    expect(activateRegion).not.toHaveBeenCalled();expect(requireHostAccess).not.toHaveBeenCalled();
  });
  it('resolves the active focused tab when the browser omits the command tab',async()=>{
    nativeCommand('nc-translate-region');await flush();
    expect(chrome.tabs.query).toHaveBeenCalledWith({active:true,lastFocusedWindow:true});
    expect(activateRegion).toHaveBeenCalledExactlyOnceWith(7);
  });
  it('does not restart the same region while activation is pending',async()=>{
    let finish!:()=>void;vi.mocked(activateRegion).mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
    nativeCommand('nc-translate-region',tab as chrome.tabs.Tab);nativeCommand('nc-translate-region',tab as chrome.tabs.Tab);await flush();
    expect(activateRegion).toHaveBeenCalledOnce();finish();await flush();
  });
  it('shows a permission failure on the current page without capturing',async()=>{
    vi.mocked(requireHostAccess).mockRejectedValueOnce(Error('restricted'));
    nativeCommand('nc-translate-region',tab as chrome.tabs.Tab);await flush();
    expect(activateRegion).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7,{type:'NC_SHORTCUTS_ERROR',error:'restricted'},{frameId:0});
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('offers the existing settings page when an older page has no shortcut script',async()=>{
    vi.mocked(activateRegion).mockRejectedValueOnce(Error('restricted'));
    vi.mocked(chrome.tabs.sendMessage).mockImplementationOnce(()=>Promise.reject(Error('No receiver')));
    nativeCommand('nc-translate-region',tab as chrome.tabs.Tab);await flush();
    expect(chrome.tabs.create).toHaveBeenCalledWith({url:'chrome-extension://extension/reader.html#settings'});
  });
});
