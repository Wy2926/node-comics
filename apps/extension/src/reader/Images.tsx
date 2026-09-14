import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Icon} from '../icons';
import {getBlob} from '../library/store';
import {RequestPool} from '../concurrency';
import type {Job} from '../types';

// Small in-memory thumbnails only; full-sized originals stay in the bounded reader window.
const thumbnails=new Map<string,Blob>();
const thumbnailWork=new Map<string,Promise<Blob|undefined>>();
const thumbnailPool=new RequestPool(2);
async function thumbnail(key:string){
  const cached=thumbnails.get(key);if(cached){thumbnails.delete(key);thumbnails.set(key,cached);return cached;}
  const existing=thumbnailWork.get(key);if(existing)return existing;
  const work=thumbnailPool.run(async()=>{
    const blob=await getBlob(key);if(!blob)return;
    const bitmap=await createImageBitmap(blob,{resizeWidth:240,resizeQuality:'medium'});
    try{const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);canvas.getContext('2d')!.drawImage(bitmap,0,0);const compact=await canvas.convertToBlob({type:'image/webp',quality:.75});thumbnails.set(key,compact);while(thumbnails.size>64)thumbnails.delete(thumbnails.keys().next().value!);return compact;}finally{bitmap.close();}
  }).finally(()=>thumbnailWork.delete(key));thumbnailWork.set(key,work);return work;
}
export function Thumbnail({blobKey,alt='',className=''}:{blobKey?:string;alt?:string;className?:string}){
  const ref=useRef<HTMLSpanElement>(null);const [visible,setVisible]=useState(false);const [loaded,setLoaded]=useState<{key:string;url:string}>();
  useEffect(()=>{if(!ref.current)return;const observer=new IntersectionObserver(([entry])=>{if(entry.isIntersecting){setVisible(true);observer.disconnect();}},{rootMargin:'160px'});observer.observe(ref.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(!visible||!blobKey)return;let alive=true;let url='';void thumbnail(blobKey).then(blob=>{if(alive&&blob){url=URL.createObjectURL(blob);setLoaded({key:blobKey,url});}}).catch(()=>{});return()=>{alive=false;if(url)URL.revokeObjectURL(url);};},[blobKey,visible]);
  return <span className={`nc-thumbnail ${className}`} ref={ref}>{loaded&&loaded.key===blobKey?<img src={loaded.url} alt={alt}/>:<Icon name="book" size={28}/>}</span>;
}
export type ShownImage={scope:string;key:string;job?:Job};
export function BlobPicture({scope,blobKey,job,alt,onShown,onImport,error,sourceUrl}:{scope:string;blobKey?:string;job?:Job;alt:string;onShown?:(image:ShownImage|undefined)=>void;onImport:()=>void;error?:string;sourceUrl?:string}){
  const [loaded,setLoaded]=useState<(ShownImage&{url:string})>();const [failure,setFailure]=useState('');const urls=useRef(new Set<string>());
  const callback=useRef(onShown);callback.current=onShown;
  const shown=loaded?.scope===scope?loaded:undefined;
  useEffect(()=>{let active=true;setFailure('');if(!blobKey){setLoaded(undefined);setFailure(error||'本地图片已清理，请重新导入原图。');return;}
    let url='';void getBlob(blobKey).then(async blob=>{if(!active)return;if(!blob)throw Error('本地图片已清理，请恢复图片后重试。');url=URL.createObjectURL(blob);urls.current.add(url);const image=new Image();image.src=url;await image.decode();if(active)setLoaded({scope,key:blobKey,job,url});else{URL.revokeObjectURL(url);urls.current.delete(url);}}).catch(e=>{if(active)setFailure((e as Error).message);if(url){URL.revokeObjectURL(url);urls.current.delete(url);}});
    return()=>{active=false;};
  },[scope,blobKey]);
  useEffect(()=>{for(const url of urls.current)if(url!==loaded?.url){URL.revokeObjectURL(url);urls.current.delete(url);}},[loaded]);
  useEffect(()=>()=>{for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();},[]);
  // The identity follows the decoded image actually on screen, never a pending network result.
  useLayoutEffect(()=>{callback.current?.(shown);return()=>callback.current?.(undefined);},[shown?.scope,shown?.key]);
  return <>{shown?<img className="nc-page-image" src={shown.url} alt={`${alt}${shown.job?'译图':'原图'}`} data-result-job={shown.job?.id??'original'}/>:!failure?<div className="nc-image-placeholder"><span className="spinner"/>正在读取这一页</div>:null}{failure&&<div className={`nc-image-failure ${shown?'over-image':''}`} role="status"><Icon name="image"/><b>{shown?'新图片暂未显示':'图片暂不可用'}</b><p>{failure}</p><button className="button secondary" onClick={onImport}>重新导入</button>{sourceUrl&&<a href={sourceUrl} target="_blank" rel="noopener noreferrer">返回来源网页</a>}</div>}</>;
}
