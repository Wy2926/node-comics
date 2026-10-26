/** Opt-in local fixture instrumentation. No production rendering or input overrides. */
import {useRef,useState} from 'react';
import {PageFlip} from '@gullabs/flipbook-core';
import {sourcePageCache} from '../src/storage/source-pages';
const nativeRAF=window.requestAnimationFrame.bind(window),nativeCancel=window.cancelAnimationFrame.bind(window);
let freezeAt=Infinity,engineScope=false,created=0,played=0,active=0,peak=0,engineFrames=0;
let progress=0,reads=0,foldCalls=0,foldMs=0;
const read=sourcePageCache.get.bind(sourcePageCache);
sourcePageCache.get=async key=>{reads++;return read(key);};
const pending=new Map<number,FrameRequestCallback>(),enginePending=new Set<number>(),live=new WeakSet<PageFlip>();
const longTasks:number[]=[],errors:string[]=[];
window.addEventListener('error',event=>errors.push(event.message));
window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
window.requestAnimationFrame=callback=>{
 const owned=engineScope;
 const id=nativeRAF(time=>{
  enginePending.delete(id);
  if(owned&&time>=freezeAt){pending.set(id,callback);return;}
  const before=engineScope;engineScope=owned;
  try{if(owned)engineFrames++;callback(time);}finally{engineScope=before;}
 });
 if(owned)enginePending.add(id);return id;
};
window.cancelAnimationFrame=id=>{pending.delete(id);enginePending.delete(id);nativeCancel(id);};
for(const name of ['loadFromHTML','flipNext','flipPrev','userMove','destroy'] as const){
 const original=PageFlip.prototype[name];
 Object.assign(PageFlip.prototype,{[name]:function(this:PageFlip,...args:unknown[]){
  const before=engineScope;engineScope=true;
  try{
   const start=performance.now(),result=Reflect.apply(original,this,args);
   if(name==='userMove'){foldCalls++;foldMs+=performance.now()-start;}
   if(name==='loadFromHTML'&&!live.has(this)){live.add(this);created++;active++;peak=Math.max(peak,active);this.on('turnProgress',event=>{progress=event.data.progress;});}
   if((name==='flipNext'||name==='flipPrev')&&result)played++;
   if(name==='destroy'&&live.delete(this))active--;
   return result;
  }finally{engineScope=before;}
 }});
}
if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>Math.round(e.duration)))).observe({entryTypes:['longtask']});
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const turn=(next:boolean)=>{
 const buttons=document.querySelectorAll<HTMLButtonElement>('.nc-reader-navigation button');
 (next?buttons[buttons.length-1]:buttons[0])?.click();
};
function resume(){freezeAt=Infinity;for(const [id,callback] of pending){pending.delete(id);nativeRAF(callback);}}
export function ReaderFlipMetrics(){
 const [report,setReport]=useState(''),[busy,setBusy]=useState(false);
 const held=useRef<{viewport:HTMLElement;pointerType:string;x:number;y:number;end:number;width:number;reads:number;page:string|undefined}|undefined>(undefined);
 const position=()=>document.querySelector<HTMLElement>('.nc-reader-position')?.dataset.value;
 const emitPointer=(type:string,x:number)=>{
  const drag=held.current;if(!drag)return;
  drag.viewport.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:91,pointerType:drag.pointerType,isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:drag.y}));
 };
 const heldReport=()=>{
  const drag=held.current;
  setReport(JSON.stringify({pointer:drag?.pointerType,page:position(),original:drag?.page,progress:Number(progress.toFixed(3)),phase:drag?.viewport.dataset.swipePhase??'idle',extraReads:drag?reads-drag.reads:0,active,overlays:document.querySelectorAll('[data-swipe-snapshot]').length,errors}));
 };
 async function dragPreview(pointerType:string,back=false){
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));resume();
  const viewport=document.querySelector<HTMLElement>('.nc-reading-viewport')!,rect=viewport.getBoundingClientRect();
  const pages=[...viewport.querySelectorAll<HTMLElement>('.nc-reading-surface .nc-manga-page')].map(page=>page.getBoundingClientRect());
  const width=Math.max(...pages.map(page=>page.right))-Math.min(...pages.map(page=>page.left));
  const rtl=viewport.querySelector('[data-direction="rtl"]')!==null,right=back?!rtl:rtl;
  const x=rect.left+rect.width*(right?.15:.85),y=rect.top+rect.height*.7;
  held.current={viewport,pointerType,x,y,end:x+(right?1:-1)*width*.12,width,reads,page:position()};
  emitPointer('pointerdown',x);emitPointer('pointermove',held.current.end);
  await wait(70);heldReport();
 }
 async function moveHeld(fraction:number){
  const drag=held.current;if(!drag)return;
  drag.end=drag.x+Math.sign(drag.end-drag.x)*drag.width*fraction;emitPointer('pointermove',drag.end);await wait(70);heldReport();
 }
 async function releaseHeld(){
  if(!held.current)return;emitPointer('pointerup',held.current.end);await wait(600);heldReport();held.current=undefined;
 }
 async function touchScenario(commit:boolean,back=false){
  setBusy(true);await dragPreview('touch',back);const original=position(),chapter=document.querySelector<HTMLElement>('.nc-reading-surface .nc-stream-chapter')?.dataset.copyId,stages=[progress];
  await moveHeld(.65);stages.push(progress);
  if(!commit){await moveHeld(.06);stages.push(progress);}
  const beforeRelease=position(),extraReads=reads-held.current!.reads;
  const previewURLs=new Set([...document.querySelectorAll<HTMLImageElement>('[data-flip-face="incoming"] .nc-page-image')].map(image=>image.src));
  await releaseHeld();const reused=[...document.querySelectorAll<HTMLImageElement>('.nc-reading-surface .nc-page-image')].filter(image=>previewURLs.has(image.src)).length;
  setReport(JSON.stringify({pointer:'touch',commit,stages:stages.map(value=>Number(value.toFixed(3))),original,beforeRelease,page:position(),chapter,nextChapter:document.querySelector<HTMLElement>('.nc-reading-surface .nc-stream-chapter')?.dataset.copyId,previewImages:previewURLs.size,reused,extraReads,active,overlays:document.querySelectorAll('[data-swipe-snapshot]').length,errors}));setBusy(false);
 }
 async function measureDrag(){
  setBusy(true);await dragPreview(matchMedia('(pointer:coarse)').matches?'touch':'mouse');
  const drag=held.current!;foldCalls=foldMs=0;longTasks.length=errors.length=0;
  const gaps:number[]=[];let last=performance.now();
  for(let n=0;n<90;n++){
   const now=await new Promise<number>(nativeRAF);gaps.push(now-last);last=now;
   const distance=drag.width*(.06+.25*(1-Math.cos(n*Math.PI/30)));
   drag.end=drag.x+Math.sign(drag.end-drag.x)*distance;
   // Two input samples in one browser frame must share one library fold update.
   emitPointer('pointermove',drag.end);emitPointer('pointermove',drag.end);
  }
  await moveHeld(.06);const extraReads=reads-drag.reads,original=drag.page;
  await releaseHeld();gaps.sort((a,b)=>a-b);
  setReport(JSON.stringify({pointer:drag.pointerType,viewport:[innerWidth,innerHeight],frames:90,inputSamples:180,foldCalls,foldMs:Number(foldMs.toFixed(2)),gapP95:Number(gaps[Math.floor(gaps.length*.95)].toFixed(1)),extraReads,original,page:position(),active,overlays:document.querySelectorAll('[data-swipe-snapshot]').length,longTasks,errors}));setBusy(false);
 }
 async function measure(){
  resume();setBusy(true);created=played=peak=engineFrames=0;longTasks.length=errors.length=0;
  const geometry:number[][]=[],viewport=document.querySelector<HTMLElement>('.nc-reading-viewport')!;
  const observer=new ResizeObserver(([entry])=>{if(geometry.length<6)geometry.push([entry.contentRect.width,entry.contentRect.height,viewport.scrollWidth,viewport.scrollHeight,viewport.scrollTop]);});observer.observe(viewport);
  const gaps:number[]=[],durations:number[]=[],destinations:string[]=[];let last=0,frames=0,running=true;
  const sample=(time:number)=>{if(document.querySelector('[data-swipe-phase="entering"]')){if(last)gaps.push(time-last);last=time;frames++;}else last=0;if(running)nativeRAF(sample);};nativeRAF(sample);
  for(let n=0;n<8;n++){
   const start=performance.now();turn(n%2===0);await wait(30);
   while(document.querySelector('[data-swipe-phase]')&&performance.now()-start<1400)await wait(20);
   durations.push(Math.round(performance.now()-start));
   destinations.push(document.querySelector('.nc-reading-surface .nc-stream-chapter')?.getAttribute('data-copy-id')??'loading');await wait(100);
  }
  running=false;const atRest=engineFrames;await wait(500);gaps.sort((a,b)=>a-b);
  observer.disconnect();setReport(JSON.stringify({viewport:[innerWidth,innerHeight],created,played,peak,active,enginePending:enginePending.size,idleFrames:engineFrames-atRest,overlays:document.querySelectorAll('[data-swipe-snapshot]').length,errors,longTasks,frames,gapP95:Number((gaps[Math.floor(gaps.length*.95)]??0).toFixed(1)),gapsOver34:gaps.filter(gap=>gap>34).length,geometry,turns:durations,destinations}));setBusy(false);
 }
 async function measureToolbar(){
  setBusy(true);const reader=document.querySelector('.nc-reader'),start=performance.now();let hiddenAt:number|undefined;
  const hidden=()=>reader?.classList.contains('controls-hidden')??false;
  const observer=new MutationObserver(()=>{if(hidden()&&hiddenAt===undefined)hiddenAt=Math.round(performance.now()-start);});
  if(reader)observer.observe(reader,{attributes:true,attributeFilter:['class']});
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
  await wait(5900);const hiddenBefore=hidden();await wait(400);
  setReport(JSON.stringify({immersive:reader?.classList.contains('is-immersive'),hiddenBefore6s:hiddenBefore,hiddenAfter6s:hidden(),hiddenAt}));
  observer.disconnect();setBusy(false);
 }
 function freeze(){resume();freezeAt=performance.now()+160;turn(true);setReport('暂停于卷页中间帧；点击“继续动画”恢复。');}
 return <div style={{background:'#fff',position:'relative',zIndex:20,fontSize:12}}><button disabled={busy} onClick={()=>void measure()}>测量 8 次卷页</button><button disabled={busy} onClick={freeze}>查看卷页中间帧</button><button onClick={resume}>继续动画</button><button onClick={()=>setReport(JSON.stringify({created,played,peak,active,enginePending:enginePending.size,overlays:document.querySelectorAll('[data-swipe-snapshot]').length,errors}))}>读取卷页资源</button><button disabled={busy} onClick={()=>void measureToolbar()}>检查工具栏 6 秒收起</button><br/>
 <button onClick={()=>void dragPreview('mouse')}>模拟鼠标拖动</button><button onClick={()=>void dragPreview('touch')}>模拟单指滑动</button><button onClick={()=>void moveHeld(.65)}>继续拖过半页</button><button onClick={()=>void moveHeld(.06)}>拖回原处</button><button onClick={()=>void releaseHeld()}>松开模拟指针</button><button disabled={busy} onClick={()=>void measureDrag()}>测量连续拖动</button>
 <button disabled={busy} onClick={()=>void touchScenario(true)}>验证单指松手翻页</button><button disabled={busy} onClick={()=>void touchScenario(false)}>验证单指拉回</button>
 <button disabled={busy} onClick={()=>void touchScenario(true,true)}>验证单指回翻</button>
 <output style={{display:'block',height:74,overflow:'auto',overflowWrap:'anywhere'}}>{report}</output></div>;
}
