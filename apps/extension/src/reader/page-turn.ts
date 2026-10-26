import {PageFlip} from '@gullabs/flipbook-core';
import '@gullabs/flipbook-core/style.css';
import {pageSnapshot} from './page-snapshot';

/** Four disposable faces, one library engine, no hidden React reader or image requests. */
export function pageTurn(viewport:HTMLDivElement,surface:HTMLDivElement,sign:number){
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
 Object.assign(host.style,{width:`${viewport.clientWidth}px`,height:`${viewport.clientHeight}px`});
 book.className='nc-page-turn';
 // Landscape leaves also serve single-page reading; the unused half is outside
 // the viewport. The library's portrait clone would lose streaming canvas pixels.
 Object.assign(book.style,{width:`${leafWidth*2}px`,height:`${height}px`,top:`${top}px`,left:`${left-(columns===1&&sign<0?leafWidth:0)}px`});
 const blank=()=>{const leaf=document.createElement('div');leaf.className='nc-flip-leaf';return leaf;};
 const pair=(leaves:HTMLElement[])=>columns===2?leaves:sign<0?[blank(),leaves[0]]:[leaves[0],blank()];
 const old=pair(outgoing.leaves),next=[blank(),blank()];
 old.forEach(leaf=>leaf.dataset.flipFace='outgoing');next.forEach(leaf=>leaf.dataset.flipFace='incoming');
 const leaves=sign<0?[...old,...next]:[...next,...old];
 host.append(book);viewport.append(host);
 let engine:PageFlip|undefined,incoming:ReturnType<typeof pageSnapshot>|undefined,disposed=false,completion:(()=>void)|undefined;
 let frame=0,watchdog:ReturnType<typeof setTimeout>|undefined,updates:MutationObserver|undefined;
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
  engine.on('changeState',event=>{
   if(event.data.state==='read'&&completion){const done=completion;completion=undefined;queueMicrotask(()=>{if(!disposed)done();});}
  });
 }catch{dispose();return;}
 return {position,dispose,play(done:()=>void){
  if(disposed)return;
  const refresh=()=>{
   if(disposed)return;
   const previous=incoming;incoming=pageSnapshot(viewport,surface,columns,paper);
   const faces=pair(incoming.leaves);
   next.forEach((leaf,index)=>leaf.replaceChildren(...faces[index].childNodes));previous?.dispose();
  };
  refresh();
  // A newly displayed image/retry result must not stay hidden behind an obsolete
  // loading placeholder for the rest of the curl. Only the leaf contents change.
  updates=typeof MutationObserver==='undefined'?undefined:new MutationObserver(refresh);
  updates?.observe(surface,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style']});
  completion=done;
  // A frame lets the engine finish initial layout before starting its own RAF animation.
  frame=requestAnimationFrame(()=>{
   if(disposed)return;
   try{if(!(sign<0?engine!.flipNext('bottom'):engine!.flipPrev('bottom')))done();}
   catch{done();}
  });
  // A missed library completion cannot pin the old page indefinitely.
  watchdog=setTimeout(()=>{if(!disposed)done();},800);
 }};
}
