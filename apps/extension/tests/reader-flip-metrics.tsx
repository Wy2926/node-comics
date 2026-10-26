/** Opt-in local fixture instrumentation. No production rendering or input overrides. */
import {useState} from 'react';
import {PageFlip} from '@gullabs/flipbook-core';
const nativeRAF=window.requestAnimationFrame.bind(window),nativeCancel=window.cancelAnimationFrame.bind(window);
let freezeAt=Infinity,engineScope=false,created=0,active=0,peak=0,engineFrames=0;
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
for(const name of ['loadFromHTML','flipNext','flipPrev','destroy'] as const){
 const original=PageFlip.prototype[name];
 Object.assign(PageFlip.prototype,{[name]:function(this:PageFlip,...args:unknown[]){
  const before=engineScope;engineScope=true;
  try{
   const result=Reflect.apply(original,this,args);
   if(name==='loadFromHTML'&&!live.has(this)){live.add(this);created++;active++;peak=Math.max(peak,active);}
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
 async function measure(){
  resume();setBusy(true);created=peak=engineFrames=0;longTasks.length=errors.length=0;
  const gaps:number[]=[],durations:number[]=[];let last=0,frames=0,running=true;
  const sample=(time:number)=>{if(document.querySelector('[data-swipe-phase="entering"]')){if(last)gaps.push(time-last);last=time;frames++;}else last=0;if(running)nativeRAF(sample);};nativeRAF(sample);
  for(let n=0;n<8;n++){
   const start=performance.now();turn(n%2===0);await wait(30);
   while(document.querySelector('[data-swipe-phase]')&&performance.now()-start<1400)await wait(20);
   durations.push(Math.round(performance.now()-start));await wait(100);
  }
  running=false;const atRest=engineFrames;await wait(500);gaps.sort((a,b)=>a-b);
  setReport(JSON.stringify({viewport:[innerWidth,innerHeight],turns:durations,frames,gapP95:Number((gaps[Math.floor(gaps.length*.95)]??0).toFixed(1)),gapsOver34:gaps.filter(gap=>gap>34).length,created,peak,active,enginePending:enginePending.size,idleFrames:engineFrames-atRest,overlays:document.querySelectorAll('[data-swipe-snapshot]').length,longTasks,errors}));setBusy(false);
 }
 function freeze(){resume();freezeAt=performance.now()+160;turn(true);setReport('暂停于卷页中间帧；点击“继续动画”恢复。');}
 return <div style={{background:'#fff',position:'relative',zIndex:20,fontSize:12}}><button disabled={busy} onClick={()=>void measure()}>测量 8 次卷页</button><button disabled={busy} onClick={freeze}>查看卷页中间帧</button><button onClick={resume}>继续动画</button><button onClick={()=>setReport(JSON.stringify({created,peak,active,enginePending:enginePending.size,overlays:document.querySelectorAll('[data-swipe-snapshot]').length,errors}))}>读取卷页资源</button><output style={{display:'block',height:58,overflow:'auto',overflowWrap:'anywhere'}}>{report}</output></div>;
}
