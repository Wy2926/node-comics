import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const hooks=vi.hoisted(()=>({cursor:0,stateCursor:0,effectCursor:0,refs:[] as {current:unknown}[],states:[] as unknown[],effects:[] as {deps:unknown[];cleanup?:()=>void}[],pending:[] as (()=>void)[]}));
vi.mock('react',async original=>({
 ...await original<typeof import('react')>(),
 useRef:(current:unknown)=>hooks.refs[hooks.cursor++]??(hooks.refs[hooks.cursor-1]={current}),
 useState:(initial:unknown)=>{
  const index=hooks.stateCursor++;if(!(index in hooks.states))hooks.states[index]=initial;
  return [hooks.states[index],(value:unknown)=>{hooks.states[index]=typeof value==='function'?value(hooks.states[index]):value;}];
 },
 useLayoutEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{
  const index=hooks.effectCursor++,previous=hooks.effects[index];
  if(previous&&deps.every((value,i)=>Object.is(value,previous.deps[i])))return;
  hooks.pending.push(()=>{previous?.cleanup?.();hooks.effects[index]={deps,cleanup:effect()||undefined};});
 },
}));
import {useSpreadZoom} from '../src/reader/useSpreadZoom';

type Options=Parameters<typeof useSpreadZoom>[0];
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
 clientWidth=800;clientHeight=600;offsetWidth=760;offsetHeight=560;
 dataset:Record<string,string>={};captures=new Set<number>();
 style={transform:'',removeProperty:(name:string)=>{if(name==='transform')this.style.transform='';}};
 get pose(){
  const values=this.style.transform.match(/translate3d\(([-\d.e+]+)px,([-\d.e+]+)px,0\) scale\(([-\d.e+]+)\)/);
  return values?{x:Number(values[1]),y:Number(values[2]),scale:Number(values[3])}:{x:0,y:0,scale:1};
 }
 getBoundingClientRect(){
  const {x,y,scale}=this.pose,width=this.offsetWidth*scale,height=this.offsetHeight*scale;
  return {left:500+x-width/2,top:350+y-height/2,width,height};
 }
 setPointerCapture(id:number){this.captures.add(id);}
 hasPointerCapture(id:number){return this.captures.has(id);}
 releasePointerCapture(id:number){this.captures.delete(id);}
}
let browser:Events&{getSelection:()=>{toString:()=>string};visualViewport:{scale:number}};
let documentEvents:Events&{hidden:boolean};
let selection='';
function cleanup(){for(const effect of hooks.effects)effect.cleanup?.();hooks.effects=[];}
function fixture(extra:Partial<Options>={}){
 const viewport=new Surface(),stack=new Surface();
 let options:Options={viewport:{current:viewport as unknown as HTMLDivElement},stack:{current:stack as unknown as HTMLDivElement},enabled:true,blocked:false,resetKey:'spread-1',...extra};
 const render=(changes:Partial<Options>={})=>{
  options={...options,...changes};hooks.cursor=0;hooks.stateCursor=0;hooks.effectCursor=0;hooks.pending=[];
  const controls=useSpreadZoom(options);for(const effect of hooks.pending)effect();return controls;
 };
 render();
 const pointer=(name:string,x=500,y=350,extra:Record<string,unknown>={})=>{
  const event={pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1,clientX:x,clientY:y,target:{closest:()=>null},...extra};
  if(name==='pointerdown'){browser.emit(name,event);return viewport.emit(name,event);}
  return browser.emit(name,event);
 };
 const wheel=(extra:Record<string,unknown>={})=>viewport.emit('wheel',{deltaY:-100,deltaMode:0,clientX:500,clientY:350,target:{closest:()=>null},...extra});
 return {viewport,stack,render,pointer,wheel,get options(){return options;},get controls(){return render();}};
}
beforeEach(()=>{
 vi.useFakeTimers();selection='';hooks.refs=[];hooks.states=[];hooks.effects=[];hooks.pending=[];
 browser=Object.assign(new Events(),{getSelection:()=>({toString:()=>selection}),visualViewport:{scale:1}});
 documentEvents=Object.assign(new Events(),{hidden:false});
 vi.stubGlobal('window',browser);vi.stubGlobal('document',documentEvents);
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});

