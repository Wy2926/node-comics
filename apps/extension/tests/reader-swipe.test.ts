import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const hooks=vi.hoisted(()=>({cursor:0,effectCursor:0,refs:[] as {current:unknown}[],effects:[] as {deps:unknown[];cleanup?:()=>void}[],pending:[] as (()=>void)[]}));
const snapshots=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('../src/reader/page-turn',()=>({pageTurn:snapshots.create}));
vi.mock('react',async original=>({
 ...await original<typeof import('react')>(),
 useRef:(current:unknown)=>hooks.refs[hooks.cursor++]??(hooks.refs[hooks.cursor-1]={current}),
 useLayoutEffect:(effect:()=>void|(()=>void),deps?:unknown[])=>{
  const index=hooks.effectCursor++,previous=hooks.effects[index];
  if(previous&&deps&&deps.every((value,i)=>Object.is(value,previous.deps[i])))return;
  hooks.pending.push(()=>{previous?.cleanup?.();hooks.effects[index]={deps:deps??[],cleanup:effect()||undefined};});
 },
}));
import {usePagedSwipe} from '../src/reader/usePagedSwipe';

type Options=Parameters<typeof usePagedSwipe>[0];
class Events{
 listeners=new Map<string,Set<(event:any)=>void>>();
 addEventListener(name:string,listener:(event:any)=>void){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name)!.add(listener);}
 removeEventListener(name:string,listener:(event:any)=>void){this.listeners.get(name)?.delete(listener);}
 emit(name:string,values:Record<string,unknown>={}){
  const event={preventDefault:vi.fn(),stopPropagation:vi.fn(),...values};
  for(const listener of [...this.listeners.get(name)??[]])listener(event);
  return event;
 }
}
class Surface extends Events{
 clientWidth=800;clientHeight=600;scrollWidth=800;
 dataset:Record<string,string>={};captures=new Set<number>();
 style={transform:'',willChange:'',visibility:'',removeProperty:(name:string)=>{
  if(name==='transform')this.style.transform='';if(name==='will-change')this.style.willChange='';if(name==='visibility')this.style.visibility='';
 }};
 setPointerCapture(id:number){this.captures.add(id);}
 hasPointerCapture(id:number){return this.captures.has(id);}
 releasePointerCapture(id:number){this.captures.delete(id);}
}
function snapshot(){
 let done=()=>{};
 const result={pinned:true,position:vi.fn(),preview:vi.fn(),drag:vi.fn(),canCommit:vi.fn(()=>false),revert:vi.fn((callback:()=>void)=>{done=callback;}),play:vi.fn((callback:()=>void)=>{done=callback;}),finish:()=>done(),dispose:vi.fn(()=>{result.pinned=false;})};
 return result;
}
let browser:Events&{matchMedia:()=>{matches:boolean};getSelection:()=>{toString:()=>string};visualViewport:{scale:number}};
let documentEvents:Events&{hidden:boolean};
let reduced=false,selection='';
function fixture(extra:Partial<Options>={}){
 const viewport=new Surface(),surface=new Surface();
 const options:Options={viewport:{current:viewport as unknown as HTMLDivElement},surface:{current:surface as unknown as HTMLDivElement},enabled:true,blocked:false,direction:'ltr',identity:'page-1',resetKey:'single',canTurn:vi.fn(()=>true),onTurn:vi.fn(),onSettled:vi.fn(),onActivityChange:vi.fn(),...extra};
 let controls:ReturnType<typeof usePagedSwipe>;
 const render=(changes:Partial<Options>={})=>{
  Object.assign(options,changes);hooks.cursor=0;hooks.effectCursor=0;hooks.pending=[];
  controls=usePagedSwipe(options);for(const effect of hooks.pending)effect();return controls;
 };
 render();
 const pointer=(name:string,x:number,y=100,extra:Record<string,unknown>={})=>{
  const event={pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1,clientX:x,clientY:y,timeStamp:0,target:{closest:()=>null},...extra};
  if(name==='pointerdown'){browser.emit(name,event);return viewport.emit(name,event);}
  return browser.emit(name,event);
 };
 return {options,viewport,surface,render,pointer,get controls(){return controls;},get snapshot(){return snapshots.create.mock.results.at(-1)!.value as ReturnType<typeof snapshot>;},finish:()=>snapshots.create.mock.results.at(-1)!.value.finish()};
}
beforeEach(()=>{
 vi.useFakeTimers();reduced=false;selection='';hooks.refs=[];hooks.effects=[];hooks.pending=[];
 snapshots.create.mockReset().mockImplementation(()=>snapshot());
 browser=Object.assign(new Events(),{matchMedia:()=>({matches:reduced}),getSelection:()=>({toString:()=>selection}),visualViewport:{scale:1}});
 documentEvents=Object.assign(new Events(),{hidden:false});
 vi.stubGlobal('window',browser);vi.stubGlobal('document',documentEvents);vi.stubGlobal('ResizeObserver',undefined);
});
afterEach(()=>{
 for(const effect of hooks.effects)effect.cleanup?.();
 vi.useRealTimers();vi.unstubAllGlobals();
});

