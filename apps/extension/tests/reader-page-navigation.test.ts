import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import type {MouseEvent,PointerEvent} from 'react';

const hooks=vi.hoisted(()=>({cursor:0,refs:[] as {current:unknown}[],pending:[] as (()=>void)[]}));
vi.mock('react',async original=>({
 ...await original<typeof import('react')>(),
 useRef:(current:unknown)=>hooks.refs[hooks.cursor++]??(hooks.refs[hooks.cursor-1]={current}),
 useLayoutEffect:(effect:()=>void)=>hooks.pending.push(effect),
}));
import {usePagedNavigation} from '../src/reader/usePagedNavigation';
import {ignoreReaderClick,READER_INTERACTIVE} from '../src/reader/reader-input';

it.each(['left','right'] as const)('uses a legible single %s arrow cursor, not a resize cursor',side=>{
 const css=readFileSync(new URL('../src/redesign.css',import.meta.url),'utf8');
 const asset=readFileSync(new URL(`../src/assets/cursors/reader-turn-${side}.svg`,import.meta.url),'utf8');
 const icons=readFileSync(new URL('../src/assets/icons.svg',import.meta.url),'utf8');
 const rule=css.split(`.nc-reading-viewport[data-page-turn="${side}"]:not([data-zoomed="true"])`)[1]?.split('}')[0];
 expect(rule).toContain(`cursor: url('./assets/cursors/reader-turn-${side}.svg') ${side==='left'?3:29} 16, pointer;`);
 expect(asset).toContain('width="32" height="32"');
 expect(asset).toContain('fill="#182033" stroke="#fff"');
 expect(asset.includes('translate(24 0) scale(-1 1)')).toBe(side==='left');
 expect(icons).toContain(asset.match(/ d="([^"]+)"/)![0]);
});

type Options=Parameters<typeof usePagedNavigation>[0];
let selection='';
function fixture(extra:Partial<Options>={}){
 const element={
  dataset:{} as Record<string,string>,title:'',
  getBoundingClientRect:()=>({left:100,right:900,top:50,bottom:650,width:800,height:600}),
  contains:(target:{connected?:boolean}|null)=>target?.connected!==false,
  removeAttribute:vi.fn(function(this:{title:string},name:string){if(name==='title')this.title='';}),
 };
 const target={connected:true,closest:vi.fn(()=>null)};
 const options:Options={viewport:{current:element as unknown as HTMLDivElement},enabled:true,blocked:false,direction:'ltr',canTurn:vi.fn(()=>true),onTurn:vi.fn(),...extra};
 let handlers:ReturnType<typeof usePagedNavigation>;
 const render=(changes:Partial<Options>={})=>{
  Object.assign(options,changes);hooks.cursor=0;hooks.pending=[];handlers=usePagedNavigation(options);for(const effect of hooks.pending)effect();
 };
 const event=(x=500,extra:Record<string,unknown>={})=>({
  clientX:x,clientY:300,target,button:0,buttons:0,defaultPrevented:false,nativeEvent:{isPrimary:true,pointerId:1},
  altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,pointerType:'mouse',isPrimary:true,pointerId:1,
  preventDefault:vi.fn(),...extra,
 });
 render();
 const dispatchClick=(event:MouseEvent<HTMLDivElement>)=>ignoreReaderClick(event)||handlers.click(event);
 return {options,element,target,event,render,get handlers(){return handlers;},
  dispatchClick,click:(x=500,extra:Record<string,unknown>={})=>dispatchClick(event(x,extra) as unknown as MouseEvent<HTMLDivElement>),
  hover:(x=500,extra:Record<string,unknown>={})=>handlers.onPointerMove(event(x,extra) as unknown as PointerEvent<HTMLDivElement>),
 };
}
beforeEach(()=>{selection='';hooks.refs=[];hooks.pending=[];vi.stubGlobal('window',{getSelection:()=>({toString:()=>selection})});});
afterEach(()=>vi.unstubAllGlobals());

