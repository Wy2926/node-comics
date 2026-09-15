import {discoverDocument,type PageManifest} from './adapters';

type Snapshot=ReturnType<typeof discoverDocument>;
export const discoveryDelay=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
 signal?.throwIfAborted();
 const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
 const timer=setTimeout(finish,ms);
 const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason);};
 signal?.addEventListener('abort',abort,{once:true});
});

/** Move the scrollbar to the middle as lazy slots enlarge the document.
 * Older source readers only append near the first image: use that position once
 * if the midpoint makes no progress, then resume midpoint discovery next poll.
 */
export async function advanceMangaCopyDiscovery(doc:Document,view:Window):Promise<Snapshot>{
 const before=discoverDocument(doc,view.location.href);
 if(before.adapter!=='mangacopy'||before.discoveryComplete)return before;
 const first=doc.querySelector<HTMLImageElement>('.comicContent-list img');
 if(!first){await discoveryDelay(600);return discoverDocument(doc,view.location.href);}
 const range=Math.max(0,(doc.scrollingElement??doc.documentElement).scrollHeight-view.innerHeight);
 const midpoint=Math.round(range/2);
 const target=Math.abs(view.scrollY-midpoint)<2?Math.min(range,midpoint+Math.max(120,Math.round(view.innerHeight/2))):midpoint;
 const scrollAndWait=(position:number)=>new Promise<void>(resolve=>{
  const done=()=>{observer.disconnect();clearTimeout(timer);resolve();};
  const observer=new MutationObserver(()=>{
   const next=discoverDocument(doc,view.location.href);
   if(next.items.length!==before.items.length||next.discoveryComplete)done();
  });
  const timer=setTimeout(done,1000);
  observer.observe(doc.querySelector('.comicContent-list')!,{childList:true,subtree:true,attributes:true,attributeFilter:['data-src']});
  view.scrollTo({top:position,behavior:'instant'});
 });
 await scrollAndWait(target);
 const next=discoverDocument(doc,view.location.href);
 if(next.items.length===before.items.length&&!next.discoveryComplete){
  const top=first.getBoundingClientRect().top+view.scrollY;
  await scrollAndWait(Math.max(1,Math.round(top+Math.min(80,view.innerHeight/5))));
  // Leave the visible scrollbar in the middle even on the older lazy reader.
  view.scrollTo({top:Math.round(Math.max(0,(doc.scrollingElement??doc.documentElement).scrollHeight-view.innerHeight)/2),behavior:'instant'});
 }
 return discoverDocument(doc,view.location.href);
}

/** Bound discovery by both inactivity and total duration; partial results stay partial. */
export async function pollSourceDiscovery<T extends Pick<PageManifest,'items'|'knownTotal'|'discoveryComplete'|'note'>>(
 poll:()=>Promise<T|null>,
 options:{signal?:AbortSignal;onProgress?:(manifest:T)=>Promise<void>;assertActive?:()=>Promise<void>}={},
):Promise<T>{
 const started=Date.now();let lastGrowth=started,latest:T|undefined,count=-1;
 while(Date.now()-started<Math.min(15*60_000,60_000+(latest?.knownTotal??0)*3000)){
  options.signal?.throwIfAborted();await options.assertActive?.();
  const manifest=await poll();
  options.signal?.throwIfAborted();await options.assertActive?.();
  if(manifest){
   latest=manifest;
   if(manifest.items.length>count){count=manifest.items.length;lastGrowth=Date.now();await options.onProgress?.(manifest);}
   if(manifest.discoveryComplete)return manifest;
  }
  if(Date.now()-lastGrowth>40_000)throw Error((latest?.note??'来源页面尚未就绪。')+' 40 秒未发现新图片；请打开来源处理登录／验证后继续，已有进度已保留。');
  await discoveryDelay(200,options.signal);
 }
 throw Error((latest?.note??'来源清单读取超时。')+' 已保留已发现页面，可打开来源后继续补齐。');
}
