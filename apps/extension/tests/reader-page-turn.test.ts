import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({capture:vi.fn(),instances:[] as any[],fail:false,refuse:false}));
vi.mock('../src/reader/page-snapshot',()=>({pageSnapshot:mocks.capture}));
vi.mock('@gullabs/flipbook-core',()=>({PageFlip:class{
 handlers=new Map();destroy=vi.fn();loadFromHTML=vi.fn(()=>{if(mocks.fail)throw Error('Renderer failed');});
 flipNext=vi.fn(()=>!mocks.refuse);flipPrev=vi.fn(()=>!mocks.refuse);
 startUserTouch=vi.fn();userStop=vi.fn();getState=()=> 'user_fold';
 userMove=vi.fn((point:{x:number})=>{this.handlers.get('turnProgress')?.({data:{progress:this.settings.initialPage===0?1-point.x/(this.settings.width*2):point.x/(this.settings.width*2)}});});
 constructor(public host:unknown,public settings:any){mocks.instances.push(this);}
 on(name:string,callback:Function){this.handlers.set(name,callback);}
 finish(){this.handlers.get('changeState')?.({data:{state:'read'}});}
}}));
import {pageTurn} from '../src/reader/page-turn';
class Element extends EventTarget{
 style:Record<string,string>={};dataset:Record<string,string>={};children:Element[]=[];parent?:Element;
 className='';inert=false;clientWidth=800;clientHeight=600;scrollLeft=0;scrollTop=30;
 get childNodes(){return this.children;}
 setAttribute=vi.fn();
 append(...children:Element[]){for(const child of children){child.remove();child.parent=this;this.children.push(child);}}
 replaceChildren(...children:Element[]){for(const child of [...this.children])child.remove();this.append(...children);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=undefined;}
 getBoundingClientRect(){return {left:10,top:20,right:810,bottom:620};}
}
let frames:Map<number,FrameRequestCallback>,id:number;
beforeEach(()=>{
 vi.useFakeTimers();frames=new Map();id=0;mocks.fail=mocks.refuse=false;mocks.instances=[];
 vi.stubGlobal('document',{createElement:()=>new Element()});
 vi.stubGlobal('getComputedStyle',()=>({getPropertyValue:()=> '#f5f5f5'}));
 vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++id,callback);return id;});
 vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
 mocks.capture.mockReset().mockImplementation((_v,_s,columns)=>({leaves:Array.from({length:columns},()=>{const leaf=new Element();leaf.append(new Element());return leaf;}),dispose:vi.fn()}));
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
function fixture(columns=1,sign=-1){
 const viewport=new Element(),surface=Object.assign(new Element(),{querySelectorAll:()=>Array.from({length:columns},()=>new Element())});
 if(columns===2)viewport.dataset.layout='double';
 const turn=pageTurn(viewport as unknown as HTMLDivElement,surface as unknown as HTMLDivElement,sign);
 return {viewport,surface,turn,engine:mocks.instances.at(-1)};
}
function frame(){const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback(20);}
describe('bounded library page curl',()=>{
 it.each([-1,1])('uses one clipped landscape leaf for single-page sign %s without canvas-cloning portrait mode',sign=>{
  const f=fixture(1,sign),host=f.viewport.children[0],book=host.children[0];
  expect(f.engine.settings).toMatchObject({width:800,height:600,usePortrait:false,pointerInput:[],injectStyles:false,initialPage:sign<0?0:2,flippingTime:360});
  expect(book.style).toMatchObject({width:'1600px',left:sign<0?'-800px':'0px'});
  expect(book.style.clipPath).toBe(`inset(0 ${sign>0?800:0}px 0 ${sign<0?800:0}px)`);
  expect(f.engine.loadFromHTML.mock.calls[0][0]).toHaveLength(4);expect(host.inert).toBe(true);
  expect(host.style).toMatchObject({width:'100%',height:'100%'});f.turn!.dispose();
 });
 it('uses a center spine with exactly four faces for double-page reading',()=>{
  const f=fixture(2);expect(f.engine.settings.width).toBe(400);expect(mocks.capture).toHaveBeenCalledWith(f.viewport,f.surface,2,{left:0,top:0,width:800,height:600});
  expect(f.viewport.children[0].children[0].style.width).toBe('800px');f.turn!.dispose();
 });
 it('uses the actual seam for unequal-width double pages without overflowing the viewport',()=>{
  const viewport=new Element();viewport.dataset.layout='double';
  const surface=Object.assign(new Element(),{querySelectorAll:()=>[
   {getBoundingClientRect:()=>({left:10,right:310,top:20,bottom:620})},
   {getBoundingClientRect:()=>({left:310,right:810,top:20,bottom:620})},
  ]});
  const turn=pageTurn(viewport as unknown as HTMLDivElement,surface as unknown as HTMLDivElement,-1)!;
  expect(mocks.instances[0].settings.width).toBe(500);
  expect(viewport.children[0].style.width).toBe('100%');expect(viewport.children[0].children[0].style.left).toBe('-200px');
  expect(mocks.capture.mock.calls[0][3]).toEqual({left:-200,top:0,width:1000,height:600});turn.dispose();
 });
 it('refreshes an arriving image without restarting the engine and disconnects on disposal',()=>{
  let change!:()=>void;const disconnect=vi.fn();
  vi.stubGlobal('MutationObserver',class{constructor(callback:()=>void){change=callback;}observe=vi.fn();disconnect=disconnect;});
  const f=fixture();f.turn!.play(()=>{});frame();const previous=mocks.capture.mock.results[1].value;
  change();expect(previous.dispose).toHaveBeenCalledOnce();expect(f.engine.loadFromHTML).toHaveBeenCalledOnce();expect(f.engine.flipNext).toHaveBeenCalledOnce();
  f.turn!.dispose();expect(disconnect).toHaveBeenCalledOnce();change();expect(mocks.capture).toHaveBeenCalledTimes(3);
 });
 it('reveals the destination before commit and retains its ready paper through the live-page handoff',()=>{
  const f=fixture(),preview=new Element() as unknown as HTMLDivElement;
  f.turn!.preview(preview);expect(mocks.capture).toHaveBeenCalledTimes(2);expect(mocks.capture.mock.calls[1][1]).toBe(preview);
  f.turn!.drag({x:700,y:300},{x:200,y:250});f.turn!.play(()=>{});frame();
  expect(mocks.capture).toHaveBeenCalledTimes(2);expect(f.engine.flipNext).not.toHaveBeenCalled();
  f.turn!.preview(f.surface as unknown as HTMLDivElement);expect(mocks.capture).toHaveBeenCalledTimes(2);f.turn!.dispose();
  for(const result of mocks.capture.mock.results)expect(result.value.dispose).toHaveBeenCalledOnce();
 });
 it.each([-1,1])('captures the committed destination before calling the library for sign %s, then releases both snapshots',async sign=>{
  const f=fixture(1,sign),done=vi.fn(()=>f.turn!.dispose());f.turn!.play(done);
  expect(mocks.capture).toHaveBeenCalledTimes(2);expect(f.engine.flipNext).not.toHaveBeenCalled();expect(f.engine.flipPrev).not.toHaveBeenCalled();
  frame();expect(sign<0?f.engine.flipNext:f.engine.flipPrev).toHaveBeenCalledExactlyOnceWith('bottom');expect(done).not.toHaveBeenCalled();
  f.engine.finish();await Promise.resolve();expect(done).toHaveBeenCalledOnce();expect(f.engine.destroy).toHaveBeenCalledOnce();
  for(const result of mocks.capture.mock.results)expect(result.value.dispose).toHaveBeenCalledOnce();expect(f.viewport.children).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
 });
 it('cancels pending frames and ignores a completion already queued before disposal',async()=>{
  const f=fixture(),done=vi.fn();f.turn!.play(done);f.engine.finish();f.turn!.dispose();f.turn!.dispose();frame();await Promise.resolve();vi.runAllTimers();
  expect(done).not.toHaveBeenCalled();expect(f.engine.flipNext).not.toHaveBeenCalled();expect(f.engine.destroy).toHaveBeenCalledOnce();expect(frames.size).toBe(0);
 });
 it('keeps a pinned old paper aligned to native scrolling until disposed',()=>{
  const f=fixture(),host=f.viewport.children[0];f.viewport.scrollTop=90;f.viewport.dispatchEvent(new Event('scroll'));expect(host.style.top).toBe('90px');
  f.turn!.dispose();f.viewport.scrollTop=150;f.viewport.dispatchEvent(new Event('scroll'));expect(host.style.top).toBe('90px');
 });
 it('falls back to the committed page if the library refuses or loses its completion',()=>{
  const f=fixture(),done=vi.fn(()=>f.turn!.dispose());mocks.refuse=true;f.turn!.play(done);frame();vi.runAllTimers();expect(done).toHaveBeenCalledOnce();
  mocks.refuse=false;const g=fixture(),fallback=vi.fn(()=>g.turn!.dispose());g.turn!.play(fallback);frame();vi.advanceTimersByTime(800);expect(fallback).toHaveBeenCalledOnce();expect(g.engine.destroy).toHaveBeenCalledOnce();
 });
 it('cleans a failed renderer initialization so reading can continue',()=>{
  mocks.fail=true;const f=fixture();expect(f.turn).toBeUndefined();expect(f.viewport.children).toHaveLength(0);expect(mocks.capture.mock.results[0].value.dispose).toHaveBeenCalledOnce();expect(f.engine.destroy).toHaveBeenCalledOnce();
 });
 it.each([-1,1])('coalesces pointer moves and seeds the physical edge before crossing the spine, sign %s',sign=>{
  const f=fixture(1,sign),start={x:400,y:300};
  f.turn!.drag(start,{x:400+sign*20,y:320});f.turn!.drag(start,{x:400+sign*450,y:340});
  expect(f.engine.userMove).not.toHaveBeenCalled();expect(frames.size).toBe(1);frame();
  expect(f.engine.startUserTouch).toHaveBeenCalledExactlyOnceWith({x:sign<0?1600:0,y:320});
  expect(f.engine.userMove.mock.calls).toEqual([[{x:sign<0?1594:6,y:320},true],[{x:sign<0?700:900,y:320},true]]);
  expect(f.turn!.canCommit()).toBe(true);expect(mocks.capture).toHaveBeenCalledOnce();
  expect(f.engine.userMove).toHaveBeenCalledTimes(2);f.turn!.dispose();
 });
 it('settles an accepted drag from its current fold without replaying a programmed turn',async()=>{
  const f=fixture(),done=vi.fn(()=>f.turn!.dispose());
  f.turn!.drag({x:700,y:300},{x:200,y:250});expect(f.turn!.canCommit()).toBe(true);
  f.turn!.play(done);frame();expect(f.engine.userStop).toHaveBeenCalledExactlyOnceWith({x:600,y:230},false);
  expect(f.engine.flipNext).not.toHaveBeenCalled();f.engine.finish();await Promise.resolve();expect(done).toHaveBeenCalledOnce();
 });
 it('returns a short drag using the library without reading or cloning a destination',async()=>{
  const f=fixture(),done=vi.fn(()=>f.turn!.dispose());
  f.turn!.drag({x:700,y:300},{x:650,y:350});f.turn!.revert(done);frame();
  expect(mocks.capture).toHaveBeenCalledOnce();expect(f.engine.userStop).toHaveBeenCalledExactlyOnceWith({x:1500,y:330},false);
  expect(f.engine.flipNext).not.toHaveBeenCalled();f.engine.finish();await Promise.resolve();expect(done).toHaveBeenCalledOnce();
 });
 it('uses the library touch-flick path and the grabbed corner for an early release',()=>{
  const f=fixture();f.turn!.drag({x:700,y:100},{x:650,y:110});expect(f.turn!.canCommit()).toBe(false);
  f.turn!.play(()=>{});frame();expect(f.engine.userStop).toHaveBeenCalledWith({x:1500,y:90},true);
  expect(f.engine.flipNext).toHaveBeenCalledExactlyOnceWith('top');f.turn!.dispose();
 });
 it('keeps double-page motion at pointer scale and cancels an unpainted drag on disposal',()=>{
  const f=fixture(2);f.turn!.drag({x:700,y:300},{x:500,y:350});frame();
  expect(f.engine.userMove).toHaveBeenLastCalledWith({x:600,y:330},true);expect(f.turn!.canCommit()).toBe(false);
  f.turn!.drag({x:700,y:300},{x:100,y:350});f.turn!.dispose();frame();expect(f.engine.userMove).toHaveBeenCalledTimes(2);
 });
});
