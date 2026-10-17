import {useLayoutEffect, useRef, type MouseEventHandler, type RefObject} from 'react';
import {pageSnapshot} from './page-snapshot';
import {READER_INTERACTIVE} from './reader-input';

type Turn = -1 | 1;
type Phase = 'dragging' | 'entering' | 'settling';
type Options = {
 viewport:RefObject<HTMLDivElement|null>;
 surface:RefObject<HTMLDivElement|null>;
 enabled:boolean;
 blocked:boolean;
 direction:'ltr'|'rtl';
 identity:string;
 resetKey:string;
 canTurn:(delta:Turn)=>boolean;
 onTurn:(delta:Turn)=>void;
 onActivityChange?:(active:boolean)=>void;
 onSettled?:()=>void;
};
type Controls = {turn:(delta:Turn)=>false|void;cancel:()=>void;sync:()=>void;click:()=>boolean};

/** Only the live spread owns reading state; the outgoing visual layer lasts for one bounded slide. */
export function usePagedSwipe(options:Options){
 const latest=useRef(options);latest.current=options;
 const controls=useRef<Controls|null>(null);
 useLayoutEffect(()=>{
  if(!options.enabled)return;
  const viewport=options.viewport.current,surface=options.surface.current;
  if(!viewport||!surface)return;
  let phase:Phase|undefined,animation:Animation|undefined,outgoingAnimation:Animation|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  let snapshot:ReturnType<typeof pageSnapshot>|undefined;
  let generation=0,clickUntil=0,identity=latest.current.identity,resetKey=latest.current.resetKey;
  let enabled=latest.current.enabled,blocked=latest.current.blocked,direction=latest.current.direction;
  let size=[viewport.clientWidth,viewport.clientHeight];
  let pending:{identity:string;sign:number;offset:number}|undefined;
  let gesture:{id:number;x:number;y:number;lastX:number;lastTime:number;velocity:number;offset:number;dragging:boolean}|undefined;
  const touches=new Set<number>();
  const reduced=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
  const transform=(x:number)=>{surface.style.transform=`translate3d(${x}px,0,0)`;};
  const snapshotTransform=(x:number)=>{if(snapshot)snapshot.element.style.transform=`translate3d(${x}px,0,0)`;};
  const setPhase=(next:Phase|undefined)=>{
   const active=!!phase;phase=next;
   if(next){viewport.dataset.swipePhase=next;surface.style.willChange='transform';}
   else{delete viewport.dataset.swipePhase;surface.style.removeProperty('will-change');}
   if(active!==!!next)latest.current.onActivityChange?.(!!next);
  };
  const stopAnimation=()=>{
   if(timer!==undefined){clearTimeout(timer);timer=undefined;}
   if(animation){animation.onfinish=null;animation.cancel();animation=undefined;}
   outgoingAnimation?.cancel();outgoingAnimation=undefined;
  };
  const release=(id:number)=>{
   try{if(viewport.hasPointerCapture?.(id))viewport.releasePointerCapture(id);}catch{/* Pointer may already have ended. */}
  };
  const reset=(settled=false)=>{
   generation++;stopAnimation();pending=undefined;
   if(gesture?.dragging)clickUntil=Date.now()+500;
   const id=gesture?.id;gesture=undefined;if(id!==undefined)release(id);
   snapshot?.dispose();snapshot=undefined;
   surface.style.removeProperty('visibility');surface.style.removeProperty('transform');setPhase(undefined);
   if(settled)latest.current.onSettled?.();
  };
  const animate=(from:number,to:number,duration:number,next:Phase,done:()=>void)=>{
   stopAnimation();setPhase(next);transform(from);
   const version=generation;
   if(reduced()||typeof surface.animate!=='function'){transform(to);done();return;}
   animation=surface.animate([{transform:`translate3d(${from}px,0,0)`},{transform:`translate3d(${to}px,0,0)`}],{duration,easing:'cubic-bezier(.2,.7,.2,1)',fill:'forwards'});
   animation.onfinish=()=>{
    if(version!==generation)return;
    transform(to);stopAnimation();done();
   };
  };
  const enter=()=>{
   const turn=pending;if(!turn)return;
   pending=undefined;stopAnimation();
   if(reduced()){reset(true);return;}
   const width=viewport.clientWidth,from=turn.offset-turn.sign*width;
   // Both layers move on the same frame; image and translation loading never hold navigation.
   surface.style.removeProperty('visibility');
   animate(from,0,240,'entering',()=>reset(true));
   if(snapshot&&typeof snapshot.element.animate==='function')outgoingAnimation=snapshot.element.animate([
    {transform:`translate3d(${turn.offset}px,0,0)`},{transform:`translate3d(${turn.sign*width}px,0,0)`},
   ],{duration:240,easing:'cubic-bezier(.2,.7,.2,1)',fill:'forwards'});
  };
  const navigate=(delta:Turn,sign:number,offset=0)=>{
   pending={identity:latest.current.identity,sign,offset};
   setPhase('entering');
   snapshot=pageSnapshot(viewport,surface,offset);snapshotTransform(offset);
   surface.style.visibility='hidden';surface.style.removeProperty('transform');
   // Guard only a navigation that never commits. A committed page starts the slide immediately.
   timer=setTimeout(()=>reset(),1000);
   latest.current.onTurn(delta);
  };
  const turn=(delta:Turn):false|void=>{
   const current=latest.current;
   if(!current.enabled){current.onTurn(delta);return;}
   // Consume repeated shortcut presses without letting native PageDown/arrow scrolling leak through.
   if(phase)return;
   if(!current.canTurn(delta))return false;
   if(current.blocked||document.hidden)return false;
   const sign=delta*(current.direction==='rtl'?1:-1);
   navigate(delta,sign);
  };
  const settle=()=>{
   const offset=gesture?.offset??0,id=gesture?.id;
   gesture=undefined;if(id!==undefined)release(id);
   if(phase)animate(offset,0,170,'settling',()=>reset(true));
  };
  const unavailable=()=>!latest.current.enabled||latest.current.blocked||document.hidden||
   viewport.scrollWidth>viewport.clientWidth+1||(window.visualViewport?.scale??1)>1;
  const deltaFor=(x:number):Turn=>(x<0?1:-1)*(latest.current.direction==='rtl'?-1:1) as Turn;
  const down=(event:PointerEvent)=>{
   // A fresh press is not the trailing click of the previous drag, which some
   // touch browsers omit entirely after preventDefault or pointer capture.
   if(event.isPrimary!==false&&event.button===0)clickUntil=0;
   if(unavailable()||phase||touches.size>1||event.isPrimary===false||event.button!==0||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
   const target=event.target as Element|null;
   if(target?.closest?.(READER_INTERACTIVE)||window.getSelection?.()?.toString())return;
   gesture={id:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,lastTime:event.timeStamp,velocity:0,offset:0,dragging:false};
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
   const width=Math.max(1,viewport.clientWidth);
   // Keep the current page visible during the gesture without mounting decoded neighbors.
   drag.offset=latest.current.canTurn(deltaFor(x))?Math.max(-width*.4,Math.min(width*.4,x)):x*.2/(1+Math.abs(x)/width);
   transform(drag.offset);
  };
  const up=(event:PointerEvent)=>{
   touches.delete(event.pointerId);
   const drag=gesture;if(!drag||drag.id!==event.pointerId)return;
   if(!drag.dragging){gesture=undefined;return;}
   clickUntil=Date.now()+500;
   const x=event.clientX-drag.x,delta=deltaFor(x),width=viewport.clientWidth;
   const flick=Math.abs(x)>=30&&Math.abs(drag.velocity)>=.5&&drag.velocity*x>0&&event.timeStamp-drag.lastTime<100;
   if(!unavailable()&&latest.current.canTurn(delta)&&(Math.abs(x)>=Math.max(48,Math.min(120,width*.18))||flick)){
    const offset=drag.offset;gesture=undefined;release(event.pointerId);
    const sign=delta*(latest.current.direction==='rtl'?1:-1);
    navigate(delta,sign,offset);
   }else settle();
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
    if(resetKey!==current.resetKey||enabled!==current.enabled||blocked!==current.blocked||direction!==current.direction)reset();
    else if(identity!==current.identity){
     if(pending?.identity===identity)enter();
     else reset();
    }
    identity=current.identity;resetKey=current.resetKey;enabled=current.enabled;blocked=current.blocked;direction=current.direction;
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
