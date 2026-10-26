import {PageFlip,type Point} from '@gullabs/flipbook-core';
import '@gullabs/flipbook-core/style.css';
import {pageSnapshot} from './page-snapshot';
import type {PageTurn} from './page-turn';

/** Four disposable faces and one library engine; image ownership stays with ReaderPicture. */
export function pageCurl(viewport:HTMLDivElement,surface:HTMLDivElement,sign:number):PageTurn|undefined{
 const pages=[...surface.querySelectorAll('.nc-manga-page')].map(page=>page.getBoundingClientRect());
 const bounds=viewport.getBoundingClientRect();
 let left=Math.max(0,Math.min(...pages.map(page=>page.left))-bounds.left);
 const top=Math.max(0,Math.min(...pages.map(page=>page.top))-bounds.top);
 const right=Math.min(viewport.clientWidth,Math.max(...pages.map(page=>page.right))-bounds.left),bottom=Math.min(viewport.clientHeight,Math.max(...pages.map(page=>page.bottom))-bounds.top);
 let width=right-left;const height=bottom-top;
 if(width<1||height<1)return;
 const columns=viewport.dataset.layout==='double'&&pages.length===2?2:1;
 if(columns===2){
  const [a,b]=[...pages].sort((a,b)=>a.left-b.left),spine=(a.right+b.left)/2-bounds.left;
  // Scans can have different aspect ratios. Keep their actual shared edge at
  // the engine's spine; equal paper faces may extend beyond the clipped viewport.
  const half=Math.max(spine-left,right-spine);left=spine-half;width=half*2;
 }
 const leafWidth=width/columns;
 const paper={left,top,width,height};
 const outgoing=pageSnapshot(viewport,surface,columns,paper);
 const host=document.createElement('div'),book=document.createElement('div');
 host.className='nc-page-transition-clip';host.dataset.swipeSnapshot='';host.setAttribute('aria-hidden','true');host.inert=true;
 // clientHeight rounds fractional CSS pixels. A rounded-up overlay can create
 // native scrollbars, resize the viewport and cancel its own animation.
 Object.assign(host.style,{width:'100%',height:'100%'});
 book.className='nc-page-turn';
 // Landscape leaves also serve single-page reading; clip the unused half even
 // when the page is centered. Portrait cloning would lose streaming canvas pixels.
 Object.assign(book.style,{width:`${leafWidth*2}px`,height:`${height}px`,top:`${top}px`,left:`${left-(columns===1&&sign<0?leafWidth:0)}px`});
 if(columns===1)book.style.clipPath=`inset(0 ${sign>0?leafWidth:0}px 0 ${sign<0?leafWidth:0}px)`;
 const blank=()=>{const leaf=document.createElement('div');leaf.className='nc-page-turn-face';return leaf;};
 const pair=(leaves:HTMLElement[])=>columns===2?leaves:sign<0?[blank(),leaves[0]]:[leaves[0],blank()];
 const old=pair(outgoing.leaves),next=[blank(),blank()];
 old.forEach(leaf=>leaf.dataset.flipFace='outgoing');next.forEach(leaf=>leaf.dataset.flipFace='incoming');
 const leaves=sign<0?[...old,...next]:[...next,...old];
 host.append(book);viewport.append(host);
 let engine:PageFlip|undefined,incoming:ReturnType<typeof pageSnapshot>|undefined,disposed=false,completion:(()=>void)|undefined;
 let frame=0,watchdog:ReturnType<typeof setTimeout>|undefined,updates:MutationObserver|undefined;
 let previewSurface:HTMLDivElement|undefined,observed:HTMLDivElement|undefined,committed=false;
 let pointer:Point|undefined,started=false,dirty=false,progress=0,corner:'top'|'bottom'='bottom';
 const flushDrag=()=>{
  cancelAnimationFrame(frame);frame=0;
  if(disposed||!engine||!pointer||!dirty)return;dirty=false;
  if(!started){
   // Seed the correct physical edge before a large first move crosses the spine.
   const edge=sign<0?leafWidth*2:0;
   engine.startUserTouch({x:edge,y:pointer.y});
   engine.userMove({x:edge+sign*6,y:pointer.y},true);started=true;
  }
  engine.userMove(pointer,true);
 };
 const position=()=>{host.style.left=`${viewport.scrollLeft}px`;host.style.top=`${viewport.scrollTop}px`;};
 position();viewport.addEventListener('scroll',position,{passive:true});
 const dispose=()=>{
  if(disposed)return;disposed=true;completion=undefined;cancelAnimationFrame(frame);clearTimeout(watchdog);
  viewport.removeEventListener('scroll',position);
  updates?.disconnect();engine?.destroy();engine=undefined;host.remove();outgoing.dispose();incoming?.dispose();
 };
 try{
  engine=new PageFlip(book,{width:leafWidth,height,sizing:'fixed',autoSize:false,usePortrait:false,initialPage:sign<0?0:2,
   pointerInput:[],flipOnClick:'never',foldCornerOnHover:false,flippingTime:360,maxShadowOpacity:.22,
   pageBackground:'#fff',injectStyles:false});
  engine.loadFromHTML(leaves);
  engine.on('turnProgress',event=>{progress=event.data.progress;});
  engine.on('changeState',event=>{
   if(event.data.state==='read'&&completion){const done=completion;completion=undefined;queueMicrotask(()=>{if(!disposed)done();});}
  });
 }catch{dispose();return;}
 const observe=(source:HTMLDivElement)=>{
  if(observed===source)return;observed=source;updates?.disconnect();
  const refresh=()=>{
   if(disposed)return;
   const previous=incoming;incoming=pageSnapshot(viewport,source,columns,paper);
   const faces=pair(incoming.leaves);
   next.forEach((leaf,index)=>leaf.replaceChildren(...faces[index].childNodes));previous?.dispose();
  };
  refresh();
  updates=typeof MutationObserver==='undefined'?undefined:new MutationObserver(refresh);
  updates?.observe(source,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','src']});
 };
 const settle=(done:()=>void,commit:boolean)=>{
  flushDrag();completion=done;
  frame=requestAnimationFrame(()=>{
   frame=0;if(disposed)return;
   try{
    if(started&&pointer){
     // Normal drags settle from the held fold. A short flick uses the library's
     // own programmed turn, just as its built-in touch input does.
     const flick=commit&&progress<.5;
     engine!.userStop(pointer,flick);
     if(!flick){if(engine!.getState()==='read')done();return;}
    }
    if(commit&&!(sign<0?engine!.flipNext(corner):engine!.flipPrev(corner)))done();
    else if(!commit)done();
   }catch{done();}
  });
  watchdog=setTimeout(()=>{if(!disposed)done();},800);
 };
 return {position,dispose,
  preview(source:HTMLDivElement|null){if(!disposed&&!committed&&source){previewSurface=source;observe(source);}},
  drag(start:Point,current:Point){
   if(disposed)return;
   const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
   // A single visible leaf clips half the book: map its travel to the full
   // engine span so releasing past half the visible page completes the turn.
   pointer={x:clamp((sign<0?leafWidth*2:0)+(current.x-start.x)*(columns===1?2:1),1,leafWidth*2-1),
    y:clamp(current.y-bounds.top-top,1,height-1)};
   dirty=true;
   if(!started)corner=start.y-bounds.top-top<height/2?'top':'bottom';
   if(!frame)frame=requestAnimationFrame(flushDrag);
  },
  canCommit(){flushDrag();return progress>=.5;},
  revert(done:()=>void){if(!disposed)settle(done,false);},
  play(done:()=>void){
  if(disposed)return;
  committed=true;
  // A drag already reveals this destination. Keep its prepared pixels through
  // handoff instead of replacing them with a newly mounted loading placeholder.
  observe(previewSurface??surface);
  settle(done,true);
 }};
}
