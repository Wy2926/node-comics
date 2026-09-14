import {describe,expect,it,vi} from 'vitest';
import {AutomaticTranslationQueue,normalizeAhead,translationWindow} from '../src/reader/automatic';
import {pageFrame,thumbnailRows} from '../src/reader/geometry';
import {emptyPage} from '../src/reader/model';
const pages=Array.from({length:120},(_,i)=>({...emptyPage(`Page ${i+1}`,800,1200),id:String(i)}));
const deferred=()=>{let resolve!:(value:boolean)=>void;const promise=new Promise<boolean>(r=>{resolve=r;});return {promise,resolve};};

describe('reading-position automatic translation',()=>{
  it('includes the current page and ten following pages, clips at the end, and supports zero ahead',()=>{
    expect(translationWindow(pages,20,10).map(p=>p.id)).toEqual(Array.from({length:11},(_,i)=>String(i+20)));
    expect(translationWindow(pages,119,10)).toEqual([pages[119]]);
    expect(translationWindow(pages,30,0)).toEqual([pages[30]]);
    expect([undefined,NaN,Infinity,-1,2.9,100].map(normalizeAhead)).toEqual([10,10,10,0,2,50]);
  });
  it('continues beyond fifty pages, respects batch limits and never resubmits overlapping or revisited pages',async()=>{
    const queue=new AutomaticTranslationQueue();const submitted:string[]=[];
    const prepare=vi.fn(async(batch:typeof pages)=>{expect(batch.length).toBeLessThanOrEqual(4);submitted.push(...batch.map(p=>p.id));return true;});
    for(const index of [0,8,16,24,32,40,48,56,64,8,0]){queue.setWindow(translationWindow(pages,index,10));await queue.drain(4,prepare);}
    expect(submitted).toHaveLength(75);expect(new Set(submitted).size).toBe(75);
  });
  it('discards stale preparation after a jump and processes the latest window despite an in-flight drain',async()=>{
    const queue=new AutomaticTranslationQueue();const wait=deferred();let current=()=>true;const submitted:string[][]=[];
    queue.setWindow(pages.slice(0,11));
    const work=queue.drain(4,async(batch,live)=>{if(batch[0].id==='0'){current=live;return wait.promise;}submitted.push(batch.map(p=>p.id));return true;});
    queue.setWindow(pages.slice(80,83));await queue.drain(4,async()=>{throw Error('Concurrent drain');});
    expect(current()).toBe(false);wait.resolve(false);await work;
    expect(submitted).toEqual([['80','81','82']]);
  });
  it('keeps an already submitted batch deduplicated when a jump happens during its response',async()=>{
    const queue=new AutomaticTranslationQueue();const wait=deferred();const submitted:string[][]=[];
    queue.setWindow(pages.slice(0,4));const work=queue.drain(4,async batch=>{submitted.push(batch.map(p=>p.id));return submitted.length===1?wait.promise:true;});
    queue.setWindow(pages.slice(2,6));wait.resolve(true);await work;
    expect(submitted).toEqual([['0','1','2','3'],['4','5']]);
  });
  it('stops on reset and does not let an old session consume pages from a new session',async()=>{
    const queue=new AutomaticTranslationQueue();const wait=deferred();let current=()=>true;
    queue.setWindow(pages.slice(0,11));const prepare=vi.fn(async(_batch:typeof pages,live:()=>boolean)=>{current=live;return wait.promise;});
    const work=queue.drain(4,prepare);queue.reset();queue.setWindow(pages.slice(20,22));expect(current()).toBe(false);wait.resolve(true);await work;
    expect(prepare).toHaveBeenCalledTimes(1);const next=vi.fn(async()=>true);await queue.drain(4,next);expect(next.mock.calls).toHaveLength(1);
  });
  it('retries a lock-blocked window on the next drain without marking it attempted',async()=>{
    const queue=new AutomaticTranslationQueue();queue.setWindow(pages.slice(0,2));await queue.drain(4,async()=>false);
    const next=vi.fn(async()=>true);await queue.drain(4,next);expect(next).toHaveBeenCalledWith(pages.slice(0,2),expect.any(Function));
  });
  it('retries only transient preparation failures without retrying completed or permanently failed pages',async()=>{
    const queue=new AutomaticTranslationQueue();queue.setWindow(pages.slice(0,3));
    await queue.drain(4,async()=>({retry:['1']}));
    const next=vi.fn(async()=>true);await queue.drain(4,next);
    expect(next).toHaveBeenCalledExactlyOnceWith([pages[1]],expect.any(Function));
  });
});

describe('available reader area and directory geometry',()=>{
  it('fills wide viewports without a 900px cap and fits portrait/landscape pages without cropping',()=>{
    expect(pageFrame(pages[0],{width:1600,height:1000},'width').width).toBe(1576);
    expect(pageFrame(pages[0],{width:1600,height:1000},'window')).toEqual({width:640,height:960});
    expect(pageFrame({width:1600,height:800},{width:400,height:900},'window')).toEqual({width:376,height:188});
    expect(pageFrame(pages[0],{width:1600,height:1000},'window',100,true)).toEqual({width:1280,height:960});
  });
  it('uses full directory width and non-overlapping variable heights, including page management',()=>{
    const rows=thumbnailRows([pages[0],{...pages[1],width:1600,height:800}],322,false);
    expect(rows[0].pictureHeight).toBe(480);expect(rows[1].pictureHeight).toBe(160);expect(rows[1].top).toBe(rows[0].height);
    expect(thumbnailRows(pages.slice(0,2),322,true)[1].top).toBe(rows[0].height+40);
  });
});