describe('library page-turn input and reading lifecycle',()=>{
 it('navigates immediately, then plays the library after identity commits without waiting for images',()=>{
  const f=fixture();f.controls.turn(1);
  expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);expect(f.snapshot.play).not.toHaveBeenCalled();
  expect(f.surface.style.visibility).toBe('hidden');expect(f.viewport.dataset.swipePhase).toBe('entering');
  f.render({identity:'page-2'});expect(f.snapshot.play).toHaveBeenCalledOnce();expect(f.surface.style.visibility).toBe('');
  expect(f.options.onSettled).not.toHaveBeenCalled();f.finish();expect(f.options.onSettled).toHaveBeenCalledOnce();
  expect(f.snapshot.dispose).toHaveBeenCalledOnce();expect(f.viewport.dataset.swipePhase).toBeUndefined();
  expect(vi.mocked(f.options.onActivityChange!).mock.calls).toEqual([[true],[false]]);
 });
 it('handles a synchronous React identity commit in the same turn call',()=>{
  const f=fixture();vi.mocked(f.options.onTurn).mockImplementation(()=>{f.render({identity:'page-2'});});
  f.controls.turn(1);expect(f.snapshot.play).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);f.finish();expect(f.snapshot.pinned).toBe(false);
 });
 it('does not animate an unchanged identity or queue repeated pending commands',()=>{
  const f=fixture();f.controls.turn(1);f.controls.turn(1);f.controls.turn(-1);f.render();
  expect(f.options.onTurn).toHaveBeenCalledOnce();expect(f.snapshot.play).not.toHaveBeenCalled();
  f.render({identity:'page-2'});f.finish();expect(f.options.onTurn).toHaveBeenCalledOnce();
 });
 it.each([1,-1] as const)('interrupts a committed curl for a new %s turn and ignores stale completion',delta=>{
  const f=fixture();f.controls.turn(1);f.render({identity:'page-2'});const old=f.snapshot;
  f.controls.turn(delta);expect(old.dispose).toHaveBeenCalledOnce();expect(f.options.onTurn).toHaveBeenNthCalledWith(2,delta);
  old.finish();expect(f.options.onSettled).not.toHaveBeenCalled();expect(f.snapshot.pinned).toBe(true);
  f.render({identity:'page-3'});f.finish();expect(f.options.onSettled).toHaveBeenCalledOnce();
 });
 it('keeps six quick turns bounded to one engine and releases every pin',()=>{
  const f=fixture();for(let n=2;n<=7;n++){f.controls.turn(1);f.render({identity:`page-${n}`});vi.advanceTimersByTime(80);expect(snapshots.create.mock.results.filter(r=>r.value.pinned)).toHaveLength(1);}
  f.finish();vi.runAllTimers();expect(f.options.onTurn).toHaveBeenCalledTimes(6);expect(f.options.onSettled).toHaveBeenCalledOnce();
  expect(snapshots.create.mock.results.every(r=>r.value.dispose.mock.calls.length===1)).toBe(true);
 });
 it.each(['ltr','rtl'] as const)('maps command and swipe direction to physical paper movement for %s',direction=>{
  const f=fixture({direction}),sign=direction==='ltr'?-1:1;
  f.controls.turn(1);expect(snapshots.create).toHaveBeenLastCalledWith(f.viewport,f.surface,sign);
  f.render({identity:'page-2'});f.finish();f.controls.turn(-1);expect(snapshots.create).toHaveBeenLastCalledWith(f.viewport,f.surface,-sign);
  f.render({identity:'page-1'});f.finish();f.pointer('pointerdown',500);f.pointer('pointermove',500+sign*200,105,{timeStamp:200});
  expect(f.surface.style.transform).toBe('');expect(f.viewport.captures.has(1)).toBe(true);
  f.pointer('pointerup',500+sign*200,105,{timeStamp:210});expect(f.options.onTurn).toHaveBeenLastCalledWith(1);expect(snapshots.create).toHaveBeenLastCalledWith(f.viewport,f.surface,sign);
 });
 it('accepts a new swipe during curl without stealing an interactive press',()=>{
  const f=fixture();f.controls.turn(1);f.render({identity:'page-2'});const old=f.snapshot;
  f.pointer('pointerdown',500,100,{target:{closest:()=>({})}});expect(old.pinned).toBe(true);
  f.pointer('pointerdown',500,100,{pointerType:'touch'});expect(old.pinned).toBe(false);
  f.pointer('pointermove',300,100,{timeStamp:200});f.pointer('pointerup',300,100,{timeStamp:210});expect(f.options.onTurn).toHaveBeenCalledTimes(2);
 });
 it.each(['mouse','touch'])('follows %s during a drag without navigating and supports a quick short flick',pointerType=>{
  const f=fixture();f.pointer('pointerdown',500,100,{pointerType});f.pointer('pointermove',460,100,{timeStamp:30,pointerType});
  expect(f.surface.style.transform).toBe('');expect(f.surface.style.visibility).toBe('hidden');expect(snapshots.create).toHaveBeenCalledOnce();
  expect(f.snapshot.drag).toHaveBeenLastCalledWith({x:500,y:100},{x:460,y:100});expect(f.options.onTurn).not.toHaveBeenCalled();
  f.pointer('pointerup',460,100,{timeStamp:40});expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);
  expect(snapshots.create).toHaveBeenCalledOnce();
 });
 it('does not cancel when implicit image capture transfers to the viewport',()=>{
  const f=fixture();f.pointer('pointerdown',500,100,{pointerType:'touch'});f.pointer('pointermove',300,100,{timeStamp:200});
  f.viewport.emit('lostpointercapture',{pointerId:1,target:{tagName:'IMG'}});expect(f.viewport.dataset.swipePhase).toBe('dragging');
  f.pointer('pointerup',300,100,{timeStamp:210});expect(f.options.onTurn).toHaveBeenCalledOnce();
 });
 it('leaves a slow short swipe in place and suppresses only the trailing click',()=>{
  const f=fixture();f.pointer('pointerdown',500);f.pointer('pointermove',470,100,{timeStamp:200});f.pointer('pointerup',470,100,{timeStamp:400});
  expect(f.viewport.dataset.swipePhase).toBe('returning');expect(f.options.onTurn).not.toHaveBeenCalled();expect(f.snapshot.revert).toHaveBeenCalledOnce();
  f.finish();expect(f.viewport.dataset.swipePhase).toBeUndefined();
  const click={preventDefault:vi.fn(),stopPropagation:vi.fn()};f.controls.clickCapture(click as never);f.controls.clickCapture(click as never);expect(click.preventDefault).toHaveBeenCalledOnce();
 });
 it.each([false,true])('accepts a fresh primary press even without a previous trailing click, blocked=%s',blocked=>{
  const f=fixture();f.pointer('pointerdown',500);f.pointer('pointermove',470,100,{timeStamp:200});f.pointer('pointerup',470,100,{timeStamp:400});f.render({blocked});
  f.pointer('pointerdown',500,100,{pointerType:'touch',pointerId:2});f.pointer('pointerup',500,100,{pointerType:'touch',pointerId:2});
  const click={preventDefault:vi.fn(),stopPropagation:vi.fn()};f.controls.clickCapture(click as never);expect(click.preventDefault).not.toHaveBeenCalled();
 });
 it.each([{button:2},{pointerId:2,isPrimary:false}])('does not clear trailing-click protection for %j',press=>{
  const f=fixture();f.pointer('pointerdown',500);f.pointer('pointermove',470,100,{timeStamp:200});f.pointer('pointerup',470,100,{timeStamp:400});f.pointer('pointerdown',500,100,press);
  const click={preventDefault:vi.fn(),stopPropagation:vi.fn()};f.controls.clickCapture(click as never);expect(click.preventDefault).toHaveBeenCalledOnce();
 });
 it('never wraps or creates animation resources at an unavailable boundary',()=>{
  const f=fixture({canTurn:delta=>delta===1});expect(f.controls.turn(-1)).toBe(false);
  f.pointer('pointerdown',400);f.pointer('pointermove',700,100,{timeStamp:200});f.pointer('pointerup',700,100,{timeStamp:210});
  expect(f.options.onTurn).not.toHaveBeenCalled();expect(snapshots.create).not.toHaveBeenCalled();
 });
 it('does not interrupt a committed curl for an unavailable command',()=>{
  const f=fixture();f.controls.turn(1);f.render({identity:'last',canTurn:delta=>delta<0});expect(f.controls.turn(1)).toBe(false);expect(f.snapshot.pinned).toBe(true);
 });
 it('keeps taps and vertical scrolling native',()=>{
  const f=fixture();f.pointer('pointerdown',500);const small=f.pointer('pointermove',495,103);expect(small.preventDefault).not.toHaveBeenCalled();f.pointer('pointerup',495,103);
  f.pointer('pointerdown',500);f.pointer('pointermove',493,140);f.pointer('pointermove',100,140);f.pointer('pointerup',100,140);
  expect(f.options.onTurn).not.toHaveBeenCalled();expect(f.viewport.captures.size).toBe(0);expect(snapshots.create).not.toHaveBeenCalled();
 });
 it('uses the library fold threshold for a slow drag and reuses its engine through commit',()=>{
  const f=fixture();f.pointer('pointerdown',700);f.pointer('pointermove',200,120,{timeStamp:1000});
  f.snapshot.canCommit.mockReturnValue(true);f.pointer('pointerup',200,120,{timeStamp:1400});
  expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);expect(snapshots.create).toHaveBeenCalledOnce();
  f.render({identity:'page-2'});expect(f.snapshot.play).toHaveBeenCalledOnce();f.finish();expect(f.snapshot.pinned).toBe(false);
 });
 it('opens only one inert destination preview and releases it when the drag is canceled',()=>{
  const onPreviewChange=vi.fn(),preview={current:null as HTMLDivElement|null},f=fixture({onPreviewChange,preview});
  f.pointer('pointerdown',500);f.pointer('pointermove',350,100,{timeStamp:300});f.pointer('pointermove',300,100,{timeStamp:600});
  expect(onPreviewChange).toHaveBeenCalledExactlyOnceWith(1);
  preview.current={} as HTMLDivElement;f.render();expect(f.snapshot.preview).toHaveBeenLastCalledWith(preview.current);
  f.pointer('pointercancel',300);expect(onPreviewChange).toHaveBeenLastCalledWith(undefined);expect(f.options.onTurn).not.toHaveBeenCalled();
 });
 it('can drag past the commit threshold and pull back without navigation',()=>{
  const f=fixture();f.pointer('pointerdown',700);f.pointer('pointermove',100,120,{timeStamp:1000});
  f.pointer('pointermove',670,120,{timeStamp:2000});f.pointer('pointerup',670,120,{timeStamp:2400});
  expect(f.snapshot.drag).toHaveBeenLastCalledWith({x:700,y:100},{x:670,y:120});
  expect(f.snapshot.revert).toHaveBeenCalledOnce();expect(f.options.onTurn).not.toHaveBeenCalled();f.finish();
 });
 it('reverses direction with at most one snapshot and preserves boundary behavior',()=>{
  const f=fixture({canTurn:delta=>delta===1});f.pointer('pointerdown',400);f.pointer('pointermove',200,100,{timeStamp:100});const old=f.snapshot;
  f.pointer('pointermove',450,100,{timeStamp:200});expect(old.pinned).toBe(false);expect(f.surface.style.visibility).toBe('');
  f.pointer('pointermove',150,100,{timeStamp:300});expect(snapshots.create).toHaveBeenCalledTimes(2);
  expect(snapshots.create.mock.results.filter(r=>r.value.pinned)).toHaveLength(1);
  f.pointer('pointercancel',150);expect(f.snapshot.pinned).toBe(false);expect(f.options.onTurn).not.toHaveBeenCalled();
 });
 it('cancels a mouse gesture if its pressed-button state is lost',()=>{
  const f=fixture();f.pointer('pointerdown',500);f.pointer('pointermove',400,100,{timeStamp:100});
  f.pointer('pointermove',200,100,{timeStamp:200,buttons:0});f.pointer('pointerup',200);
  expect(f.snapshot.pinned).toBe(false);expect(f.options.onTurn).not.toHaveBeenCalled();expect(f.viewport.dataset.swipePhase).toBeUndefined();
 });
 it('lets a new navigation interrupt a returning fold and ignores its late completion',()=>{
  const f=fixture();f.pointer('pointerdown',500);f.pointer('pointermove',470,100,{timeStamp:200});f.pointer('pointerup',470,100,{timeStamp:400});
  const old=f.snapshot;f.controls.turn(1);expect(old.pinned).toBe(false);old.finish();expect(f.options.onSettled).not.toHaveBeenCalled();
  f.render({identity:'page-2'});f.finish();expect(f.options.onTurn).toHaveBeenCalledOnce();expect(f.options.onSettled).toHaveBeenCalledOnce();
 });
 it.each(['mouse','touch'])('keeps reduced-motion %s swipes free of snapshots',pointerType=>{
  reduced=true;const f=fixture();f.pointer('pointerdown',700,100,{pointerType});f.pointer('pointermove',200,100,{timeStamp:1000,pointerType});f.pointer('pointerup',200,100,{timeStamp:1500,pointerType});
  expect(f.options.onTurn).toHaveBeenCalledOnce();expect(snapshots.create).not.toHaveBeenCalled();expect(f.surface.style.visibility).toBe('');
 });
 it.each(['interactive','selection','overflow','pinch','secondary','modifier','blocked'] as const)('does not steal %s interaction',reason=>{
  const f=fixture({blocked:reason==='blocked'});if(reason==='selection')selection='text';if(reason==='overflow')f.viewport.scrollWidth=1000;if(reason==='pinch')browser.visualViewport.scale=2;
  f.pointer('pointerdown',500,100,{target:{closest:()=>reason==='interactive'?{}:null},button:reason==='secondary'?2:0,ctrlKey:reason==='modifier'});f.pointer('pointermove',100,100,{timeStamp:200});f.pointer('pointerup',100,100,{timeStamp:210});
  expect(f.options.onTurn).not.toHaveBeenCalled();expect(snapshots.create).not.toHaveBeenCalled();
 });
 it.each(['pointercancel','lostpointercapture','second-finger','escape','blur','hidden'] as const)('cancels a drag on %s without delayed navigation',reason=>{
  const f=fixture();f.pointer('pointerdown',500,100,{pointerType:'touch'});f.pointer('pointermove',200,100,{pointerType:'touch',timeStamp:200});
  if(reason==='pointercancel')f.pointer('pointercancel',200);if(reason==='lostpointercapture')f.viewport.emit('lostpointercapture',{pointerId:1,target:f.viewport});
  if(reason==='second-finger')f.pointer('pointerdown',220,100,{pointerId:2,pointerType:'touch',isPrimary:false});if(reason==='escape')browser.emit('keydown',{key:'Escape'});if(reason==='blur')browser.emit('blur');if(reason==='hidden'){documentEvents.hidden=true;documentEvents.emit('visibilitychange');}
  f.pointer('pointerup',200,100,{timeStamp:210});vi.runAllTimers();expect(f.options.onTurn).not.toHaveBeenCalled();expect(f.viewport.dataset.swipePhase).toBeUndefined();
 });
 it.each(['resetKey','direction','blocked','enabled','resize','cancel','unmount','blur','hidden'] as const)('disposes animation resources on %s and ignores a late completion',reason=>{
  const f=fixture();f.controls.turn(1);f.render({identity:'page-2'});const old=f.snapshot;
  if(reason==='resetKey')f.render({resetKey:'double'});if(reason==='direction')f.render({direction:'rtl'});if(reason==='blocked')f.render({blocked:true});if(reason==='enabled')f.render({enabled:false});
  if(reason==='resize'){f.viewport.clientWidth=600;browser.emit('resize');}if(reason==='cancel')f.controls.cancel();if(reason==='unmount'){for(const effect of hooks.effects)effect.cleanup?.();hooks.effects=[];}if(reason==='blur')browser.emit('blur');if(reason==='hidden'){documentEvents.hidden=true;documentEvents.emit('visibilitychange');}
  old.finish();vi.runAllTimers();expect(old.dispose).toHaveBeenCalledOnce();expect(f.options.onSettled).not.toHaveBeenCalled();expect(f.options.onTurn).toHaveBeenCalledOnce();expect(f.surface.style.visibility).toBe('');
 });
 it.each([1,-1] as const)('keeps one curl through a chapter %s loading its manifest and resolving the destination page',delta=>{
  const f=fixture({identity:'chapter-2:page-1'});f.controls.turn(delta);
  f.render({identity:'chapter-loading',canTurn:()=>false});const old=f.snapshot;
  expect(old.play).toHaveBeenCalledOnce();expect(old.pinned).toBe(true);expect(vi.getTimerCount()).toBe(0);
  f.render({identity:delta>0?'next-chapter:page-1':'previous-chapter:page-16',canTurn:()=>true});
  expect(snapshots.create).toHaveBeenCalledOnce();expect(old.pinned).toBe(true);
  f.finish();expect(old.dispose).toHaveBeenCalledOnce();expect(f.options.onSettled).toHaveBeenCalledOnce();
  f.render({identity:'refreshed-content'});expect(snapshots.create).toHaveBeenCalledOnce();
 });
 it('does not replay an already completed curl when a slow chapter finally arrives',()=>{
  const f=fixture();f.controls.turn(1);f.render({identity:'next-chapter-loading'});f.finish();
  vi.advanceTimersByTime(5000);f.render({identity:'next-chapter:page-1'});
  expect(snapshots.create).toHaveBeenCalledOnce();expect(f.snapshot.play).toHaveBeenCalledOnce();expect(f.viewport.dataset.swipePhase).toBeUndefined();
 });
 it('cancels a direct jump explicitly even when the old chapter load finishes later',()=>{
  const f=fixture();f.controls.turn(1);f.render({identity:'next-chapter-loading'});const old=f.snapshot;
  f.controls.cancel();f.render({identity:'bookmark-page'});old.finish();
  expect(old.pinned).toBe(false);expect(f.options.onSettled).not.toHaveBeenCalled();expect(f.viewport.dataset.swipePhase).toBeUndefined();
 });
 it('cancels an uncommitted drag if its source page changes',()=>{
  const f=fixture();f.pointer('pointerdown',500);f.pointer('pointermove',200,100,{timeStamp:200});
  f.render({identity:'changed-source'});f.pointer('pointerup',200,100,{timeStamp:210});
  expect(f.options.onTurn).not.toHaveBeenCalled();expect(f.snapshot.dispose).toHaveBeenCalledOnce();expect(f.viewport.dataset.swipePhase).toBeUndefined();
 });
 it('disposes a navigation that never commits without replaying a late page',()=>{
  const f=fixture();f.controls.turn(1);vi.advanceTimersByTime(1000);expect(f.snapshot.pinned).toBe(false);f.render({identity:'late'});expect(f.snapshot.play).not.toHaveBeenCalled();expect(f.options.onSettled).not.toHaveBeenCalled();
 });
 it('reduced motion navigates with zero snapshots, library instances or hidden live pixels',()=>{
  reduced=true;const f=fixture();for(let n=0;n<6;n++){f.controls.turn(1);expect(f.surface.style.visibility).toBe('');f.render({identity:`page-${n+2}`});}
  expect(snapshots.create).not.toHaveBeenCalled();expect(f.options.onSettled).toHaveBeenCalledTimes(6);expect(vi.getTimerCount()).toBe(0);
 });
 it('releases prepared resources if reduced motion becomes enabled before commit',()=>{
  const f=fixture();f.controls.turn(1);reduced=true;f.render({identity:'page-2'});expect(f.snapshot.dispose).toHaveBeenCalledOnce();expect(f.snapshot.play).not.toHaveBeenCalled();expect(f.options.onSettled).toHaveBeenCalledOnce();
 });
 it('navigates even if the animation adapter cannot initialize',()=>{
  snapshots.create.mockReturnValue(undefined);const f=fixture();f.controls.turn(1);expect(f.surface.style.visibility).toBe('');f.render({identity:'page-2'});expect(f.options.onSettled).toHaveBeenCalledOnce();
 });
 it('continuous reading does not create any animation resources',()=>{
  const f=fixture({enabled:false,canTurn:()=>false});f.controls.turn(1);expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);expect(snapshots.create).not.toHaveBeenCalled();
 });
 it('attaches when initial empty content obtains a viewport',()=>{
  const f=fixture({enabled:false,viewport:{current:null},surface:{current:null}});f.options.viewport.current=f.viewport as unknown as HTMLDivElement;f.options.surface.current=f.surface as unknown as HTMLDivElement;f.render({enabled:true});
  f.pointer('pointerdown',500);f.pointer('pointermove',200,100,{timeStamp:200});f.pointer('pointerup',200,100,{timeStamp:210});expect(f.options.onTurn).toHaveBeenCalledOnce();
 });
 it('removes all input listeners, timers and image pins at unmount',()=>{
  const f=fixture();f.controls.turn(1);for(const effect of hooks.effects)effect.cleanup?.();hooks.effects=[];
  for(const source of [browser,documentEvents,f.viewport])expect([...source.listeners.values()].every(listeners=>listeners.size===0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);expect(f.snapshot.dispose).toHaveBeenCalledOnce();
 });
});