describe('paged edge navigation',()=>{
 it.each([['ltr',-1,1],['rtl',1,-1]] as const)('maps the physical edge to %s reading order and leaves the middle half to chrome', (direction,left,right)=>{
  const f=fixture({direction});
  expect(f.click(100)).toBe(true);expect(f.options.onTurn).toHaveBeenLastCalledWith(left);
  expect(f.click(299)).toBe(true);expect(f.options.onTurn).toHaveBeenLastCalledWith(left);
  expect(f.click(300)).toBe(false);expect(f.click(500)).toBe(false);expect(f.click(699)).toBe(false);
  expect(f.click(700)).toBe(true);expect(f.options.onTurn).toHaveBeenLastCalledWith(right);
  expect(f.click(899)).toBe(true);expect(f.options.onTurn).toHaveBeenLastCalledWith(right);
  expect(f.options.onTurn).toHaveBeenCalledTimes(4);
 });

 it('consumes unavailable or zoom-blocked edge clicks without toggling controls and keeps the middle usable',()=>{
  const f=fixture({canTurn:vi.fn(delta=>delta===1)});
  const event=f.event(200);expect(f.handlers.click(event as unknown as MouseEvent<HTMLDivElement>)).toBe(true);expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(f.options.onTurn).not.toHaveBeenCalled();f.click(800);expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);
  f.render({blocked:true});expect(f.click(200)).toBe(true);expect(f.click(800)).toBe(true);expect(f.click(500)).toBe(false);
  expect(f.options.onTurn).toHaveBeenCalledOnce();
 });

 it('does not handle continuous-layout clicks or claim hover hints',()=>{
  const f=fixture({enabled:false});
  expect(f.click(200)).toBe(false);expect(f.click(500)).toBe(false);expect(f.click(800)).toBe(false);
  f.hover(200);expect(f.element.dataset.pageTurn).toBeUndefined();expect(f.element.title).toBe('');expect(f.options.canTurn).not.toHaveBeenCalled();expect(f.options.onTurn).not.toHaveBeenCalled();
 });

 for(const enabled of [false,true])it.each(['prevented','secondary','alt','control','meta','shift','interactive','selection'] as const)(`leaves %s clicks untouched with paging enabled=${enabled}`,reason=>{
  const f=fixture({enabled});
  if(reason==='interactive')f.target.closest.mockReturnValue({} as never);
  if(reason==='selection')selection='selected text';
  const extra=reason==='prevented'?{defaultPrevented:true}:reason==='secondary'?{button:2}:
   reason==='alt'?{altKey:true}:reason==='control'?{ctrlKey:true}:reason==='meta'?{metaKey:true}:reason==='shift'?{shiftKey:true}:{};
  for(const x of [200,500,800]){
   const event=f.event(x,extra);expect(f.dispatchClick(event as unknown as MouseEvent<HTMLDivElement>)).toBe(true);expect(event.preventDefault).not.toHaveBeenCalled();
  }
  expect(f.options.onTurn).not.toHaveBeenCalled();expect(f.options.canTurn).not.toHaveBeenCalled();
 });

 it.each([false,true])('checks the shared target policy only once per click with paging enabled=%s',enabled=>{
  const f=fixture({enabled});
  expect(f.click()).toBe(false);expect(f.target.closest).toHaveBeenCalledExactlyOnceWith(READER_INTERACTIVE);
  f.target.closest.mockClear();f.click(800);expect(f.target.closest).toHaveBeenCalledExactlyOnceWith(READER_INTERACTIVE);
 });

 it('supports a primary touch tap without requiring a mouse hover',()=>{
  const f=fixture({direction:'rtl'});f.click(200,{nativeEvent:{isPrimary:true,pointerType:'touch'}});expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);
 });

 it('accepts real Chromium mouse clicks whose click event reports isPrimary=false',()=>{
  const f=fixture();f.handlers.onPointerDown(f.event(800) as unknown as PointerEvent<HTMLDivElement>);
  expect(f.click(800,{nativeEvent:{isPrimary:false,pointerId:1,pointerType:'mouse'}})).toBe(true);
  expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);
 });

 it('does not reject the primary pointer after a different non-primary finger and clears rejection on a new primary press',()=>{
  const f=fixture();f.handlers.onPointerDown(f.event(200,{isPrimary:false,pointerId:2}) as unknown as PointerEvent<HTMLDivElement>);
  f.click(800,{nativeEvent:{isPrimary:false,pointerId:2}});expect(f.options.onTurn).not.toHaveBeenCalled();
  f.click(800,{nativeEvent:{isPrimary:false,pointerId:1}});expect(f.options.onTurn).toHaveBeenCalledExactlyOnceWith(1);
  f.handlers.onPointerDown(f.event(200,{isPrimary:true,pointerId:2}) as unknown as PointerEvent<HTMLDivElement>);
  f.click(200,{nativeEvent:{isPrimary:false,pointerId:2}});expect(f.options.onTurn).toHaveBeenLastCalledWith(-1);
 });

 it.each([{clientX:99},{clientX:900},{clientY:49},{clientY:650},{clientX:NaN},{clientY:Infinity}])('does not navigate or toggle controls for a point outside the viewport: %j',point=>{
  const f=fixture();expect(f.click(500,point)).toBe(true);expect(f.options.onTurn).not.toHaveBeenCalled();
 });

 it('shares the reader interactive selector across click and hover filtering',()=>{
  const f=fixture();f.hover(200);expect(f.target.closest).toHaveBeenCalledWith(READER_INTERACTIVE);
  f.target.closest.mockReturnValue({} as never);f.hover(200);expect(f.element.dataset.pageTurn).toBeUndefined();expect(f.element.title).toBe('');
 });
});

