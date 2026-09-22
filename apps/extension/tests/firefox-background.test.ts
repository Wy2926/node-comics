import { afterEach, expect, it, vi } from 'vitest';
import background from '../entrypoints/background';
import { connectReaderSettings } from '../src/inline/settings';
import { defaults } from '../src/types';

vi.mock('wxt/utils/define-background',()=>({defineBackground:(main:()=>void)=>({main})}));
vi.mock('../src/i18n/background',()=>({registerLocaleBackground:()=>async()=>{}}));
vi.mock('../src/inline/background',()=>({registerInlineBackground:()=>{},activateInline:vi.fn()}));
afterEach(()=>vi.unstubAllGlobals());

it('registers the Firefox import handler without setAccessLevel and opens the copy4000 catalog',async()=>{
  const listeners:((message:unknown,sender:unknown,respond:(data:unknown)=>void)=>unknown)[]=[];
  const url='https://www.copy4000.com/comic/sample';
  const catalog={url,sourceId:'mangacopy',id:'mangacopy:sample',title:'Sample',observedAt:1,complete:false,note:'',groups:[],entries:[]};
  const create=vi.fn(async(_properties:{url:string})=>({id:8})),set=vi.fn(async()=>{});
  vi.stubGlobal('chrome',{
    runtime:{id:'test-extension',getURL:(path:string)=>'moz-extension://test'+path,onInstalled:{addListener:vi.fn()},onMessage:{addListener:(fn:typeof listeners[number])=>listeners.push(fn)}},
    storage:{local:{set}},
    scripting:{executeScript:async()=>[]},
    contextMenus:{onClicked:{addListener:vi.fn()}},
    tabs:{get:async()=>({id:7,url}),sendMessage:async()=>catalog,create},
  });
  expect(()=>background.main()).not.toThrow();
  const result=await new Promise(resolve=>{
    const keepAlive=listeners[0]({type:'NC_IMPORT_CURRENT'},{id:'test-extension',url,frameId:0,tab:{id:7}},resolve);
    expect(keepAlive).toBe(true);
  });
  expect(result).toEqual({ok:true});
  expect(create).toHaveBeenCalledWith({url:expect.stringMatching(/^moz-extension:\/\/test\/reader.html\?catalog=/)});
  const catalogId=new URL(create.mock.calls[0][0].url).searchParams.get('catalog');
  expect(set).toHaveBeenCalledWith({['nc-import:'+catalogId]:{catalog:{...catalog,excludedEntryIds:[]},sourceTabId:7}});
});

it('connects Firefox reader settings without a Chromium-only access-level API',async()=>{
  const set=vi.fn(async()=>{}),addListener=vi.fn();
  vi.stubGlobal('chrome',{storage:{local:{get:async()=>({}),set},onChanged:{addListener}}});
  await expect(connectReaderSettings(defaults)).resolves.toBeUndefined();
  expect(set).toHaveBeenCalledWith({'nc-reader-settings':defaults});
  expect(addListener).toHaveBeenCalledOnce();
});
