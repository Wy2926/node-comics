import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {consumeSearchSeed, openSearchFromTab, validateSearchSeed} from '../src/sources/runtime/search-entry';
import type {SourceSearchSeed} from '../src/sources/contracts/work';

const book='https://mangacopy.com/comic/search-seed',chapter=book+'/chapter/724f819b-5306-11ea-b7ea-024352452ce0';
const work=()=>({title:'漫画作品名',catalogId:'mangacopy:search-seed',catalogUrl:book,cover:{url:'https://images.example/cover.png'}});
let saved:Record<string,unknown>;
beforeEach(()=>{
  saved={};
  const queue=new Map<string,Promise<unknown>>();
  vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,run:()=>Promise<T>):Promise<T>=>{
    const task=(queue.get(name)??Promise.resolve()).catch(()=>{}).then(run);queue.set(name,task);
    try{return await task;}finally{if(queue.get(name)===task)queue.delete(name);}
  }}});
  vi.stubGlobal('chrome',{
    tabs:{get:vi.fn(async()=>({id:7,url:chapter})),sendMessage:vi.fn(async()=>({url:chapter,work:work()})),create:vi.fn(async()=>({id:8}))},
    scripting:{executeScript:vi.fn(async()=>[])},runtime:{getURL:(path:string)=>'chrome-extension://fixture'+path},
    storage:{session:{get:vi.fn(async(key:string|null)=>structuredClone(key===null?saved:{[key]:saved[key]})),
      set:vi.fn(async(values:Record<string,unknown>)=>{Object.assign(saved,structuredClone(values));}),
      remove:vi.fn(async(keys:string|string[])=>{for(const key of Array.isArray(keys)?keys:[keys])delete saved[key];})}},
  });
});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function putSeed(seed:SourceSearchSeed,createdAt=Date.now()){
  const id=crypto.randomUUID();saved['nc-search-seed:'+id]={createdAt,seed};return id;
}
describe('website search entry authority and short-lived handoff',()=>{
  it('takes an adapter-proven work title and rejects another work, source or unsafe URL',()=>{
    expect(validateSearchSeed(work(),chapter)).toMatchObject({title:'漫画作品名',origin:{sourceId:'mangacopy',catalogId:'mangacopy:search-seed',url:book}});
    for(const change of [{catalogId:'mangacopy:different'}, {catalogUrl:'https://mangacopy.com/comic/different'},
      {catalogUrl:'javascript:alert(1)'},{catalogUrl:'https://mangacopy.com.evil.test/comic/search-seed'}])
      expect(()=>validateSearchSeed({...work(),...change},chapter)).toThrow();
    expect(validateSearchSeed({...work(),cover:{url:'javascript:alert(1)'}},chapter)).not.toHaveProperty('cover');
  });
  it('keeps a blank editable seed instead of guessing a title from an unreliable observation',()=>{
    for(const value of [undefined,{}, {title:''}, {...work(),title:'invalid\nname'}, {...work(),title:'字'.repeat(2001)}])
      expect(validateSearchSeed(value,chapter)).toMatchObject({title:'',origin:{catalogId:'mangacopy:search-seed'}});
    expect(()=>validateSearchSeed(work(),'https://example.org/not-supported')).toThrow();
  });
  it('uses a one-use opaque URL handoff with no title or source URL in the address bar',async()=>{
    await openSearchFromTab(7,chapter);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(7,{type:'NC_DESCRIBE_WORK'},{frameId:0});
    const opened=vi.mocked(chrome.tabs.create).mock.calls[0][0].url!;
    expect(opened).toMatch(/^chrome-extension:\/\/fixture\/reader\.html\?search=[a-f0-9-]{36}$/);
    expect(opened).not.toContain('mangacopy');expect(opened).not.toContain('漫画');
    const id=new URL(opened).searchParams.get('search')!;
    expect(await consumeSearchSeed(id)).toMatchObject({title:'漫画作品名',origin:{catalogId:'mangacopy:search-seed'}});
    await expect(consumeSearchSeed(id)).rejects.toThrow();
    expect(saved['nc-search-seed:'+id]).toBeUndefined();
  });
  it('permits only one concurrent consumer of the same handle',async()=>{
    const id=putSeed(validateSearchSeed(work(),chapter));
    const results=await Promise.allSettled([consumeSearchSeed(id),consumeSearchSeed(id)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
  });
  it('rejects expired, future, malformed and forged stored seeds after deleting their handle',async()=>{
    const seed=validateSearchSeed(work(),chapter);
    for(const time of [Date.now()-5*60_000-1,Date.now()+10_000,NaN]){
      const id=putSeed(seed,time);await expect(consumeSearchSeed(id)).rejects.toThrow();expect(saved['nc-search-seed:'+id]).toBeUndefined();
    }
    for(const altered of [{...seed,title:'bad\nname'}, {...seed,origin:{...seed.origin!,catalogId:'other'}},
      {...seed,origin:{...seed.origin!,url:chapter}}])await expect(consumeSearchSeed(putSeed(altered))).rejects.toThrow();
    await expect(consumeSearchSeed('-'.repeat(36))).rejects.toThrow();
  });
  it('falls back to manual title entry when document metadata is unavailable, but rejects a navigated tab',async()=>{
    vi.mocked(chrome.scripting.executeScript).mockRejectedValueOnce(Error('Injection unavailable'));
    await openSearchFromTab(7,chapter);
    expect(Object.values(saved)[0]).toMatchObject({seed:{title:''}});
    vi.mocked(chrome.tabs.create).mockClear();
    vi.mocked(chrome.tabs.get).mockImplementationOnce(async()=>({id:7,url:chapter} as chrome.tabs.Tab)).mockImplementationOnce(async()=>({id:7,url:book} as chrome.tabs.Tab));
    await expect(openSearchFromTab(7,chapter)).rejects.toThrow();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    await expect(openSearchFromTab(7,undefined,'https://other.test/page')).rejects.toThrow();
  });
  it('bounds retained handles and removes a new handle if opening the extension page fails',async()=>{
    const now=Date.now();
    for(let index=0;index<10;index++)putSeed(validateSearchSeed(work(),chapter),now-index);
    saved.unrelated={preserve:true};
    await openSearchFromTab(7,chapter);
    expect(Object.keys(saved).filter(key=>key.startsWith('nc-search-seed:'))).toHaveLength(8);
    expect(saved.unrelated).toEqual({preserve:true});
    saved={};vi.mocked(chrome.tabs.create).mockRejectedValueOnce(Error('No tab'));
    await expect(openSearchFromTab(7,chapter)).rejects.toThrow('No tab');
    expect(saved).toEqual({});
  });
  it('enforces the eight-handle budget across concurrent tabs without locking browser tab creation',async()=>{
    const now=Date.now();
    for(let index=0;index<7;index++)putSeed(validateSearchSeed(work(),chapter),now-index);
    let finishFirst!:(tab:chrome.tabs.Tab)=>void;
    vi.mocked(chrome.tabs.create).mockImplementationOnce(async()=>new Promise<chrome.tabs.Tab>(resolve=>{finishFirst=resolve;}));
    const first=openSearchFromTab(7,chapter),second=openSearchFromTab(8,chapter);
    await vi.waitFor(()=>expect(chrome.tabs.create).toHaveBeenCalledTimes(2));
    expect(Object.keys(saved).filter(key=>key.startsWith('nc-search-seed:'))).toHaveLength(8);
    await second;
    finishFirst({id:9} as chrome.tabs.Tab);await first;
  });
});
