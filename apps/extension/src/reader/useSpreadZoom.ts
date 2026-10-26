import {useLayoutEffect,useRef,useState,type RefObject} from 'react';
import {READER_INTERACTIVE} from './reader-input';

type Options={viewport:RefObject<HTMLDivElement|null>;stack:RefObject<HTMLDivElement|null>;enabled:boolean;blocked:boolean;resetKey:string};
type Pose={scale:number;x:number;y:number};
type Controls={change:(value:number|((zoom:number)=>number))=>void;reset:()=>void;cancel:()=>void};

/** Temporary inspection of the fitted spread; never changes page geometry or the saved single-page zoom. */
export function useSpreadZoom(options:Options){
 const latest=useRef(options);latest.current=options;
 const controls=useRef<Controls|null>(null);
 const [zoom,setZoom]=useState(100);
 useLayoutEffect(()=>{
  if(!options.enabled)return;
  const viewport=options.viewport.current;if(!viewport)return;
  let pose:Pose={scale:1,x:0,y:0};
  // React may detach or replace the callback ref before cleanup; keep the node we changed.
  let transformedStack:HTMLDivElement|null=null;
  const clearTransform=()=>{transformedStack?.style.removeProperty('transform');transformedStack=null;};
  let gesture:{id:number;x:number;y:number;startX:number;startY:number;dragging:boolean}|undefined;
  const touches=new Set<number>();
  const cancel=()=>{
   const drag=gesture;gesture=undefined;delete viewport.dataset.zoomDragging;
   try{if(drag&&viewport.hasPointerCapture?.(drag.id))viewport.releasePointerCapture(drag.id);}catch{/* Pointer may already have ended. */}
  };
  const apply=(next:Pose)=>{
   if(next.scale===1){
    clearTransform();pose={scale:1,x:0,y:0};
    delete viewport.dataset.zoomed;viewport.dataset.spreadZoom='100';return;
   }
   const stack=latest.current.stack.current;if(!stack)return;
   if(transformedStack!==stack){clearTransform();transformedStack=stack;}
   const limitX=Math.max(0,(stack.offsetWidth*next.scale-viewport.clientWidth)/2);
   const limitY=Math.max(0,(stack.offsetHeight*next.scale-viewport.clientHeight)/2);
   pose={scale:next.scale,x:Math.max(-limitX,Math.min(limitX,next.x)),y:Math.max(-limitY,Math.min(limitY,next.y))};
   stack.style.transform=`translate3d(${pose.x}px,${pose.y}px,0) scale(${pose.scale})`;viewport.dataset.zoomed='true';
   viewport.dataset.spreadZoom=String(pose.scale*100);
  };
  const reset=()=>{cancel();apply({scale:1,x:0,y:0});setZoom(100);};
  const scaleTo=(value:number,point?:{x:number;y:number})=>{
   const stack=latest.current.stack.current;if(!stack||!Number.isFinite(value))return;
   const scale=Math.max(1,Math.min(4,value/100));if(scale===pose.scale)return;
   cancel();
   const box=stack.getBoundingClientRect();
   // The transformed center minus pan is the stable, fitted center, even for RTL pairs.
   const x=point?point.x-(box.left+box.width/2-pose.x):0;
   const y=point?point.y-(box.top+box.height/2-pose.y):0;
   const ratio=scale/pose.scale;
   apply({scale,x:x-(x-pose.x)*ratio,y:y-(y-pose.y)*ratio});setZoom(scale*100);
  };
  const unavailable=()=>latest.current.blocked||document.hidden||(window.visualViewport?.scale??1)>1;
  const wheel=(event:WheelEvent)=>{
   if(unavailable()||event.ctrlKey||event.metaKey||event.altKey||!event.deltaY||(event.target as Element|null)?.closest?.(READER_INTERACTIVE))return;
   event.preventDefault();
   const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?viewport.clientHeight:1);
   scaleTo(pose.scale*100*Math.exp(-Math.max(-600,Math.min(600,delta))*.002),{x:event.clientX,y:event.clientY});
  };
  const down=(event:PointerEvent)=>{
   if(pose.scale===1||unavailable()||gesture||touches.size>1||event.isPrimary===false||event.button!==0||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
   if((event.target as Element|null)?.closest?.(READER_INTERACTIVE)||window.getSelection?.()?.toString())return;
   gesture={id:event.pointerId,x:event.clientX,y:event.clientY,startX:pose.x,startY:pose.y,dragging:false};
  };
  const allDown=(event:PointerEvent)=>{if(event.pointerType==='touch'){touches.add(event.pointerId);if(touches.size>1)cancel();}};
  const move=(event:PointerEvent)=>{
   const drag=gesture;if(!drag||drag.id!==event.pointerId)return;
   if(unavailable()||event.pointerType==='mouse'&&event.buttons!==1||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey){cancel();return;}
   const x=event.clientX-drag.x,y=event.clientY-drag.y;
   if(!drag.dragging){
    if(Math.hypot(x,y)<5)return;
    drag.dragging=true;viewport.dataset.zoomDragging='true';
    try{viewport.setPointerCapture(event.pointerId);}catch{/* Synthetic or canceled pointers cannot be captured. */}
   }
   event.preventDefault();apply({scale:pose.scale,x:drag.startX+x,y:drag.startY+y});
  };
  const up=(event:PointerEvent)=>{touches.delete(event.pointerId);if(gesture?.id===event.pointerId)cancel();};
  const lostCapture=(event:PointerEvent)=>{if(event.target===viewport)up(event);};
  const inactive=()=>{touches.clear();cancel();};
  const hidden=()=>{if(document.hidden)inactive();};
  const dragstart=(event:DragEvent)=>{if(pose.scale>1&&(event.target as Element|null)?.closest?.('img'))event.preventDefault();};
  controls.current={change:value=>scaleTo(typeof value==='function'?value(pose.scale*100):value),reset,cancel};
  viewport.addEventListener('wheel',wheel,{passive:false});
  viewport.addEventListener('pointerdown',down);
  viewport.addEventListener('lostpointercapture',lostCapture);
  viewport.addEventListener('dragstart',dragstart);
  viewport.addEventListener('contextmenu',cancel);
  window.addEventListener('pointerdown',allDown,true);
  window.addEventListener('pointermove',move,{passive:false});
  window.addEventListener('pointerup',up);
  window.addEventListener('pointercancel',up);
  window.addEventListener('blur',inactive);
  document.addEventListener('visibilitychange',hidden);
  return()=>{
   cancel();clearTransform();
   delete viewport.dataset.zoomed;delete viewport.dataset.spreadZoom;controls.current=null;
   viewport.removeEventListener('wheel',wheel);viewport.removeEventListener('pointerdown',down);
   viewport.removeEventListener('lostpointercapture',lostCapture);viewport.removeEventListener('dragstart',dragstart);
   viewport.removeEventListener('contextmenu',cancel);
   window.removeEventListener('pointerdown',allDown,true);window.removeEventListener('pointermove',move);
   window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);window.removeEventListener('blur',inactive);
   document.removeEventListener('visibilitychange',hidden);
  };
 },[options.enabled,options.viewport,options.stack]);
 useLayoutEffect(()=>{controls.current?.reset();setZoom(100);},[options.enabled,options.resetKey]);
 useLayoutEffect(()=>{if(options.blocked)controls.current?.cancel();},[options.blocked]);
 return {zoom,zoomed:options.enabled&&zoom>100,change:(value:number|((zoom:number)=>number))=>controls.current?.change(value),reset:()=>controls.current?.reset()};
}
