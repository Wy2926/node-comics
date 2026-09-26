import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SourceSearchResult} from '../src/sources/contracts/search';

// Exercise the component's effects and real request pool without a browser DOM.
const hooks=vi.hoisted(()=>({cursor:0,state:0,effects:[] as {deps:unknown[];cleanup?:()=>void}[],pending:[] as (()=>void)[]}));
const images=vi.hoisted(()=>({read:vi.fn<(hit:SourceSearchResult,signal?:AbortSignal)=>Promise<Blob>>()}));
vi.mock('react',()=>({
  useRef:()=>({current:null}),
  useState:()=>[hooks.state++===0?undefined:true,()=>{}], // The cover is visible in this fixture.
  useEffect:(callback:()=>void|(()=>void),deps:unknown[])=>{
    const index=hooks.cursor++,previous=hooks.effects[index];
    if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))hooks.pending.push(()=>{
      previous?.cleanup?.();hooks.effects[index]={deps,cleanup:callback()||undefined};
    });
  },
}));
vi.mock('../src/sources',()=>({readSearchCover:images.read}));
import {SearchResultCover,searchResultCoverKey} from '../src/ui/comic-search/SearchResultCover';

const hit:SourceSearchResult={sourceId:'fixture',siteId:'main',key:'same-work',catalogId:'fixture:one',
  catalogUrl:'https://fixture.test/book/one',title:'Work',cover:{url:'https://images.test/one.jpg'}};
const flush=async()=>{for(let index=0;index<20;index++)await Promise.resolve();};
const cleanup=()=>{for(const effect of hooks.effects)effect.cleanup?.();hooks.effects=[];hooks.pending=[];};
async function render(value:SourceSearchResult,cache:Map<string,string>){
  hooks.cursor=0;hooks.state=0;SearchResultCover({hit:value,cache});
  while(hooks.pending.length)hooks.pending.shift()!();
  await flush();
}
beforeEach(()=>{
  images.read.mockReset();
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({height:216,close:vi.fn()})));
  vi.stubGlobal('OffscreenCanvas',class {
    getContext(){return {drawImage:vi.fn()};}
    async convertToBlob(){return new Blob(['thumbnail'],{type:'image/webp'});}
  });
});
afterEach(async()=>{cleanup();await flush();vi.unstubAllGlobals();});

describe('search result cover lifecycle',()=>{
  it('keeps an in-flight cover when a mirror enriches metadata and then reuses the finished thumbnail',async()=>{
    let finish!:(blob:Blob)=>void;
    images.read.mockImplementation((_hit,signal)=>new Promise((resolve,reject)=>{
      finish=resolve;signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});
    }));
    const cache=new Map<string,string>();await render(hit,cache);
    const signal=images.read.mock.calls[0][1]!;
    await render({...hit,cover:{...hit.cover!},authors:['Mirror author'],latestLabel:'New chapter'},cache);
    expect(images.read).toHaveBeenCalledTimes(1);expect(signal.aborted).toBe(false);
    finish(new Blob(['original']));await flush();
    expect(cache.has(searchResultCoverKey(hit))).toBe(true);
    cleanup();await render({...hit,authors:['Updated']},cache);expect(images.read).toHaveBeenCalledTimes(1);
    for(const url of cache.values())URL.revokeObjectURL(url);
  });
  it.each([
    {sourceId:'another'},{siteId:'mirror'},{catalogId:'fixture:two'},
    {catalogUrl:'https://mirror.test/book/one'},{key:'another-key'},{cover:{url:'https://images.test/two.jpg'}},
  ])('cancels and rechecks when the runtime cover identity changes: %j',async changed=>{
    images.read.mockImplementation((_hit,signal)=>new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true})));
    const cache=new Map<string,string>();await render(hit,cache);
    const signal=images.read.mock.calls[0][1]!;
    await render({...hit,...changed},cache);
    expect(signal.aborted).toBe(true);expect(images.read).toHaveBeenCalledTimes(2);
    cleanup();expect(images.read.mock.calls[1][1]!.aborted).toBe(true);
  });
});
