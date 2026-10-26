import {msg} from '../i18n/runtime';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Icon} from '../icons';
import type {ProcessingImage} from '../image-processing/contracts';
import {EnhancementStatus} from './EnhancementStatus';
import type {Job} from '../types';
import {prepareReaderImage,setReaderImagePriority} from './prepare-image';
import {createReaderImageURL,releaseReaderImageURL} from './image-urls';
import type {ImageLoadState} from './presentation';
import type {PagePreviewTarget} from '../comics/application/image-access';
import './image-notices.css';

/** Pixel presentation owns URLs and decoding; its caller owns source access and persistence. */
export type ShownImage={scope:string;key:string;job?:Job};
type PreparedImage=ShownImage&{id:string;url:string};
type ImageRequest={id:string;scope:string;key:string;job?:Job;blob?:Blob;attempt:number;acquire:ReaderPictureProps['acquire'];controller:AbortController;url:string;release?:()=>void;phase:'reading'|'decoding'|'displaying';image?:PreparedImage;error?:string};
export type ReaderPictureProps={acquire:(key:string,signal:AbortSignal,preview?:PagePreviewTarget)=>Promise<{blob:Blob;release():void}>;priority?:'current'|'prefetch';scope:string;blobKey?:string;originalKey?:string;job?:Job;alt:string;onShown?:(image:ShownImage|undefined)=>void;onLoadState?:(state:ImageLoadState|undefined)=>void;onImport:()=>void;onReload?:()=>void;reloadBusy?:boolean;error?:string;sourceUrl?:string;enhancement?:ProcessingImage};
export function ReaderPicture({acquire,priority='current',scope,blobKey,originalKey=blobKey,job,alt,onShown,onLoadState,onImport,onReload,reloadBusy=false,error,sourceUrl,enhancement}:ReaderPictureProps){
  const [loaded,setLoaded]=useState<PreparedImage>();const [displayError,setDisplayError]=useState('');const [retry,setRetry]=useState(0);const [revision,setRevision]=useState(0);const urls=useRef(new Set<string>());
  const displayed=useRef(loaded);displayed.current=loaded;
  // At most one original, one selected result and one ready enhancement share this loader.
  const requests=useRef(new Map<string,ImageRequest>());
  const canvas=useRef<HTMLCanvasElement>(null),previewOwner=useRef<ImageRequest|undefined>(undefined),visible=useRef(false);
  const [previewId,setPreviewId]=useState<string>();
  useEffect(()=>{
    if(!canvas.current?.parentElement||typeof IntersectionObserver==='undefined')return;
    const observer=new IntersectionObserver(([entry])=>{visible.current=entry.isIntersecting;});
    observer.observe(canvas.current.parentElement);return()=>observer.disconnect();
  },[]);
  const decodePriority=useRef(priority);decodePriority.current=priority;
  useEffect(()=>{for(const request of requests.current.values())if(request.url)setReaderImagePriority(request.url,priority);},[priority]);
  const [dismissed,setDismissed]=useState<string>();const retryButton=useRef<HTMLButtonElement>(null);
  const callback=useRef(onShown);callback.current=onShown;
  const loadCallback=useRef(onLoadState);loadCallback.current=onLoadState;
  const targetId=blobKey?JSON.stringify([scope,blobKey,job?.id]):undefined;
  const originalId=originalKey===blobKey?targetId:originalKey?JSON.stringify([scope,originalKey,undefined]):undefined;
  const enhancedId=targetId&&enhancement?.blob?JSON.stringify([targetId,enhancement.identity]):undefined;
  const reloadAction=useRef({onReload,reloadBusy});reloadAction.current={onReload,reloadBusy};
  const reload=useCallback(()=>{if(reloadAction.current.reloadBusy)return;if(!blobKey&&reloadAction.current.onReload)reloadAction.current.onReload();else setRetry(value=>value+1);},[blobKey]);
  const shown=loaded?.scope===scope?loaded:undefined;
  const rank=(id:string)=>id===enhancedId?2:id===targetId?1:id===originalId?0:-1;
  const currentRequests=[...requests.current.values()].filter(request=>request.scope===scope&&rank(request.id)>=0&&(request.id!==enhancedId||request.blob===enhancement?.blob));
  const pending=currentRequests.filter(request=>request.image&&request.image.url!==shown?.url&&rank(request.id)>=(shown?rank(shown.id):-1)).sort((a,b)=>rank(b.id)-rank(a.id))[0]?.image;
  const candidate=useRef(pending);candidate.current=pending;
  const targetRequest=currentRequests.find(request=>request.id===targetId);
  const enhancedRequest=currentRequests.find(request=>request.id===enhancedId);
  const originalRequest=currentRequests.find(request=>request.id===originalId);
  const hasPreview=!shown&&currentRequests.some(request=>request.id===previewId&&!request.error);
  const failure=displayError||enhancedRequest?.error||targetRequest?.error||(!shown&&originalRequest?.error)||(!blobKey?(error||msg("本地图片已清理，请重新导入原图。")):'');
  // The foreground lease must exist before prefetch relinquishes its copy of this original.
  const originalSettled=!originalKey||originalKey===blobKey&&!!job||!!originalRequest&&(!!originalRequest.release||!!originalRequest.error);
  const revoke=(url:string)=>{if(url&&urls.current.delete(url))releaseReaderImageURL(url);};
  const active=(request:ImageRequest)=>requests.current.get(request.id)===request&&!request.controller.signal.aborted;
  const clearPreview=(request?:ImageRequest)=>{if(request&&previewOwner.current!==request)return;previewOwner.current=undefined;setPreviewId(undefined);if(canvas.current)canvas.current.width=canvas.current.height=1;};
  const retire=(request:ImageRequest)=>{clearPreview(request);requests.current.delete(request.id);request.controller.abort();request.release?.();request.release=undefined;if(displayed.current?.url!==request.url)revoke(request.url);};
  useLayoutEffect(()=>{if(shown)clearPreview();},[shown]);
  const failureSignature=JSON.stringify([scope,blobKey,retry,failure]);
  useEffect(()=>{setLoaded(current=>current?.scope===scope?current:undefined);setDisplayError('');setDismissed(undefined);},[scope,targetId,enhancedId,retry]);
  useEffect(()=>{if(dismissed===failureSignature)retryButton.current?.focus({preventScroll:true});},[dismissed,failureSignature]);
  useEffect(()=>{
    const desired=new Map<string,{key:string;job?:Job;blob?:Blob}>();
    const enhancedFailed=!!enhancedId&&!!requests.current.get(enhancedId)?.error;
    const enhancedShown=!!enhancedId&&shown?.id===enhancedId;
    // An already displayed result needs no fallback. An in-flight original survives target changes.
    if(originalId&&originalKey&&originalId!==targetId&&(!shown||shown.id===originalId||!shown.job&&shown.key!==originalKey)&&(!enhancedId||enhancedFailed||requests.current.has(originalId)))desired.set(originalId,{key:originalKey});
    if(targetId&&blobKey&&(!enhancedId||enhancedFailed||!enhancedShown&&requests.current.has(targetId)))desired.set(targetId,{key:blobKey,job});
    if(enhancedId&&blobKey)desired.set(enhancedId,{key:blobKey,job,blob:enhancement?.blob});
    let changed=false;
    for(const request of requests.current.values()){
      const next=desired.get(request.id);
      if(!next||request.acquire!==acquire||request.blob!==next.blob||request.error&&request.attempt!==retry){retire(request);changed=true;}
    }
    for(const [id,input] of desired){
      if(requests.current.has(id))continue;
      const request:ImageRequest={id,scope,...input,attempt:retry,acquire,controller:new AbortController(),url:'',phase:'reading'};
      requests.current.set(id,request);changed=true;
      void (async()=>{
        let blob=request.blob;
        if(!blob){
          const preview:PagePreviewTarget|undefined=request.key===originalKey&&!request.job?{
            active:()=>active(request)&&!displayed.current&&!(typeof document!=='undefined'&&document.hidden)&&(decodePriority.current==='current'||visible.current),
            draw(frame){
              if(!active(request)||displayed.current||!canvas.current)return;
              const element=canvas.current,context=element.getContext('2d');if(!context)return;
              if(element.width!==frame.displayWidth||element.height!==frame.displayHeight){element.width=frame.displayWidth;element.height=frame.displayHeight;}
              context.drawImage(frame,0,0);previewOwner.current=request;setPreviewId(request.id);
            },
            clear:()=>clearPreview(request),
          }:undefined;
          const lease=await request.acquire(request.key,request.controller.signal,preview);
          if(!active(request)){lease.release();return;}
          request.release=lease.release;blob=lease.blob;
        }
        request.controller.signal.throwIfAborted();
        request.url=createReaderImageURL(blob);urls.current.add(request.url);request.phase='decoding';setRevision(value=>value+1);
        await prepareReaderImage(request.url,request.controller.signal,decodePriority.current);
        if(!active(request)){revoke(request.url);return;}
        request.image={id,scope,key:request.key,job:request.job,url:request.url};request.phase='displaying';setRevision(value=>value+1);
      })().catch(reason=>{if(active(request)){clearPreview(request);request.error=(reason as Error).message;request.image=undefined;setRevision(value=>value+1);}revoke(request.url);request.url='';});
    }
    if(changed)setRevision(value=>value+1);
  },[scope,originalKey,targetId,enhancedId,enhancement?.blob,retry,acquire,shown,revision]);
  useEffect(()=>{for(const url of urls.current)if(url!==loaded?.url&&![...requests.current.values()].some(request=>request.url===url))revoke(url);},[loaded,revision]);
  useEffect(()=>()=>{for(const request of requests.current.values())retire(request);for(const url of urls.current)releaseReaderImageURL(url);urls.current.clear();},[]);
  const isCurrent=(image:PreparedImage)=>candidate.current===image&&requests.current.get(image.id)?.image===image&&!requests.current.get(image.id)?.controller.signal.aborted;
  function confirm(image:PreparedImage,element:HTMLImageElement){if(isCurrent(image)){if(!element.naturalWidth||!element.naturalHeight){fail(image);return;}displayed.current=image;setLoaded(image);setDisplayError('');setDismissed(undefined);}}
  function fail(image:PreparedImage){
    if(isCurrent(image))candidate.current=undefined;
    else if(displayed.current===image){displayed.current=undefined;setLoaded(undefined);}
    else return;
    const message=msg('{0} 无法解码，请检查图片是否损坏。',{'0':alt}),request=requests.current.get(image.id);
    if(request){clearPreview(request);request.image=undefined;request.error=message;request.url='';setRevision(value=>value+1);}else setDisplayError(message);
    revoke(image.url);
  }
  // Commit the identity only after the actual display element loads; keep the old image until then.
  useLayoutEffect(()=>{callback.current?.(shown);return()=>callback.current?.(undefined);},[shown?.scope,shown?.key,shown?.job?.id]);
  // Cached bytes are not a displayed result. Report preparation through the actual DOM load.
  const phase=failure?'error':shown&&shown.key===blobKey&&shown.job?.id===job?.id?'ready':targetRequest?.phase??enhancedRequest?.phase??'reading';
  useLayoutEffect(()=>{loadCallback.current?.({scope,key:blobKey,phase,error:failure||undefined,retry:reload,originalSettled});return()=>loadCallback.current?.(undefined);},[scope,blobKey,phase,failure,reload,originalSettled]);
  return <><canvas ref={canvas} width={1} height={1} className="nc-page-preview" style={{display:hasPreview?undefined:"none"}} role="img" aria-label={`${alt} · ${msg("正在读取这一页")}`} aria-hidden={!hasPreview||undefined}/>{hasPreview&&!failure&&<span className="nc-image-preview-status" role="status"><span className="spinner"/>{msg("正在读取这一页")}</span>}<EnhancementStatus state={enhancement?.state} onRetry={()=>enhancement?.retry()}/>{[shown,pending].map(image=>image&&<img key={image.url} decoding="async" className={image===pending?'nc-page-image-pending':'nc-page-image'} src={image.url} alt={image===pending?'':`${alt}${image.job?msg("译图"):msg("原图")}`} aria-hidden={image===pending||undefined} style={image===pending?{position:'absolute',visibility:'hidden',pointerEvents:'none'}:undefined} data-result-job={image.job?.id??'original'} onLoad={event=>confirm(image,event.currentTarget)} onError={()=>fail(image)}/>)}{!shown&&!hasPreview&&!failure?<div className="nc-image-placeholder"><span className="spinner"/>{msg("正在读取这一页")}</div>:null}{failure&&(shown&&dismissed===failureSignature?<button ref={retryButton} className="nc-image-failure-retry" title={failure} aria-label={msg('重试')} disabled={reloadBusy} onClick={e=>{e.stopPropagation();reload();}}><Icon name="refresh" size={16}/></button>:<div className={`nc-image-failure ${shown||hasPreview?'over-image':''}`} role="status">{shown&&<button className="nc-image-failure-dismiss" aria-label={msg('关闭错误提示')} onClick={e=>{e.stopPropagation();setDismissed(failureSignature);}}><Icon name="close" size={16}/></button>}<Icon name="image"/><b>{shown?msg("新图片暂未显示"):msg("图片暂不可用")}</b><p>{failure}</p><div className="nc-image-failure-actions">{blobKey&&<button className="button secondary" disabled={reloadBusy} onClick={reload}>{msg('重试')}</button>}{onReload&&<button className="button secondary" disabled={reloadBusy} onClick={onReload}><Icon name="refresh" size={16}/>{msg('重新载入')}</button>}{!sourceUrl&&<button className="button secondary" onClick={onImport}>{msg("重新导入")}</button>}{sourceUrl&&<a className="button secondary" href={sourceUrl} target="_blank" rel="noopener noreferrer">{msg("返回来源网页")}</a>}</div></div>)}</>;
}
