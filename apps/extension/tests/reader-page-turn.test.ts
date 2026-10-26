import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({capture:vi.fn(),instances:[] as any[],fail:false,refuse:false}));
vi.mock('../src/reader/page-snapshot',()=>({pageSnapshot:mocks.capture}));
vi.mock('@gullabs/flipbook-core',()=>({PageFlip:class{
 handlers=new Map();destroy=vi.fn();loadFromHTML=vi.fn(()=>{if(mocks.fail)throw Error('Renderer failed');});
 flipNext=vi.fn(()=>!mocks.refuse);flipPrev=vi.fn(()=>!mocks.refuse);
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
  expect(f.engine.loadFromHTML.mock.calls[0][0]).toHaveLength(4);expect(host.inert).toBe(true);f.turn!.dispose();
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
  expect(viewport.children[0].style.width).toBe('800px');expect(viewport.children[0].children[0].style.left).toBe('-200px');
  expect(mocks.capture.mock.calls[0][3]).toEqual({left:-200,top:0,width:1000,height:600});turn.dispose();
 });
 it('refreshes an arriving image without restarting the engine and disconnects on disposal',()=>{
  let change!:()=>void;const disconnect=vi.fn();
  vi.stubGlobal('MutationObserver',class{constructor(callback:()=>void){change=callback;}observe=vi.fn();disconnect=disconnect;});
  const f=fixture();f.turn!.play(()=>{});frame();const previous=mocks.capture.mock.results[1].value;
  change();expect(previous.dispose).toHaveBeenCalledOnce();expect(f.engine.loadFromHTML).toHaveBeenCalledOnce();expect(f.engine.flipNext).toHaveBeenCalledOnce();
  f.turn!.dispose();expect(disconnect).toHaveBeenCalledOnce();change();expect(mocks.capture).toHaveBeenCalledTimes(3);
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
});