describe('double-page inspection zoom',()=>{
 it('keeps the pointed image location anchored across repeated wheel zooms and pans',()=>{
  const f=fixture(),deltaY=-Math.log(2)/.002;
  const event=f.wheel({deltaY,clientX:600,clientY:450});
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(f.stack.pose.scale).toBeCloseTo(2);expect(f.stack.pose.x).toBeCloseTo(-100);expect(f.stack.pose.y).toBeCloseTo(-100);
  expect(f.controls.zoom).toBeCloseTo(200);expect(f.controls.zoomed).toBe(true);
  f.pointer('pointerdown');f.pointer('pointermove',540,380);f.pointer('pointerup',540,380);
  const before=f.stack.pose,localX=(600-500-before.x)/before.scale,localY=(450-350-before.y)/before.scale;
  f.wheel({deltaY:-100,clientX:600,clientY:450});
  const after=f.stack.pose;
  expect((600-500-after.x)/after.scale).toBeCloseTo(localX);expect((450-350-after.y)/after.scale).toBeCloseTo(localY);
 });
 it('clamps wheel zoom to the fitted 100% minimum and 400% maximum',()=>{
  const f=fixture();f.wheel({deltaY:10000});expect(f.controls.zoom).toBe(100);expect(f.stack.style.transform).toBe('');
  f.wheel({deltaY:-10000});expect(f.controls.zoom).toBeCloseTo(100*Math.exp(1.2));
  f.wheel({deltaY:-10000});expect(f.controls.zoom).toBe(400);expect(f.viewport.dataset.spreadZoom).toBe('400');
  f.wheel({deltaY:-10000});expect(f.controls.zoom).toBe(400);
  f.wheel({deltaY:10000});f.wheel({deltaY:10000});
  expect(f.controls.zoom).toBe(100);expect(f.controls.zoomed).toBe(false);expect(f.stack.style.transform).toBe('');expect(f.viewport.dataset.zoomed).toBeUndefined();
 });
 it.each([[0,-16],[1,-1],[2,-16/600]])('normalizes deltaMode %s to pixels before scaling', (deltaMode,deltaY)=>{
  const f=fixture();f.wheel({deltaMode,deltaY});expect(f.controls.zoom).toBeCloseTo(100*Math.exp(.032));
 });
 it('shares bounded controls with functional increments and ignores non-finite values',()=>{
  const f=fixture();f.controls.change(200);f.controls.change(value=>value+50);expect(f.controls.zoom).toBe(250);
  for(const value of [NaN,Infinity,-Infinity]){f.controls.change(value);expect(f.controls.zoom).toBe(250);}
  f.controls.change(500);expect(f.controls.zoom).toBe(400);f.controls.change(-20);expect(f.controls.zoom).toBe(100);
 });
 it('drags both axes only after clear intent and clamps the image',()=>{
  const f=fixture();f.controls.change(200);f.pointer('pointerdown');
  const small=f.pointer('pointermove',502,352);expect(small.preventDefault).not.toHaveBeenCalled();expect(f.viewport.captures.size).toBe(0);
  const moved=f.pointer('pointermove',2000,-2000);expect(moved.preventDefault).toHaveBeenCalledOnce();expect(f.viewport.captures.has(1)).toBe(true);
  expect(f.stack.pose).toEqual({scale:2,x:360,y:-260});expect(f.viewport.dataset.zoomDragging).toBe('true');
  f.pointer('pointermove',-2000,2000);expect(f.stack.pose).toEqual({scale:2,x:-360,y:260});
  f.pointer('pointerup',-2000,2000);expect(f.viewport.captures.size).toBe(0);expect(f.viewport.dataset.zoomDragging).toBeUndefined();
 });
 it('does not invent pan room while both scaled axes still fit inside the viewport',()=>{
  const f=fixture();f.controls.change(105);f.pointer('pointerdown');f.pointer('pointermove',2000,-2000);f.pointer('pointerup',2000,-2000);
  expect(f.stack.pose).toEqual({scale:1.05,x:0,y:0});
 });
 it('stops a full-bleed spread exactly at the viewport edges rather than exposing a synthetic gutter',()=>{
  const f=fixture();f.stack.offsetWidth=800;f.stack.offsetHeight=600;f.controls.change(200);
  f.pointer('pointerdown');f.pointer('pointermove',2000,2000);
  expect(f.stack.pose).toEqual({scale:2,x:400,y:300});
  expect(f.stack.getBoundingClientRect()).toMatchObject({left:100,top:50});
  f.pointer('pointermove',-2000,-2000);
  const box=f.stack.getBoundingClientRect();
  expect(box.left+box.width).toBe(900);expect(box.top+box.height).toBe(650);
 });
 it('does not pan at the fit minimum or for a small tap after zooming',()=>{
  const f=fixture();f.pointer('pointerdown');expect(f.pointer('pointermove',800,500).preventDefault).not.toHaveBeenCalled();f.pointer('pointerup');
  expect(f.stack.style.transform).toBe('');
  f.controls.change(200);f.pointer('pointerdown');f.pointer('pointermove',501,351);f.pointer('pointerup',501,351);
  expect(f.stack.pose).toEqual({scale:2,x:0,y:0});
 });
 it.each(['pointercancel','lostpointercapture','second-finger','blur','hidden','blocked','contextmenu','buttons-lost','modifier'] as const)('cancels drag on %s while preserving the inspection position',reason=>{
  const f=fixture();f.controls.change(200);f.pointer('pointerdown',500,350,{pointerType:'touch'});f.pointer('pointermove',580,410,{pointerType:'touch'});
  const pose=f.stack.pose;
  if(reason==='pointercancel')f.pointer('pointercancel',580,410);
  if(reason==='lostpointercapture')f.viewport.emit('lostpointercapture',{pointerId:1,target:f.viewport});
  if(reason==='second-finger')f.pointer('pointerdown',600,410,{pointerId:2,pointerType:'touch',isPrimary:false});
  if(reason==='blur')browser.emit('blur');
  if(reason==='hidden'){documentEvents.hidden=true;documentEvents.emit('visibilitychange');}
  if(reason==='blocked')f.render({blocked:true});
  if(reason==='contextmenu')f.viewport.emit('contextmenu');
  if(reason==='buttons-lost'||reason==='modifier')f.pointer('pointermove',600,420,{buttons:reason==='buttons-lost'?0:1,ctrlKey:reason==='modifier'});
  expect(f.viewport.captures.size).toBe(0);expect(f.viewport.dataset.zoomDragging).toBeUndefined();
  expect(f.pointer('pointermove',700,500).preventDefault).not.toHaveBeenCalled();expect(f.stack.pose).toEqual(pose);
 });
 it('ignores capture transfer from an image and resumes cleanly after both fingers lift',()=>{
  const f=fixture();f.controls.change(200);f.pointer('pointerdown',500,350,{pointerType:'touch'});f.pointer('pointermove',580,410,{pointerType:'touch'});
  f.viewport.emit('lostpointercapture',{pointerId:1,target:{tagName:'IMG'}});expect(f.viewport.dataset.zoomDragging).toBe('true');
  f.pointer('pointerdown',600,410,{pointerId:2,pointerType:'touch',isPrimary:false});f.pointer('pointerup',580,410,{pointerType:'touch'});f.pointer('pointerup',600,410,{pointerId:2,pointerType:'touch'});
  f.pointer('pointerdown',500,350,{pointerType:'touch'});f.pointer('pointermove',520,380,{pointerType:'touch'});
  expect(f.viewport.dataset.zoomDragging).toBe('true');expect(f.stack.pose).toEqual({scale:2,x:100,y:90});
 });
 it.each(['resetKey','manual-reset'] as const)('returns to fitted geometry on %s and cancels any current drag',reason=>{
  const f=fixture();f.controls.change(200);f.pointer('pointerdown');f.pointer('pointermove',600,400);
  if(reason==='resetKey')f.render({resetKey:'spread-2'});else f.controls.reset();
  expect(f.controls.zoom).toBe(100);expect(f.controls.zoomed).toBe(false);expect(f.stack.style.transform).toBe('');expect(f.viewport.captures.size).toBe(0);expect(f.viewport.dataset.zoomDragging).toBeUndefined();
  expect(f.pointer('pointermove',700,500).preventDefault).not.toHaveBeenCalled();
 });
 it.each(['ctrlKey','metaKey','altKey','interactive','blocked','hidden','browser-pinch','horizontal-only'] as const)('does not intercept %s wheel input',reason=>{
  const f=fixture({blocked:reason==='blocked'});
  if(reason==='hidden')documentEvents.hidden=true;if(reason==='browser-pinch')browser.visualViewport.scale=2;
  const event=f.wheel({[reason]:true,deltaY:reason==='horizontal-only'?0:-100,deltaX:100,target:{closest:()=>reason==='interactive'?{}:null}});
  expect(event.preventDefault).not.toHaveBeenCalled();expect(f.controls.zoom).toBe(100);expect(f.stack.style.transform).toBe('');
 });
 it.each(['interactive','selection','secondary','non-primary','ctrlKey','metaKey','altKey','shiftKey','blocked','hidden','browser-pinch'] as const)('does not start panning on %s input',reason=>{
  const f=fixture({blocked:reason==='blocked'});f.controls.change(200);
  if(reason==='selection')selection='selected text';if(reason==='hidden')documentEvents.hidden=true;if(reason==='browser-pinch')browser.visualViewport.scale=2;
  f.pointer('pointerdown',500,350,{[reason]:true,isPrimary:reason!=='non-primary',button:reason==='secondary'?2:0,target:{closest:()=>reason==='interactive'?{}:null}});
  expect(f.pointer('pointermove',700,500).preventDefault).not.toHaveBeenCalled();expect(f.viewport.captures.size).toBe(0);expect(f.stack.pose).toEqual({scale:2,x:0,y:0});
 });
 it('prevents native image dragging only while inspecting an enlarged spread',()=>{
  const f=fixture(),target={closest:(selector:string)=>selector==='img'?{}:null};
  expect(f.viewport.emit('dragstart',{target}).preventDefault).not.toHaveBeenCalled();f.controls.change(200);
  expect(f.viewport.emit('dragstart',{target}).preventDefault).toHaveBeenCalledOnce();
  expect(f.viewport.emit('dragstart',{target:{closest:()=>null}}).preventDefault).not.toHaveBeenCalled();
 });
 it.each([false,true].flatMap(detached=>(['disabled','unmount'] as const).map(reason=>({detached,reason}))))('releases owned transforms, captures, and listeners on $reason (ref detached=$detached)',({detached,reason})=>{
  const f=fixture();f.controls.change(200);f.pointer('pointerdown');f.pointer('pointermove',600,400);
  // React may detach callback refs before layout-effect cleanup, even when the DOM is reused.
  if(detached)f.options.stack.current=null;
  if(reason==='disabled')f.render({enabled:false});else cleanup();
  expect(f.stack.style.transform).toBe('');expect(f.viewport.dataset).toEqual({});expect(f.viewport.captures.size).toBe(0);
  for(const source of [browser,documentEvents,f.viewport])expect([...source.listeners.values()].every(listeners=>listeners.size===0)).toBe(true);
  expect(f.wheel().preventDefault).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  if(reason==='disabled'){
   expect(f.controls.zoom).toBe(100);expect(f.controls.zoomed).toBe(false);f.controls.change(200);expect(f.controls.zoom).toBe(100);
   f.options.stack.current=f.stack as unknown as HTMLDivElement;
   f.render({enabled:true});expect(f.controls.zoom).toBe(100);f.wheel();expect(f.controls.zoom).toBeGreaterThan(100);
  }
 });
 it('cleans its transformed node without clearing a replacement node it never changed',()=>{
  const f=fixture(),replacement=new Surface();f.controls.change(200);replacement.style.transform='scale(.75)';
  f.options.stack.current=replacement as unknown as HTMLDivElement;f.render({enabled:false});
  expect(f.stack.style.transform).toBe('');expect(replacement.style.transform).toBe('scale(.75)');expect(f.viewport.dataset).toEqual({});
 });
 it('can reset while the ref is detached and zoom again after the same node is attached',()=>{
  const f=fixture();f.controls.change(200);f.options.stack.current=null;f.controls.reset();
  expect(f.stack.style.transform).toBe('');expect(f.controls.zoom).toBe(100);expect(f.viewport.dataset.zoomed).toBeUndefined();
  expect(f.viewport.dataset.spreadZoom).toBe('100');
  f.options.stack.current=f.stack as unknown as HTMLDivElement;f.wheel();
  expect(f.stack.pose.scale).toBeCloseTo(Math.exp(.2));expect(f.controls.zoom).toBeCloseTo(100*Math.exp(.2));
 });
 it('resets the previous chapter node and follows the replacement through zoom and cleanup',()=>{
  const f=fixture(),replacement=new Surface();f.controls.change(200);f.pointer('pointerdown');f.pointer('pointermove',600,400);
  f.options.stack.current=replacement as unknown as HTMLDivElement;f.render({resetKey:'chapter-2'});
  expect(f.stack.style.transform).toBe('');expect(replacement.style.transform).toBe('');expect(f.controls.zoom).toBe(100);expect(f.viewport.captures.size).toBe(0);
  f.controls.change(250);expect(replacement.pose.scale).toBe(2.5);expect(f.stack.style.transform).toBe('');
  f.options.stack.current=null;cleanup();expect(replacement.style.transform).toBe('');expect(f.viewport.dataset).toEqual({});
 });
 it('releases the old transform when a later gesture paints another stack',()=>{
  const f=fixture(),replacement=new Surface();f.controls.change(200);
  f.options.stack.current=replacement as unknown as HTMLDivElement;f.wheel();
  expect(f.stack.style.transform).toBe('');expect(replacement.pose.scale).toBeGreaterThan(2);
  cleanup();expect(replacement.style.transform).toBe('');
 });
 it('stays usable when DOM refs are absent and attaches when enabled after pages mount',()=>{
  const f=fixture({enabled:false,viewport:{current:null},stack:{current:null}});
  expect(()=>{f.controls.change(200);f.controls.reset();}).not.toThrow();
  f.options.viewport.current=f.viewport as unknown as HTMLDivElement;f.options.stack.current=f.stack as unknown as HTMLDivElement;
  f.render({enabled:true});f.wheel();expect(f.controls.zoom).toBeGreaterThan(100);
 });
});
