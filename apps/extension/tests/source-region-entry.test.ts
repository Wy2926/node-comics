import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {activateInline} from '../src/inline/background';
import {activateRegion,registerRegionBackground} from '../src/region/background';
import {requireHostAccess} from '../src/host-permissions';
import {registerSourceBackground} from '../src/sources/runtime/background';

vi.mock('../src/i18n/background',()=>({registerLocaleBackground:()=>async()=>{}}));
vi.mock('../src/inline/background',()=>({activateInline:vi.fn(),registerInlineBackground:vi.fn()}));
vi.mock('../src/region/background',()=>({activateRegion:vi.fn(),registerRegionBackground:vi.fn()}));
vi.mock('../src/host-permissions',()=>({requireHostAccess:vi.fn(async()=>{})}));
vi.mock('../src/sources/runtime/image-headers',()=>({recoverImageHeaders:async()=>{}}));

type Listener=(message:unknown,sender:chrome.runtime.MessageSender,respond:(value:unknown)=>void)=>unknown;
type Click=(info:chrome.contextMenus.OnClickData,tab?:chrome.tabs.Tab)=>void|Promise<void>;
const sender:chrome.runtime.MessageSender={id:'test',url:'chrome-extension://test/popup.html'};
const page='https://example.test/comic';
const tab:chrome.tabs.Tab={id:7,url:page,active:true,autoDiscardable:true,discarded:false,frozen:false,groupId:-1,highlighted:true,incognito:false,index:0,pinned:false,selected:true,windowId:1};
let listener:Listener,click:Click,installed:()=>void,currentUrl:string|undefined;
let create:ReturnType<typeof vi.fn>,menu:ReturnType<typeof vi.fn>;
const send=(message:unknown,from=sender)=>new Promise(resolve=>{
  if(listener(message,from,resolve)!==true)resolve(undefined);
});

beforeEach(()=>{
  vi.clearAllMocks();currentUrl=page;
  create=vi.fn(async()=>({id:8}));menu=vi.fn();
  vi.stubGlobal('chrome',{
    runtime:{id:'test',getURL:(path:string)=>'chrome-extension://test/'+path.replace(/^\//,''),
      onInstalled:{addListener(fn:()=>void){installed=fn;}},onMessage:{addListener(fn:Listener){listener=fn;}}},
    storage:{local:{set:async()=>{}}},
    contextMenus:{create:menu,removeAll:(done:()=>void)=>done(),onClicked:{addListener(fn:Click){click=fn;}}},
    tabs:{get:async()=>({...tab,url:currentUrl}),create},
  });
  registerSourceBackground();
});
afterEach(()=>vi.unstubAllGlobals());

describe('region translation entry points',()=>{
  it('registers the region background and a manual ordinary-webpage context menu',async()=>{
    expect(registerRegionBackground).toHaveBeenCalledOnce();installed();
    await vi.waitFor(()=>expect(menu).toHaveBeenCalledWith(expect.objectContaining({id:'nc-translate-region',
      contexts:['page','image','link','selection'],documentUrlPatterns:['http://*/*','https://*/*']})));
  });
  it('routes a trusted popup request only to region activation',async()=>{
    expect(await send({type:'NC_TRANSLATE_REGION',tabId:7,url:page})).toEqual({ok:true,data:true});
    expect(activateRegion).toHaveBeenCalledExactlyOnceWith(7);expect(activateInline).not.toHaveBeenCalled();
  });
  it.each([
    {id:'other',url:'chrome-extension://test/popup.html'},
    {id:'test',url:page,frameId:0,tab},
  ])('does not authorize a website or another extension: %j',async from=>{
    expect(await send({type:'NC_TRANSLATE_REGION',tabId:7,url:page},from)).toBeUndefined();
    expect(activateRegion).not.toHaveBeenCalled();
  });
  it.each([-1,1.5,'7',undefined])('rejects an invalid tab identity: %j',async tabId=>{
    expect(await send({type:'NC_TRANSLATE_REGION',tabId,url:page})).toMatchObject({ok:false});
    expect(activateRegion).not.toHaveBeenCalled();
  });
  it.each([undefined,'chrome://settings','file:///comic.png','https://example.test/next'])('does not activate an unavailable or changed page: %j',async url=>{
    currentUrl=url;
    expect(await send({type:'NC_TRANSLATE_REGION',tabId:7,url:page})).toMatchObject({ok:false});
    expect(activateRegion).not.toHaveBeenCalled();
  });
  it('activates the right-click selection entry after checking installed access',async()=>{
    await click({menuItemId:'nc-translate-region',editable:false},tab);
    expect(requireHostAccess).toHaveBeenCalledOnce();expect(activateRegion).toHaveBeenCalledExactlyOnceWith(7);
    expect(create).not.toHaveBeenCalled();
  });
  it('refuses a right-click target that navigated after the menu opened',async()=>{
    currentUrl='https://example.test/next';await click({menuItemId:'nc-translate-region',editable:false},tab);
    expect(activateRegion).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({url:'chrome-extension://test/reader.html#settings'});
  });
});
