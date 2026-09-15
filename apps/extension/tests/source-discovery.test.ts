import {afterEach,describe,expect,it,vi} from 'vitest';
import {advanceMangaCopyDiscovery,pollSourceDiscovery} from '../src/sources/discovery';
import {discoverDocument} from '../src/sources/adapters';
import {grantImagePermissions} from '../src/library/acquisition';
import {makeCopy} from '../src/library/model';
import {discoverMangaCopyCatalog} from '../src/sources/mangacopy';

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
const snapshot=(count:number,total=6)=>({items:Array.from({length:count},(_,n)=>({id:'slot-'+n,url:'https://images.example/'+n,width:800,height:1200,order:n})),knownTotal:total,discoveryComplete:count===total,note:`已发现 ${count} / ${total} 页`});
function documentFixture(urls:string[],total:number){
 const images=urls.map(url=>({getAttribute:(name:string)=>name==='data-src'?url:'placeholder.png',naturalWidth:165,naturalHeight:211,getBoundingClientRect:()=>({top:30})}));
 return {scrollingElement:{scrollHeight:6000},title:'MangaCopy sample',querySelectorAll:()=>images,querySelector:(selector:string)=>selector==='.comicCount'?{textContent:String(total)}:selector==='.comicContent-list img'?images[0]:{}} as unknown as Document;
}

describe('MangaCopy source discovery',()=>{
 it('does not mark an empty directory skeleton complete before links arrive',()=>{
  const panel={id:'default全部',querySelectorAll:()=>[]};
  const table={previousElementSibling:{textContent:'默认'},querySelectorAll:()=>[panel]};
  const doc={title:'Sample',querySelector:()=>null,querySelectorAll:()=>[table]} as unknown as Document;
  expect(discoverMangaCopyCatalog(doc,'https://www.mangacopy.com/comic/sample')).toMatchObject({complete:false,entries:[]});
 });
 it('keeps missing lazy slots partial and preserves the prefix page order',()=>{
  const result=discoverDocument(documentFixture(['https://images.example/1','','https://images.example/3'],3),'https://www.mangacopy.com/comic/a/chapter/1');
  expect(result.discoveryComplete).toBe(false);expect(result.items.map(p=>p.id)).toEqual(['slot-0']);
  expect(result.items[0]).toMatchObject({width:800,height:1200});
 });
 it('waits for delayed scroll growth and moves to the middle and takes a substantial step when already there',async()=>{
  vi.useFakeTimers();
  const doc=documentFixture(['https://images.example/1'],2);
  let changed:()=>void=()=>{};
  vi.stubGlobal('MutationObserver',class{constructor(callback:()=>void){changed=callback;}observe(){}disconnect(){}});
  const images=doc.querySelectorAll('.comicContent-list img') as unknown as unknown[];
  const view={scrollY:0,innerHeight:800,location:{href:'https://www.mangacopy.com/comic/a/chapter/1'},scrollTo:vi.fn(({top}:{top:number})=>{view.scrollY=top;setTimeout(()=>{images.push(documentFixture(['https://images.example/2'],1).querySelectorAll('img')[0]);changed();},250);})};
  const promise=advanceMangaCopyDiscovery(doc,view as unknown as Window);let returned=false;void promise.then(()=>{returned=true;});
  await vi.advanceTimersByTimeAsync(200);expect(returned).toBe(false);
  await vi.advanceTimersByTimeAsync(100);expect((await promise).discoveryComplete).toBe(true);expect(view.scrollTo).toHaveBeenCalledWith({top:2600,behavior:'instant'});
  const delayedDoc=documentFixture(['https://images.example/1'],2);
  // The first image's viewport top changes with scrolling, keeping its document anchor stable.
  (delayedDoc.querySelector('.comicContent-list img') as unknown as {getBoundingClientRect:()=>{top:number}}).getBoundingClientRect=()=>({top:30-view.scrollY});
  const next=advanceMangaCopyDiscovery(delayedDoc,view as unknown as Window);
  expect(view.scrollTo).toHaveBeenLastCalledWith({top:3000,behavior:'instant'});
  await vi.advanceTimersByTimeAsync(1000);expect(view.scrollTo).toHaveBeenLastCalledWith({top:110,behavior:'instant'});
  await vi.advanceTimersByTimeAsync(1000);expect((await next).discoveryComplete).toBe(false);expect(view.scrollTo).toHaveBeenLastCalledWith({top:2600,behavior:'instant'});
 });
 it('keeps polling slow incremental manifests until the trusted total matches',async()=>{
  vi.useFakeTimers();let count=0;
  const progress=vi.fn(async()=>{}),poll=vi.fn(async()=>snapshot(Math.min(6,++count)));
  const result=pollSourceDiscovery(poll,{onProgress:progress});await vi.advanceTimersByTimeAsync(1500);
  expect((await result).items).toHaveLength(6);expect(progress).toHaveBeenCalledTimes(6);
 });
 it('checks pause even when the page has stopped yielding new links',async()=>{
  vi.useFakeTimers();let checks=0;
  const poll=vi.fn(async()=>snapshot(1));
  const result=pollSourceDiscovery(poll,{assertActive:async()=>{if(++checks===3)throw Error('已暂停');}});
  const assertion=expect(result).rejects.toThrow('已暂停');await vi.advanceTimersByTimeAsync(250);await assertion;
  expect(poll).toHaveBeenCalledTimes(1);
 });
 it('reports a bounded actionable incomplete result instead of declaring success',async()=>{
  vi.useFakeTimers();const result=pollSourceDiscovery(async()=>snapshot(3));
  const assertion=expect(result).rejects.toThrow('40 秒未发现新图片');await vi.advanceTimersByTimeAsync(41000);await assertion;
 });
 it('aborts pending polling without waiting for the inactivity deadline',async()=>{
  vi.useFakeTimers();const controller=new AbortController();
  const result=pollSourceDiscovery(async()=>null,{signal:controller.signal});
  const assertion=expect(result).rejects.toThrow('停止');await vi.advanceTimersByTimeAsync(1);controller.abort(Error('停止'));await assertion;
 });
 it('requests known source and image permissions synchronously from the click',async()=>{
  const request=vi.fn(async()=>false);vi.stubGlobal('chrome',{runtime:{id:'extension'},permissions:{request}});
  const copy={...makeCopy('sample',[]),sourceUrl:'https://www.mangacopy.com/comic/a/chapter/1',pages:[{sourceUrl:'https://images.example/page.jpg'}] as unknown as Parameters<typeof makeCopy>[1]};
  const result=grantImagePermissions([copy.id],[copy]);
  expect(request).toHaveBeenCalledWith({origins:['https://www.mangacopy.com/*','https://images.example/*']});
  await expect(result).rejects.toThrow('未获授权');
 });
});
