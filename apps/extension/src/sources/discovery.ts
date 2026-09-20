import {msg} from '../i18n/runtime';
import type {PageManifest} from './adapters';

export const discoveryDelay=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
 signal?.throwIfAborted();
 const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
 const timer=setTimeout(finish,ms);
 const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason);};
 signal?.addEventListener('abort',abort,{once:true});
});

/** Bound discovery by both inactivity and total duration; partial results stay partial. */
export async function pollSourceDiscovery<T extends Pick<PageManifest,'items'|'knownTotal'|'discoveryComplete'|'note'>>(
 poll:()=>Promise<T|null>,
 options:{signal?:AbortSignal;onProgress?:(manifest:T)=>Promise<void>;assertActive?:()=>Promise<void>;isComplete?:(manifest:T)=>boolean}={},
):Promise<T>{
 const started=Date.now();let lastGrowth=started,latest:T|undefined,count=-1;
 while(Date.now()-started<Math.min(15*60_000,60_000+(latest?.knownTotal??0)*3000)){
  options.signal?.throwIfAborted();await options.assertActive?.();
  const manifest=await poll();
  options.signal?.throwIfAborted();await options.assertActive?.();
  if(manifest){
   latest=manifest;
   if(manifest.items.length>count){count=manifest.items.length;lastGrowth=Date.now();await options.onProgress?.(manifest);}
   if(options.isComplete?options.isComplete(manifest):manifest.discoveryComplete)return manifest;
  }
  if(Date.now()-lastGrowth>40_000)throw Error(msg("{0} 40 秒未发现新图片；请打开来源处理登录／验证后继续，已有进度已保留。", {"0": (latest?.note??msg("来源页面尚未就绪。"))}));
  await discoveryDelay(120,options.signal);
 }
 throw Error(msg("{0} 已保留已发现页面，可打开来源后继续补齐。", {"0": (latest?.note??msg("来源清单读取超时。"))}));
}