describe('paged edge hover hints',()=>{
 it.each([['ltr','上一页','下一页'],['rtl','下一页','上一页']] as const)('shows the physical direction and logical page label in %s order', (direction,left,right)=>{
  const f=fixture({direction});f.hover(200);expect(f.element.dataset.pageTurn).toBe('left');expect(f.element.title).toBe(left);
  f.hover(800);expect(f.element.dataset.pageTurn).toBe('right');expect(f.element.title).toBe(right);
  f.hover(500);expect(f.element.dataset.pageTurn).toBeUndefined();expect(f.element.title).toBe('');
 });

 it('refreshes hints after navigation, direction, layout and blocked state changes even without pointer movement',()=>{
  const f=fixture();f.hover(200);expect(f.element.title).toBe('上一页');
  f.render({direction:'rtl'});expect(f.element.title).toBe('下一页');
  f.render({canTurn:()=>false});expect(f.element.dataset.pageTurn).toBeUndefined();expect(f.element.title).toBe('');
  f.render({canTurn:()=>true});expect(f.element.dataset.pageTurn).toBe('left');
  f.render({blocked:true});expect(f.element.dataset.pageTurn).toBeUndefined();
  f.render({blocked:false});expect(f.element.dataset.pageTurn).toBe('left');
  f.render({enabled:false});expect(f.element.dataset.pageTurn).toBeUndefined();
 });

 it.each(['touch','pen','dragging','nonprimary','modifier','prevented','selection'] as const)('clears the mouse hint during %s interaction',reason=>{
  const f=fixture();f.hover(200);
  if(reason==='selection')selection='selected text';
  f.hover(200,reason==='touch'||reason==='pen'?{pointerType:reason}:reason==='dragging'?{buttons:1}:reason==='nonprimary'?{isPrimary:false}:reason==='modifier'?{ctrlKey:true}:reason==='prevented'?{defaultPrevented:true}:{});
  expect(f.element.dataset.pageTurn).toBeUndefined();expect(f.element.title).toBe('');
 });

 it('clears hints on pointer leave and when the hovered page is unmounted',()=>{
  const f=fixture();f.hover(200);f.handlers.onPointerLeave();expect(f.element.dataset.pageTurn).toBeUndefined();expect(f.element.title).toBe('');
  f.render();expect(f.element.dataset.pageTurn).toBeUndefined();
  f.hover(800);f.target.connected=false;f.render();expect(f.element.dataset.pageTurn).toBeUndefined();expect(f.element.title).toBe('');
 });

 it('does not remove a title owned by another feature when no paging hint was shown',()=>{
  const f=fixture();f.element.title='Reading';f.hover(500);f.handlers.onPointerLeave();expect(f.element.title).toBe('Reading');
 });
});
