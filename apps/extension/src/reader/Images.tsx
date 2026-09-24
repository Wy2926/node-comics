import {msg} from '../i18n/runtime';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Icon} from '../icons';
import {acquireImage,readThumbnail} from '../comics/application/image-access';
import type {Job} from '../types';
import {ImagePermissionsRequired,requestImagePermissions} from '../sources';

export function Thumbnail({blobKey,alt='',className='',retryKey=0,onError}:{blobKey?:string;alt?:string;className?:string;retryKey?:number;onError?:(error:unknown)=>void}){
  const ref=useRef<HTMLSpanElement>(null);const [visible,setVisible]=useState(false);const [loaded,setLoaded]=useState<{key:string;url:string}>();
  const failure=useRef(onError);failure.current=onError;
  useEffect(()=>{if(!ref.current)return;const observer=new IntersectionObserver(([entry])=>{if(entry.isIntersecting){setVisible(true);observer.disconnect();}},{rootMargin:'160px'});observer.observe(ref.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(!visible||!blobKey)return;let alive=true;let url='';const controller=new AbortController();void readThumbnail(blobKey,controller.signal).then(blob=>{if(alive&&blob){url=URL.createObjectURL(blob);setLoaded({key:blobKey,url});}}).catch(error=>{if(alive)failure.current?.(error);});return()=>{alive=false;controller.abort();if(url)URL.revokeObjectURL(url);};},[blobKey,visible,retryKey]);
  return <span className={`nc-thumbnail ${className}`} ref={ref}>{loaded&&loaded.key===blobKey?<img src={loaded.url} alt={alt}/>:<Icon name="book" size={28}/>}</span>;
}
export type ShownImage={scope:string;key:string;job?:Job};
export function BlobPicture({scope,blobKey,job,alt,onShown,onImport,error,sourceUrl}:{scope:string;blobKey?:string;job?:Job;alt:string;onShown?:(image:ShownImage|undefined)=>void;onImport:()=>void;error?:string;sourceUrl?:string}){
  const [loaded,setLoaded]=useState<(ShownImage&{url:string})>();const [failure,setFailure]=useState('');const [retry,setRetry]=useState(0);const urls=useRef(new Set<string>());
  const callback=useRef(onShown);callback.current=onShown;const [needsPermission,setNeedsPermission]=useState<string[]|undefined>();
  const shown=loaded?.scope===scope?loaded:undefined;
  useEffect(()=>{let active=true;setFailure('');setNeedsPermission(undefined);if(!blobKey){setLoaded(undefined);setFailure(error||msg("本地图片已清理，请重新导入原图。"));return;}
    let url='';const controller=new AbortController();let release:(()=>void)|undefined;void acquireImage(blobKey,controller.signal).then(async lease=>{release=lease.release;const blob=lease.blob;if(!active){release();return;}if(!blob)throw Error(msg("本地图片已清理，请恢复图片后重试。"));url=URL.createObjectURL(blob);urls.current.add(url);const image=new Image();image.src=url;await image.decode();if(active)setLoaded({scope,key:blobKey,job,url});else{URL.revokeObjectURL(url);urls.current.delete(url);}}).catch(e=>{if(active){setFailure((e as Error).message);setNeedsPermission(e instanceof ImagePermissionsRequired?e.origins:undefined);}if(url){URL.revokeObjectURL(url);urls.current.delete(url);}});
    return()=>{active=false;controller.abort();release?.();};
  },[scope,blobKey,retry]);
  useEffect(()=>{for(const url of urls.current)if(url!==loaded?.url){URL.revokeObjectURL(url);urls.current.delete(url);}},[loaded]);
  useEffect(()=>()=>{for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();},[]);
  // The identity follows the decoded image actually on screen, never a pending network result.
  useLayoutEffect(()=>{callback.current?.(shown);return()=>callback.current?.(undefined);},[shown?.scope,shown?.key]);
  return <>{shown?<img className="nc-page-image" src={shown.url} alt={`${alt}${shown.job?msg("译图"):msg("原图")}`} data-result-job={shown.job?.id??'original'}/>:!failure?<div className="nc-image-placeholder"><span className="spinner"/>{msg("正在读取这一页")}</div>:null}{failure&&<div className={`nc-image-failure ${shown?'over-image':''}`} role="status"><Icon name="image"/><b>{shown?msg("新图片暂未显示"):msg("图片暂不可用")}</b><p>{failure}</p><button className="button secondary" onClick={()=>{if(needsPermission)void requestImagePermissions(needsPermission).then(()=>setRetry(v=>v+1)).catch(e=>setFailure(e.message));else setRetry(v=>v+1);}}>{needsPermission?msg('授权并继续'):msg('重试')}</button><button className="button secondary" onClick={onImport}>{msg("重新导入")}</button>{sourceUrl&&<a href={sourceUrl} target="_blank" rel="noopener noreferrer">{msg("返回来源网页")}</a>}</div>}</>;
}
