import {useLayoutEffect,useRef,type MouseEvent,type PointerEvent,type RefObject} from 'react';
import {msg} from '../i18n/runtime';
import {READER_INTERACTIVE} from './reader-input';

type Turn=-1|1;
type Side='left'|'right';
type Point={clientX:number;clientY:number;target:EventTarget|null};
type Options={
 viewport:RefObject<HTMLDivElement|null>;
 enabled:boolean;
 blocked:boolean;
 direction:'ltr'|'rtl';
 canTurn:(delta:Turn)=>boolean;
 onTurn:(delta:Turn)=>unknown;
};

/** Edge taps share the carousel action; the middle remains the reader's chrome toggle. */
export function usePagedNavigation({viewport,enabled,blocked,direction,canTurn,onTurn}:Options){
 const hover=useRef<Point|undefined>(undefined);
 const nonPrimaryPointer=useRef<number|undefined>(undefined);
 const turnFor=(side:Side):Turn=>(side==='left'?-1:1)*(direction==='rtl'?-1:1) as Turn;
 const protectedTarget=(target:EventTarget|null)=>!!(target as Element|null)?.closest?.(READER_INTERACTIVE)||!!window.getSelection?.()?.toString();
 const sideAt=(point:Point):Side|null|undefined=>{
  const bounds=viewport.current?.getBoundingClientRect();
  if(!bounds||bounds.width<=0||!Number.isFinite(point.clientX)||!Number.isFinite(point.clientY)||point.clientY<bounds.top||point.clientY>=bounds.bottom)return;
  const x=(point.clientX-bounds.left)/bounds.width;
  if(x<0||x>=1)return;
  return x<.25?'left':x>=.75?'right':null;
 };
 const hint=(side?:Side)=>{
  const element=viewport.current;if(!element)return;
  if(!side){
   if(element.dataset.pageTurn){delete element.dataset.pageTurn;element.removeAttribute('title');}
   return;
  }
  const title=turnFor(side)<0?msg('上一页'):msg('下一页');
  if(element.dataset.pageTurn!==side)element.dataset.pageTurn=side;
  if(element.title!==title)element.title=title;
 };
 const refreshHint=()=>{
  const point=hover.current;
  if(point&&!viewport.current?.contains(point.target as Node|null))hover.current=undefined;
  if(!enabled||blocked||!hover.current||!point||protectedTarget(point.target)){hint();return;}
  const side=sideAt(point);
  hint(side&&canTurn(turnFor(side))?side:undefined);
 };
 // A turn or panel/layout change may invalidate the hint while the pointer stays still.
 useLayoutEffect(refreshHint);
 const modified=(event:{altKey:boolean;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean})=>event.altKey||event.ctrlKey||event.metaKey||event.shiftKey;
 return {
  /** Called after ignoreReaderClick; true means the center/chrome action must not run. */
  click(event:MouseEvent<HTMLDivElement>):boolean{
   if(!enabled)return false;
   if(nonPrimaryPointer.current!==undefined&&(event.nativeEvent as globalThis.PointerEvent).pointerId===nonPrimaryPointer.current)return true;
   const side=sideAt(event);
   if(side===null)return false;
   if(!side)return true;
   event.preventDefault();
   if(!blocked&&canTurn(turnFor(side)))onTurn(turnFor(side));
   return true;
  },
  onPointerDown(event:PointerEvent<HTMLDivElement>){
   // Chromium reports isPrimary=false on real mouse click events. Only the press
   // carries reliable primary-pointer identity; button=0 still guards the click.
   nonPrimaryPointer.current=event.isPrimary===false?event.pointerId:undefined;
  },
  onPointerMove(event:PointerEvent<HTMLDivElement>){
   if(event.defaultPrevented||event.pointerType!=='mouse'||event.isPrimary===false||event.buttons!==0||modified(event))hover.current=undefined;
   else hover.current={clientX:event.clientX,clientY:event.clientY,target:event.target};
   refreshHint();
  },
  onPointerLeave(){hover.current=undefined;hint();},
 };
}
