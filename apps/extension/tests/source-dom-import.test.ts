import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SourceCatalogSnapshot} from '../src/sources/contracts/source';
vi.mock('../src/sources/registry/networks',()=>({sourceNetworks:{}}));
vi.mock('../src/i18n/background',()=>({registerLocaleBackground:()=>async()=>{}}));
vi.mock('../src/inline/background',()=>({activateInline:vi.fn(),registerInlineBackground:vi.fn()}));
import {registerSourceBackground} from '../src/sources/runtime/background';
const url='https://comic.naver.com/webtoon/list?titleId=123',reader='https://comic.naver.com/webtoon/detail?titleId=123&no=1';
const snapshot:SourceCatalogSnapshot={id:'naver:webtoon:123',sourceId:'naver',url,title:'DOM fixture',complete:true,observedAt:1,note:'',groups:[],
  entries:[{id:'episode-1',catalogId:'naver:webtoon:123',remoteId:'1',url:reader,title:'Episode one',order:0,groupIds:[],rawTypes:[],related:false}]};
type Listener=(message:unknown,sender:chrome.runtime.MessageSender,respond:(response:unknown)=>void)=>unknown;
let listener:Listener,current:string;
let read:ReturnType<typeof vi.fn<(url:string)=>Promise<SourceCatalogSnapshot>>>,set:ReturnType<typeof vi.fn>,inject:ReturnType<typeof vi.fn>,create:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  current=url;read=vi.fn(async()=>snapshot);set=vi.fn(async()=>{});inject=vi.fn(async()=>[]);create=vi.fn(async()=>({id:8}));
  vi.stubGlobal('chrome',{
    runtime:{id:'test',getURL:(path:string)=>'chrome-extension://test'+path,onInstalled:{addListener(){}},onMessage:{addListener(fn:Listener){listener=fn;}}},
    contextMenus:{onClicked:{addListener(){}}},storage:{local:{set}},
    scripting:{executeScript:inject},tabs:{get:async()=>({id:7,url:current}),create,sendMessage:async()=>snapshot},
  });
  registerSourceBackground(read);
});
afterEach(()=>{vi.unstubAllGlobals();});
const send=()=>new Promise(resolve=>listener({type:'NC_IMPORT_CURRENT'},{id:'test',url:current,frameId:0,tab:{id:7} as chrome.tabs.Tab},resolve));

describe('DOM import transport compatibility',()=>{
  it('keeps the live catalog snapshot and source tab handoff when no HTTP catalog adapter is available',async()=>{
    expect(await send()).toEqual({ok:true});
    expect(inject).toHaveBeenCalledOnce();expect(read).not.toHaveBeenCalled();
    expect(Object.values(set.mock.calls[0][0])).toEqual([{catalog:snapshot,sourceTabId:7}]);
    expect(create).toHaveBeenCalledOnce();
  });
  it('still confirms complete chapter membership through the DOM catalog reader',async()=>{
    current=reader;
    expect(await send()).toEqual({ok:true});expect(read).toHaveBeenCalledExactlyOnceWith(url);
    expect(inject).not.toHaveBeenCalled();
    expect(Object.values(set.mock.calls[0][0])).toEqual([{catalog:snapshot,selectedEntryId:'episode-1'}]);
  });
  it.each(['missing','incomplete'])('does not create a reader handoff for a %s DOM chapter directory',async mode=>{
    current=reader;read.mockResolvedValue(mode==='missing'?{...snapshot,entries:[]}:{...snapshot,complete:false});
    expect(await send()).toMatchObject({ok:false});expect(set).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
  });
});
