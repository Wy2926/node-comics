import {useLayoutEffect, useRef, type MouseEventHandler, type RefObject} from 'react';
import {pageTurn} from './page-turn';
import {READER_INTERACTIVE} from './reader-input';

type Turn = -1 | 1;
type Phase = 'dragging' | 'entering';
type Options = {
 viewport:RefObject<HTMLDivElement|null>;
 surface:RefObject<HTMLDivElement|null>;
 enabled:boolean;
 blocked:boolean;
 direction:'ltr'|'rtl';
 // Navigation commits may precede the destination manifest or images.
 identity:string;
 // Display configuration only; page/chapter identity belongs to navigation.
 resetKey:string;
 canTurn:(delta:Turn)=>boolean;
 onTurn:(delta:Turn)=>void;
 onActivityChange?:(active:boolean)=>void;
 onSettled?:()=>void;
};
type Controls = {turn:(delta:Turn)=>false|void;cancel:()=>void;sync:()=>void;click:()=>boolean};

/** Reader input arbitration; all page-curl rendering belongs to the library adapter. */
export function usePagedSwipe(options:Options){
 const latest=useRef(options);latest.current=options;
 const controls=useRef<Controls|null>(null);
 useLayoutEffect(()=>{
  if(!options.enabled)return;
  const viewport=options.viewport.current,surface=options.surface.current;
  if(!viewport||!surface)return;
  let phase:Phase|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  let snapshot:ReturnType<typeof pageTurn>|undefined;
  let generation=0,clickUntil=0,identity=latest.current.identity,resetKey=latest.current.resetKey;
  let blocked=latest.current.blocked,direction=latest.current.direction;
  let size=[viewport.clientWidth,viewport.clientHeight];
  let pending=false;
  let gesture:{id:number;x:number;y:number;lastX:number;lastTime:number;velocity:number;dragging:boolean}|undefined;
  const touches=new Set<number>();
  const reduced=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
  const setPhase=(next:Phase|undefined)=>{
   const active=!!phase;phase=next;
   if(next)viewport.dataset.swipePhase=next;else delete viewport.dataset.swipePhase;
   if(active!==!!next)latest.current.onActivityChange?.(!!next);
  };
  const clearPendingTimeout=()=>{
   if(timer!==undefined){clearTimeout(timer);timer=undefined;}
  };
  const release=(id:number)=>{
   try{if(viewport.hasPointerCapture?.(id))viewport.releasePointerCapture(id);}catch{/* Pointer may already have ended. */}
  };
  const reset=(settled=false)=>{
   generation++;clearPendingTimeout();pending=false;
   if(gesture?.dragging)clickUntil=Date.now()+500;
   const id=gesture?.id;gesture=undefined;if(id!==undefined)release(id);
   snapshot?.dispose();snapshot=undefined;
   surface.style.removeProperty('visibility');setPhase(undefined);
   if(settled)latest.current.onSettled?.();
  };
  const enter=()=>{
   if(!pending)return;
   pending=false;clearPendingTimeout();
   surface.style.removeProperty('visibility');
   if(reduced()||!snapshot){reset(true);return;}
   const version=generation;
   snapshot.play(()=>{if(version===generation)reset(true);});
  };
  const navigate=(delta:Turn,sign:number)=>{
   pending=true;setPhase('entering');
   if(!reduced())snapshot=pageTurn(viewport,surface,sign);
   if(snapshot)surface.style.visibility='hidden';
   // Guard only a navigation that never commits. Image loading never holds navigation.
   timer=setTimeout(()=>reset(),1000);
   latest.current.onTurn(delta);
  };
  const turn=(delta:Turn):false|void=>{
   const current=latest.current;
   if(!current.enabled){current.onTurn(delta);return;}
   // Wait only for the destination commit or an active gesture, never queue inputs.
   if(phase&&(phase!=='entering'||pending))return;
   if(!current.canTurn(delta))return false;
   if(current.blocked||document.hidden)return false;
   // A newer action replaces the committed entrance. Do not credit skipped pixels as read.
   if(phase)reset();
   const sign=delta*(current.direction==='rtl'?1:-1);
   navigate(delta,sign);
  };
  const unavailable=()=>!latest.current.enabled||latest.current.blocked||document.hidden||
   viewport.scrollWidth>viewport.clientWidth+1||(window.visualViewport?.scale??1)>1;
  const deltaFor=(x:number):Turn=>(x<0?1:-1)*(latest.current.direction==='rtl'?-1:1) as Turn;
  const down=(event:PointerEvent)=>{
   // A fresh press is not the trailing click of the previous drag, which some
   // touch browsers omit entirely after preventDefault or pointer capture.
   if(event.isPrimary!==false&&event.button===0)clickUntil=0;
   if(unavailable()||(phase&&(phase!=='entering'||pending))||touches.size>1||event.isPrimary===false||event.button!==0||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
   const target=event.target as Element|null;
   if(target?.closest?.(READER_INTERACTIVE)||window.getSelection?.()?.toString())return;
   if(phase)reset();
   gesture={id:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,lastTime:event.timeStamp,velocity:0,dragging:false};
  };
  const allDown=(event:PointerEvent)=>{
   if(event.pointerType!=='touch')return;
   touches.add(event.pointerId);
   if(touches.size>1&&gesture)reset();
  };
  const move=(event:PointerEvent)=>{
   const drag=gesture;if(!drag||drag.id!==event.pointerId)return;
   if(unavailable()){reset();return;}
   const x=event.clientX-drag.x,y=event.clientY-drag.y;
   if(!drag.dragging){
    if(Math.abs(y)>=10&&Math.abs(y)>Math.abs(x)*1.1){gesture=undefined;return;}
    if(Math.abs(x)<10||Math.abs(x)<Math.abs(y)*1.25)return;
    drag.dragging=true;setPhase('dragging');
    try{viewport.setPointerCapture(event.pointerId);}catch{/* Synthetic events and canceled pointers cannot be captured. */}
   }
   event.preventDefault();
   const elapsed=event.timeStamp-drag.lastTime;
   if(elapsed>0)drag.velocity=(event.clientX-drag.lastX)/elapsed;
   drag.lastX=event.clientX;drag.lastTime=event.timeStamp;
   // A recognized swipe turns on release. Do not run a second, homemade drag
   // animation beside the library, or move pixels away before a destination exists.
  };
  const up=(event:PointerEvent)=>{
   touches.delete(event.pointerId);
   const drag=gesture;if(!drag||drag.id!==event.pointerId)return;
   if(!drag.dragging){gesture=undefined;return;}
   clickUntil=Date.now()+500;
   const x=event.clientX-drag.x,delta=deltaFor(x),width=viewport.clientWidth;
   const flick=Math.abs(x)>=30&&Math.abs(drag.velocity)>=.5&&drag.velocity*x>0&&event.timeStamp-drag.lastTime<100;
   if(!unavailable()&&latest.current.canTurn(delta)&&(Math.abs(x)>=Math.max(48,Math.min(120,width*.18))||flick)){
    gesture=undefined;release(event.pointerId);
    const sign=delta*(latest.current.direction==='rtl'?1:-1);
    navigate(delta,sign);
   }else reset(true);
  };
  const canceled=(event:PointerEvent)=>{
   touches.delete(event.pointerId);
   if(gesture?.id===event.pointerId)reset();
  };
  // Touch starts with implicit capture on the image. Transferring it to the viewport must not cancel the drag.
  const lostCapture=(event:PointerEvent)=>{if(event.target===viewport)canceled(event);};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')reset();};
  const hidden=()=>{if(document.hidden){touches.clear();reset();}};
  const blur=()=>{touches.clear();reset();};
  const resize=()=>{
   const next=[viewport.clientWidth,viewport.clientHeight];
   if(next[0]!==size[0]||next[1]!==size[1]){size=next;reset();}
  };
  const dragstart=(event:DragEvent)=>{
   if(latest.current.enabled&&!latest.current.blocked&&(event.target as Element|null)?.closest?.('img'))event.preventDefault();
  };
  const control:Controls={
   turn,cancel:()=>reset(),click:()=>{
    if(Date.now()>=clickUntil)return false;
    clickUntil=0;return true;
   },
   sync:()=>{
    const current=latest.current;
    snapshot?.position();
    if(resetKey!==current.resetKey||blocked!==current.blocked||direction!==current.direction)reset();
    else if(identity!==current.identity){
     if(pending)enter();
     else if(phase==='dragging')reset();
     // Once committed, manifest/image updates refresh the incoming surface.
     // Direct navigation cancels explicitly; data readiness is not a new turn.
    }
    identity=current.identity;resetKey=current.resetKey;blocked=current.blocked;direction=current.direction;
   },
  };
  controls.current=control;
  viewport.addEventListener('pointerdown',down);
  viewport.addEventListener('lostpointercapture',lostCapture);
  viewport.addEventListener('dragstart',dragstart);
  window.addEventListener('pointerdown',allDown,true);
  window.addEventListener('pointermove',move,{passive:false});
  window.addEventListener('pointerup',up);
  window.addEventListener('pointercancel',canceled);
  window.addEventListener('keydown',escape);
  window.addEventListener('blur',blur);
  window.addEventListener('resize',resize);
  document.addEventListener('visibilitychange',hidden);
  const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(resize);
  observer?.observe(viewport);
  return ()=>{
   controls.current=null;reset();observer?.disconnect();
   viewport.removeEventListener('pointerdown',down);
   viewport.removeEventListener('lostpointercapture',lostCapture);
   viewport.removeEventListener('dragstart',dragstart);
   window.removeEventListener('pointerdown',allDown,true);
   window.removeEventListener('pointermove',move);
   window.removeEventListener('pointerup',up);
   window.removeEventListener('pointercancel',canceled);
   window.removeEventListener('keydown',escape);
   window.removeEventListener('blur',blur);
   window.removeEventListener('resize',resize);
   document.removeEventListener('visibilitychange',hidden);
  };
 },[options.viewport,options.surface,options.enabled]);
 useLayoutEffect(()=>{controls.current?.sync();},[options.enabled,options.blocked,options.direction,options.identity,options.resetKey]);
 const clickCapture:MouseEventHandler<HTMLDivElement>=event=>{
  if(controls.current?.click()){event.preventDefault();event.stopPropagation();}
 };
 return {
  turn:(delta:Turn):false|void=>{
   if(controls.current)return controls.current.turn(delta);
   if(latest.current.enabled&&!latest.current.canTurn(delta))return false;
   latest.current.onTurn(delta);
  },
  cancel:()=>controls.current?.cancel(),
  clickCapture,
 };
}
