import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const hooks=vi.hoisted(()=>({cursor:0,effectCursor:0,refs:[] as {current:unknown}[],effects:[] as {deps:unknown[];cleanup?:()=>void}[],pending:[] as (()=>void)[]}));
const snapshots=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('../src/reader/page-snapshot',()=>({pageSnapshot:snapshots.create}));
vi.mock('react',async original=>({
 ...await original<typeof import('react')>(),
 useRef:(current:unknown)=>hooks.refs[hooks.cursor++]??(hooks.refs[hooks.cursor-1]={current}),
 useLayoutEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{
  const index=hooks.effectCursor++,previous=hooks.effects[index];
  if(previous&&deps.every((value,i)=>Object.is(value,previous.deps[i])))return;
  hooks.pending.push(()=>{previous?.cleanup?.();hooks.effects[index]={deps,cleanup:effect()||undefined};});
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
 animations:{onfinish:null|(()=>void);cancel:ReturnType<typeof vi.fn>;finish:()=>void;frames:Keyframe[];options:KeyframeAnimationOptions;started:number}[]=[];
 animate(frames:Keyframe[],options:KeyframeAnimationOptions){
  const result={onfinish:null as null|(()=>void),cancel:vi.fn(),frames,options,started:Date.now(),finish:()=>result.onfinish?.()};
  this.animations.push(result);return result;
 }
 setPointerCapture(id:number){this.captures.add(id);}
 hasPointerCapture(id:number){return this.captures.has(id);}
 releasePointerCapture(id:number){this.captures.delete(id);}
}
function snapshot(){
 const result={element:new Surface(),pinned:true,position:vi.fn(),dispose:vi.fn(()=>{result.pinned=false;})};
 return result;
}
let browser:Events&{matchMedia:()=>{matches:boolean};getSelection:()=>{toString:()=>string};visualViewport:{scale:number}};
let documentEvents:Events&{hidden:boolean};
let reduced=false,selection='';
const flush=async()=>{await Promise.resolve();};
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
  const event={pointerId:1,pointerType:'mouse',isPrimary:true,button:0,clientX:x,clientY:y,timeStamp:0,target:{closest:()=>null},...extra};
  if(name==='pointerdown'){browser.emit(name,event);return viewport.emit(name,event);}
  return browser.emit(name,event);
 };
 return {options,viewport,surface,render,pointer,get controls(){return controls;},get snapshot(){return snapshots.create.mock.results.at(-1)!.value as ReturnType<typeof snapshot>;},finish:()=>surface.animations.at(-1)!.finish()};
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

describe('paged swipe animation',()=>{
 it('navigates synchronously and starts both layers together as soon as React commits, without image readiness',()=>{
  const f=fixture();f.controls.turn(1);
  expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);expect(f.surface.animations).toHaveLength(0);
  expect(f.viewport.dataset.swipePhase).toBe('entering');expect(f.snapshot.pinned).toBe(true);expect(f.surface.style.visibility).toBe('hidden');
  f.render({identity:'page-2'});expect(f.viewport.dataset.swipePhase).toBe('entering');expect(f.surface.style.visibility).toBe('');
  expect(f.surface.animations[0].frames).toEqual([{transform:'translate3d(800px,0,0)'},{transform:'translate3d(0px,0,0)'}]);
  expect(f.snapshot.element.animations[0].frames).toEqual([{transform:'translate3d(0px,0,0)'},{transform:'translate3d(-800px,0,0)'}]);
  expect(f.surface.animations[0].options).toEqual(f.snapshot.element.animations[0].options);expect(f.surface.animations[0].options.duration).toBe(240);
  expect(f.surface.animations[0].started).toBe(f.snapshot.element.animations[0].started);expect(f.snapshot.pinned).toBe(true);
  f.finish();expect(f.viewport.dataset.swipePhase).toBeUndefined();expect(f.surface.style.transform).toBe('');expect(f.surface.style.willChange).toBe('');
  expect(f.snapshot.dispose).toHaveBeenCalledOnce();expect(f.snapshot.pinned).toBe(false);expect(f.snapshot.element.animations[0].cancel).toHaveBeenCalledOnce();
  expect(f.options.onActivityChange).toHaveBeenNthCalledWith(1,true);expect(f.options.onActivityChange).toHaveBeenNthCalledWith(2,false);expect(f.options.onSettled).toHaveBeenCalledOnce();
 });
 it('supports a synchronous React navigation commit in the same turn call',()=>{
  const f=fixture();vi.mocked(f.options.onTurn).mockImplementation(()=>{f.render({identity:'page-2'});});
  f.controls.turn(1);expect(f.surface.animations).toHaveLength(1);expect(f.surface.style.visibility).toBe('');expect(vi.getTimerCount()).toBe(0);
  f.finish();expect(f.snapshot.pinned).toBe(false);expect(f.options.onSettled).toHaveBeenCalledOnce();expect(f.viewport.dataset.swipePhase).toBeUndefined();
 });
 it('supports repeated bounded turns and releases every outgoing snapshot',()=>{
  const f=fixture();
  for(let page=2;page<=5;page++){
   f.controls.turn(1);expect(f.options.onTurn).toHaveBeenCalledTimes(page-1);
   f.render({identity:`page-${page}`});expect(f.surface.style.visibility).toBe('');
   expect(f.surface.animations.at(-1)!.options.duration).toBe(240);expect(vi.getTimerCount()).toBe(0);
   f.finish();expect(f.snapshot.pinned).toBe(false);expect(f.viewport.dataset.swipePhase).toBeUndefined();
  }
  expect(f.options.onSettled).toHaveBeenCalledTimes(4);
  expect(snapshots.create.mock.results.every(({value})=>value.dispose.mock.calls.length===1)).toBe(true);
 });
 it('does not animate the old identity before navigation commits',()=>{
  const f=fixture();f.controls.turn(1);f.render();
  expect(f.surface.animations).toHaveLength(0);expect(f.viewport.dataset.swipePhase).toBe('entering');expect(f.snapshot.dispose).not.toHaveBeenCalled();
 });
 it('consumes repeat commands until the commit and bounded animation finish without queueing or native scrolling',()=>{
  const f=fixture();f.controls.turn(1);expect(f.controls.turn(1)).toBeUndefined();expect(f.controls.turn(-1)).toBeUndefined();
  f.render({identity:'page-2'});expect(f.controls.turn(1)).toBeUndefined();expect(f.controls.turn(-1)).toBeUndefined();f.finish();
  expect(f.options.onTurn).toHaveBeenCalledOnce();expect(snapshots.create).toHaveBeenCalledOnce();
 });
 it.each(['ltr','rtl'] as const)('preserves the finger offset and keeps outgoing/incoming layers one viewport apart for %s',async direction=>{
  const f=fixture({direction}),offset=direction==='ltr'?-200:200,x=500+offset,sign=direction==='ltr'?-1:1;
  f.pointer('pointerdown',500);f.pointer('pointermove',x,105,{timeStamp:200});
  expect(f.surface.style.transform).toBe(`translate3d(${offset}px,0,0)`);expect(f.viewport.captures.has(1)).toBe(true);
  f.pointer('pointerup',x,105,{timeStamp:210});expect(snapshots.create).toHaveBeenCalledExactlyOnceWith(f.viewport,f.surface,offset);expect(f.surface.style.transform).toBe('');
  expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);expect(f.snapshot.element.style.transform).toBe(`translate3d(${offset}px,0,0)`);
  f.render({identity:'page-2'});
  expect(f.surface.animations[0].frames[0].transform).toBe(`translate3d(${offset-sign*800}px,0,0)`);expect(f.snapshot.element.animations[0].frames[0].transform).toBe(`translate3d(${offset}px,0,0)`);
 });
 it('never drags all the old pixels away before any incoming layer is mounted',()=>{
  const f=fixture();f.pointer('pointerdown',700);f.pointer('pointermove',-2000,100,{timeStamp:200});
  expect(f.surface.style.transform).toBe('translate3d(-320px,0,0)');expect(snapshots.create).not.toHaveBeenCalled();
 });
 it('supports touch pointers and a quick short flick',async()=>{
  const f=fixture();f.pointer('pointerdown',500,100,{pointerType:'touch'});f.pointer('pointermove',460,100,{pointerType:'touch',timeStamp:30});f.pointer('pointerup',460,100,{pointerType:'touch',timeStamp:40});
  await flush();expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);
 });
 it('keeps dragging when implicit image capture transfers to the viewport',async()=>{
  const f=fixture();f.pointer('pointerdown',500,100,{pointerType:'touch'});f.pointer('pointermove',300,100,{pointerType:'touch',timeStamp:200});
  f.viewport.emit('lostpointercapture',{pointerId:1,target:{tagName:'IMG'}});expect(f.viewport.dataset.swipePhase).toBe('dragging');
  f.pointer('pointermove',200,100,{pointerType:'touch',timeStamp:220});f.pointer('pointerup',200,100,{pointerType:'touch',timeStamp:230});await flush();expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);
 });
 it('returns a slow short drag without creating a snapshot and suppresses only its synthetic click',()=>{
  const f=fixture();f.pointer('pointerdown',500);f.pointer('pointermove',470,100,{timeStamp:200});f.pointer('pointerup',470,100,{timeStamp:400});
  expect(f.viewport.dataset.swipePhase).toBe('settling');f.finish();expect(f.options.onTurn).not.toHaveBeenCalled();expect(snapshots.create).not.toHaveBeenCalled();
  const click={preventDefault:vi.fn(),stopPropagation:vi.fn()};f.controls.clickCapture(click as never);expect(click.preventDefault).toHaveBeenCalledOnce();expect(click.stopPropagation).toHaveBeenCalledOnce();
  f.controls.clickCapture(click as never);expect(click.preventDefault).toHaveBeenCalledOnce();
 });
 it.each([false,true])('accepts a fresh primary press when the previous drag emitted no click, even with blocked=%s',blocked=>{
  const f=fixture();f.pointer('pointerdown',500);f.pointer('pointermove',470,100,{timeStamp:200});f.pointer('pointerup',470,100,{timeStamp:400});f.finish();
  if(blocked)f.render({blocked:true});
  f.pointer('pointerdown',500,100,{pointerType:'touch',pointerId:2});f.pointer('pointerup',500,100,{pointerType:'touch',pointerId:2});
  const click={preventDefault:vi.fn(),stopPropagation:vi.fn()};f.controls.clickCapture(click as never);
  expect(click.preventDefault).not.toHaveBeenCalled();expect(click.stopPropagation).not.toHaveBeenCalled();expect(f.options.onTurn).not.toHaveBeenCalled();
 });
 it.each([{button:2},{pointerId:2,isPrimary:false}])('does not clear trailing-click suppression for a non-primary press: %j',press=>{
  const f=fixture();f.pointer('pointerdown',500);f.pointer('pointermove',470,100,{timeStamp:200});f.pointer('pointerup',470,100,{timeStamp:400});f.finish();
  f.pointer('pointerdown',500,100,press);
  const click={preventDefault:vi.fn(),stopPropagation:vi.fn()};f.controls.clickCapture(click as never);expect(click.preventDefault).toHaveBeenCalledOnce();
 });
 it('dampens an unavailable boundary without wrapping or preparing a snapshot',()=>{
  const f=fixture({canTurn:delta=>delta===1});f.pointer('pointerdown',400);f.pointer('pointermove',700,100,{timeStamp:200});
  const offset=Number(f.surface.style.transform.match(/translate3d\(([^p]+)/)?.[1]);expect(offset).toBeGreaterThan(0);expect(offset).toBeLessThan(60);
  f.pointer('pointerup',700,100,{timeStamp:210});expect(f.viewport.dataset.swipePhase).toBe('settling');f.finish();expect(f.options.onTurn).not.toHaveBeenCalled();expect(snapshots.create).not.toHaveBeenCalled();
 });
 it('keeps taps and vertical scrolling native and never captures undecided intent',()=>{
  const f=fixture();f.pointer('pointerdown',500);const small=f.pointer('pointermove',495,103);
  expect(small.preventDefault).not.toHaveBeenCalled();expect(f.viewport.captures.size).toBe(0);f.pointer('pointerup',495,103);
  const click={preventDefault:vi.fn(),stopPropagation:vi.fn()};f.controls.clickCapture(click as never);expect(click.preventDefault).not.toHaveBeenCalled();
  f.pointer('pointerdown',500);f.pointer('pointermove',493,140);f.pointer('pointermove',100,140);f.pointer('pointerup',100,140);
  expect(f.surface.animations).toHaveLength(0);expect(f.options.onTurn).not.toHaveBeenCalled();expect(snapshots.create).not.toHaveBeenCalled();
 });
 it.each(['interactive','selection','overflow','pinch','secondary','modifier','blocked'] as const)('does not steal %s interaction',reason=>{
  const f=fixture({blocked:reason==='blocked'});
  if(reason==='selection')selection='selected text';if(reason==='overflow')f.viewport.scrollWidth=1000;if(reason==='pinch')browser.visualViewport.scale=2;
  f.pointer('pointerdown',500,100,{target:{closest:()=>reason==='interactive'?{}:null},button:reason==='secondary'?2:0,ctrlKey:reason==='modifier'});
  f.pointer('pointermove',100,100,{timeStamp:200});f.pointer('pointerup',100,100,{timeStamp:210});expect(f.surface.animations).toHaveLength(0);expect(f.options.onTurn).not.toHaveBeenCalled();expect(snapshots.create).not.toHaveBeenCalled();
 });
 it('only prevents native image dragging inside an enabled paged viewport',()=>{
  const f=fixture(),target={closest:(selector:string)=>selector==='img'?{}:null};
  expect(f.viewport.emit('dragstart',{target}).preventDefault).toHaveBeenCalledOnce();f.render({enabled:false});expect(f.viewport.emit('dragstart',{target}).preventDefault).not.toHaveBeenCalled();
 });
 it.each(['pointercancel','lostpointercapture','second-finger','escape','blur','hidden'] as const)('cancels a drag safely on %s and never navigates',reason=>{
  const f=fixture();f.pointer('pointerdown',500,100,{pointerType:'touch'});f.pointer('pointermove',200,100,{pointerType:'touch',timeStamp:200});
  if(reason==='pointercancel')f.pointer('pointercancel',200);
  if(reason==='lostpointercapture')f.viewport.emit('lostpointercapture',{pointerId:1,target:f.viewport});
  if(reason==='second-finger')f.pointer('pointerdown',220,100,{pointerId:2,pointerType:'touch',isPrimary:false});
  if(reason==='escape')browser.emit('keydown',{key:'Escape'});
  if(reason==='blur')browser.emit('blur');
  if(reason==='hidden'){documentEvents.hidden=true;documentEvents.emit('visibilitychange');}
  f.pointer('pointerup',200,100,{timeStamp:210});vi.runAllTimers();
  expect(f.options.onTurn).not.toHaveBeenCalled();expect(f.options.onSettled).not.toHaveBeenCalled();expect(f.surface.style.transform).toBe('');expect(f.viewport.dataset.swipePhase).toBeUndefined();
  const click={preventDefault:vi.fn(),stopPropagation:vi.fn()};f.controls.clickCapture(click as never);expect(click.preventDefault).toHaveBeenCalledOnce();
 });
 it.each(['identity','resetKey','direction','blocked','enabled','resize','cancel','unmount','blur','hidden'] as const)('disposes the outgoing snapshot on %s without any delayed navigation',async reason=>{
  const f=fixture();f.controls.turn(1);const old=f.snapshot;
  if(reason==='identity'){f.render({identity:'page-2'});f.render({identity:'direct-page'});}
  if(reason==='resetKey')f.render({resetKey:'double'});
  if(reason==='direction')f.render({direction:'rtl'});
  if(reason==='blocked')f.render({blocked:true});
  if(reason==='enabled')f.render({enabled:false});
  if(reason==='resize'){f.viewport.clientWidth=600;browser.emit('resize');}
  if(reason==='cancel')f.controls.cancel();
  if(reason==='unmount'){for(const effect of hooks.effects)effect.cleanup?.();hooks.effects=[];}
  if(reason==='blur')browser.emit('blur');
  if(reason==='hidden'){documentEvents.hidden=true;documentEvents.emit('visibilitychange');}
  await flush();vi.runAllTimers();
  expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);expect(f.options.onSettled).not.toHaveBeenCalled();expect(f.surface.style.transform).toBe('');expect(f.surface.style.visibility).toBe('');expect(old.dispose).toHaveBeenCalledOnce();expect(old.pinned).toBe(false);
 });
 it('cancels a committed transition on an external identity change rather than animating a third page',()=>{
  const f=fixture();f.controls.turn(1);f.render({identity:'page-2'});f.render({identity:'direct-page'});
  expect(f.snapshot.dispose).toHaveBeenCalledOnce();expect(f.surface.animations).toHaveLength(1);expect(f.surface.animations[0].cancel).toHaveBeenCalledOnce();expect(f.surface.style.visibility).toBe('');expect(f.options.onTurn).toHaveBeenCalledOnce();expect(f.options.onSettled).not.toHaveBeenCalled();
 });
 it('cancels both active layer animations and ignores a late finish callback',async()=>{
  const f=fixture();f.controls.turn(1);await flush();f.render({identity:'page-2'});const late=f.surface.animations[0].onfinish!;
  f.controls.cancel();late();expect(f.surface.animations[0].cancel).toHaveBeenCalledOnce();expect(f.snapshot.element.animations[0].cancel).toHaveBeenCalledOnce();expect(f.snapshot.dispose).toHaveBeenCalledOnce();expect(f.options.onSettled).not.toHaveBeenCalled();expect(f.surface.style.visibility).toBe('');
 });
 it('does not treat a configuration change while waiting for a chapter as a normal entrance',async()=>{
  const f=fixture();f.controls.turn(1);await flush();f.render({identity:'chapter-2',resetKey:'new-language'});
  expect(f.surface.animations).toHaveLength(0);expect(f.viewport.dataset.swipePhase).toBeUndefined();expect(f.snapshot.dispose).toHaveBeenCalledOnce();expect(f.options.onSettled).not.toHaveBeenCalled();
 });
 it('releases old pixels only for a navigation that never commits, without a late entrance or settled evidence',async()=>{
  const f=fixture();f.controls.turn(1);await flush();expect(f.snapshot.pinned).toBe(true);vi.advanceTimersByTime(1000);
  expect(f.viewport.dataset.swipePhase).toBeUndefined();expect(f.snapshot.pinned).toBe(false);expect(f.surface.style.visibility).toBe('');expect(f.options.onTurn).toHaveBeenCalledOnce();expect(f.options.onSettled).not.toHaveBeenCalled();f.render({identity:'late-chapter'});expect(f.surface.animations).toHaveLength(0);
 });
 it('honors reduced motion and releases outgoing pixels immediately when the touch destination commits',()=>{
  reduced=true;const f=fixture();f.pointer('pointerdown',500,100,{pointerType:'touch'});f.pointer('pointermove',200,100,{pointerType:'touch',timeStamp:200});f.pointer('pointerup',200,100,{pointerType:'touch',timeStamp:210});
  expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);f.render({identity:'page-2'});
  expect(f.surface.animations).toHaveLength(0);expect(f.snapshot.element.animations).toHaveLength(0);expect(f.snapshot.dispose).toHaveBeenCalledOnce();expect(f.viewport.dataset.swipePhase).toBeUndefined();expect(f.surface.style.visibility).toBe('');expect(f.options.onSettled).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 });
 it('keeps continuous navigation immediate and does not snapshot or animate',()=>{
  const f=fixture({enabled:false,canTurn:()=>false});f.controls.turn(1);expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);expect(f.surface.animations).toHaveLength(0);expect(snapshots.create).not.toHaveBeenCalled();
 });
 it('attaches after the initial empty reader obtains its pages and viewport',async()=>{
  const f=fixture({enabled:false,viewport:{current:null},surface:{current:null}});f.options.viewport.current=f.viewport as unknown as HTMLDivElement;f.options.surface.current=f.surface as unknown as HTMLDivElement;
  f.render({enabled:true});f.pointer('pointerdown',500);f.pointer('pointermove',200,100,{timeStamp:200});expect(f.viewport.dataset.swipePhase).toBe('dragging');
  f.pointer('pointerup',200,100,{timeStamp:210});await flush();expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);
 });
 it('keeps command integration usable without mounted DOM nodes',()=>{
  const f=fixture({viewport:{current:null},surface:{current:null}});f.controls.turn(-1);expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(-1);expect(snapshots.create).not.toHaveBeenCalled();
 });
 it('removes all listeners, pending timers, and the outgoing pin at unmount',async()=>{
  const f=fixture();f.controls.turn(1);await flush();for(const effect of hooks.effects)effect.cleanup?.();hooks.effects=[];
  expect([...browser.listeners.values()].every(listeners=>listeners.size===0)).toBe(true);expect([...documentEvents.listeners.values()].every(listeners=>listeners.size===0)).toBe(true);expect([...f.viewport.listeners.values()].every(listeners=>listeners.size===0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);expect(f.snapshot.dispose).toHaveBeenCalledOnce();expect(f.snapshot.pinned).toBe(false);
 });
});
