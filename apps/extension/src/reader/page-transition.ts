import {pageSnapshot} from './page-snapshot';
import type {PageTurn} from './page-turn';

/** Two flat faces borrow the same bounded snapshots as a curl; only their presentation differs. */
export function pageTransition(viewport:HTMLDivElement,surface:HTMLDivElement,sign:number,kind:'slide'|'fade'):PageTurn|undefined{
 const width=viewport.clientWidth;
 if(width<1||viewport.clientHeight<1)return;
 const outgoing=pageSnapshot(viewport,surface,1),old=outgoing.leaves[0],next=document.createElement('div');
 const host=document.createElement('div');
 host.className='nc-page-transition-clip nc-page-transition-flat';host.dataset.swipeSnapshot='';host.dataset.turnAnimation=kind;
 host.setAttribute('aria-hidden','true');host.inert=true;
 Object.assign(host.style,{width:'100%',height:'100%'});
 next.className='nc-page-turn-face';old.dataset.flipFace='outgoing';next.dataset.flipFace='incoming';
 host.append(next,old);viewport.append(host);
 let incoming:ReturnType<typeof pageSnapshot>|undefined,observed:HTMLDivElement|undefined,previewSurface:HTMLDivElement|undefined;
 let updates:MutationObserver|undefined,disposed=false,committed=false,progress=0,frame=0;
 let animations:Animation[]=[],watchdog:ReturnType<typeof setTimeout>|undefined;
 const styles=(value:number,incoming:boolean)=>kind==='fade'?{opacity:String(incoming?value:1-value)}
  :{transform:`translate3d(${sign*(incoming?value-1:value)*width}px,0,0)`};
 const paint=()=>{frame=0;if(!disposed){Object.assign(old.style,styles(progress,false));Object.assign(next.style,styles(progress,true));}};
 const position=()=>{host.style.left=`${viewport.scrollLeft}px`;host.style.top=`${viewport.scrollTop}px`;};
 position();paint();viewport.addEventListener('scroll',position,{passive:true});
 const observe=(source:HTMLDivElement)=>{
  if(observed===source)return;observed=source;updates?.disconnect();
  const refresh=()=>{
   if(disposed)return;
   const previous=incoming;incoming=pageSnapshot(viewport,source,1);
   next.replaceChildren(...incoming.leaves[0].childNodes);previous?.dispose();
  };
  refresh();
  updates=typeof MutationObserver==='undefined'?undefined:new MutationObserver(refresh);
  updates?.observe(source,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','src']});
 };
 const settle=(target:0|1,done:()=>void)=>{
  cancelAnimationFrame(frame);paint();
  const distance=Math.abs(target-progress),duration=Math.max(80,(target?260:180)*distance);
  let completed=false;
  const finish=()=>{if(disposed||completed)return;completed=true;clearTimeout(watchdog);done();};
  if(distance<.001){finish();return;}
  try{
   const finished:Promise<unknown>[]=[];
   for(const [element,incoming] of [[old,false],[next,true]] as const){
    const animation=element.animate([styles(progress,incoming),styles(target,incoming)],{duration,easing:'cubic-bezier(.2,.7,.2,1)',fill:'forwards'});
    animations.push(animation);finished.push(animation.finished.catch(()=>{}));
   }
   void Promise.all(finished).then(finish);
   watchdog=setTimeout(finish,duration+100);
  }catch{finish();}
 };
 return {position,
  preview(source){if(!disposed&&!committed&&source){previewSurface=source;observe(source);}},
  drag(start,current){
   if(disposed||committed)return;
   progress=Math.max(0,Math.min(1,sign*(current.x-start.x)/width));
   if(!frame)frame=requestAnimationFrame(paint);
  },
  canCommit:()=>progress*width>=Math.max(48,Math.min(120,width*.18)),
  revert(done){if(!disposed)settle(0,done);},
  play(done){if(!disposed){committed=true;observe(previewSurface??surface);settle(1,done);}},
  dispose(){
   if(disposed)return;disposed=true;cancelAnimationFrame(frame);clearTimeout(watchdog);
   viewport.removeEventListener('scroll',position);updates?.disconnect();
   for(const animation of animations)animation.cancel();animations=[];
   host.remove();outgoing.dispose();incoming?.dispose();
  },
 };
}
