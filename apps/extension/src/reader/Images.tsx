import {msg} from '../i18n/runtime';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Icon} from '../icons';
import {acquireImage,readThumbnail,processingInput} from '../comics/application/image-access';
import {enhanceImage} from '../image-processing/runtime';
import type {ProcessingProfile,ProcessingState} from '../image-processing/contracts';
import {EnhancementStatus} from './EnhancementStatus';
import type {Job} from '../types';
import {prepareReaderImage} from './prepare-image';
import type {ImageLoadState} from './presentation';
import './image-notices.css';

export function Thumbnail({blobKey,alt='',className='',retryKey=0,onError}:{blobKey?:string;alt?:string;className?:string;retryKey?:number;onError?:(error:unknown)=>void}){
  const ref=useRef<HTMLSpanElement>(null);const [visible,setVisible]=useState(false);const [loaded,setLoaded]=useState<{key:string;url:string}>();
  const failure=useRef(onError);failure.current=onError;
  useEffect(()=>{if(!ref.current)return;const observer=new IntersectionObserver(([entry])=>{if(entry.isIntersecting){setVisible(true);observer.disconnect();}},{rootMargin:'160px'});observer.observe(ref.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(!visible||!blobKey)return;let alive=true;let url='';const controller=new AbortController();void readThumbnail(blobKey,controller.signal).then(blob=>{if(alive&&blob){url=URL.createObjectURL(blob);setLoaded({key:blobKey,url});}}).catch(error=>{if(alive)failure.current?.(error);});return()=>{alive=false;controller.abort();if(url)URL.revokeObjectURL(url);};},[blobKey,visible,retryKey]);
  return <span className={`nc-thumbnail ${className}`} ref={ref}>{loaded&&loaded.key===blobKey?<img src={loaded.url} alt={alt}/>:<Icon name="book" size={28}/>}</span>;
}
export type ShownImage={scope:string;key:string;job?:Job};
type PreparedImage=ShownImage&{url:string;attempt:number};
export type BlobPictureProps={scope:string;blobKey?:string;job?:Job;alt:string;onShown?:(image:ShownImage|undefined)=>void;onLoadState?:(state:ImageLoadState|undefined)=>void;onImport:()=>void;onReload?:()=>void;reloadBusy?:boolean;error?:string;sourceUrl?:string;profile?:ProcessingProfile;owner?:string;sourceKey?:string;eligible?:boolean;defer?:boolean;revision?:string};
export function BlobPicture({scope,blobKey,job,alt,onShown,onLoadState,onImport,onReload,reloadBusy=false,error,sourceUrl,profile,owner,sourceKey,eligible=false,defer=false,revision}:BlobPictureProps){
  const [loaded,setLoaded]=useState<PreparedImage>();const [candidate,setCandidate]=useState<PreparedImage>();const [failure,setFailure]=useState('');const [retry,setRetry]=useState(0);const urls=useRef(new Set<string>());
  const displayed=useRef(loaded);displayed.current=loaded;
  const request=useRef<{url:string;signal:AbortSignal}|undefined>(undefined);
  const [dismissed,setDismissed]=useState<string>();const retryButton=useRef<HTMLButtonElement>(null);
  const callback=useRef(onShown);callback.current=onShown;
  const loadCallback=useRef(onLoadState);loadCallback.current=onLoadState;
  const identity=JSON.stringify([scope,blobKey,sourceKey,owner,profile?.id,profile?.revision,revision]);
  const [enhancement,setEnhancement]=useState<{identity:string;state:ProcessingState}>();
  const [attempt,setAttempt]=useState(0),manual=useRef<string|undefined>(undefined);
  const reloadAction=useRef({onReload,reloadBusy});reloadAction.current={onReload,reloadBusy};
  const reload=useCallback(()=>{if(reloadAction.current.reloadBusy)return;if(!blobKey&&reloadAction.current.onReload)reloadAction.current.onReload();else setRetry(value=>value+1);},[blobKey]);
  const missingError=blobKey?undefined:error;
  const [preparing,setPreparing]=useState<'reading'|'decoding'|'displaying'>('reading');
  const shown=loaded?.scope===scope?loaded:undefined;
  const pending=candidate?.scope===scope&&candidate.key===blobKey&&candidate.attempt===retry?candidate:undefined;
  const revoke=(url:string)=>{if(url&&urls.current.delete(url))URL.revokeObjectURL(url);};
  const failureSignature=JSON.stringify([scope,blobKey,retry,failure]);
  useEffect(()=>{if(dismissed===failureSignature)retryButton.current?.focus({preventScroll:true});},[dismissed,failureSignature]);
  useEffect(()=>{let active=true;setFailure('');setDismissed(undefined);setCandidate(undefined);setEnhancement(undefined);setPreparing('reading');if(defer)return;if(!blobKey){setLoaded(undefined);setFailure(missingError||msg("本地图片已清理，请重新导入原图。"));return;}
    const controller=new AbortController(),loading={url:'',signal:controller.signal};request.current=loading;let release:(()=>void)|undefined;
    const show=async(blob:Blob)=>{
      controller.signal.throwIfAborted();
      loading.url=URL.createObjectURL(blob);urls.current.add(loading.url);
      setPreparing('decoding');
      await prepareReaderImage(loading.url,controller.signal);
      if(active){setCandidate({scope,key:blobKey,job,url:loading.url,attempt:retry});setPreparing('displaying');}else revoke(loading.url);
    };
    const processing=!!profile&&!!owner&&eligible,explicit=manual.current===identity;manual.current=undefined;
    void (async()=>{
      if(processing){
        try{
          const blob=await enhanceImage(processingInput(blobKey,owner!,sourceKey),profile!,controller.signal,{retry:explicit,onParent:show,
            onState:state=>{if(active&&state.phase!=='ready')setEnhancement({identity,state});}});
          await show(blob);if(active)setEnhancement({identity,state:{phase:'ready'}});
        }catch(e){if(active){setEnhancement({identity,state:{phase:'error',message:(e as Error).message}});if(!loading.url)setFailure((e as Error).message);}}
      }else{
        const lease=await acquireImage(blobKey,controller.signal);release=lease.release;
        // Keep the normal reader lease for the visible window so translation can share it.
        await show(lease.blob);
      }
    })().catch(e=>{if(active)setFailure((e as Error).message);revoke(loading.url);loading.url='';});
    return()=>{active=false;controller.abort();release?.();if(request.current===loading)request.current=undefined;if(displayed.current?.url!==loading.url)revoke(loading.url);};
  },[identity,retry,missingError,eligible,attempt,defer]);
  useEffect(()=>{for(const url of urls.current)if(url!==loaded?.url&&url!==candidate?.url&&url!==request.current?.url)revoke(url);},[loaded,candidate]);
  useEffect(()=>()=>{for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();},[]);
  const isCurrent=(image:PreparedImage)=>pending===image&&request.current?.url===image.url&&!request.current.signal.aborted;
  function confirm(image:PreparedImage,element:HTMLImageElement){if(isCurrent(image)){if(!element.naturalWidth||!element.naturalHeight){fail(image);return;}setLoaded(image);setCandidate(undefined);setFailure('');setDismissed(undefined);}}
  function fail(image:PreparedImage){
    if(isCurrent(image)){setCandidate(undefined);setLoaded(current=>current?.url===image.url?shown:current);}
    else if(shown===image&&displayed.current===image)setLoaded(current=>current?.url===image.url?undefined:current);
    else return;
    if(request.current?.url===image.url)request.current.url='';
    setFailure(msg('{0} 无法解码，请检查图片是否损坏。',{'0':alt}));
  }
  // Commit the identity only after the actual display element loads; keep the old image until then.
  useLayoutEffect(()=>{callback.current?.(shown);return()=>callback.current?.(undefined);},[shown?.scope,shown?.key]);
  // Cached bytes are not a displayed result. Report preparation through the actual DOM load.
  const phase=failure?'error':shown&&shown.key===blobKey&&shown.attempt===retry?'ready':preparing;
  useLayoutEffect(()=>{loadCallback.current?.({scope,key:blobKey,phase,error:failure||undefined,retry:reload});return()=>loadCallback.current?.(undefined);},[scope,blobKey,phase,failure,reload]);
  return <><EnhancementStatus state={profile&&eligible&&enhancement?.identity===identity?enhancement.state:undefined} onRetry={()=>{manual.current=identity;setAttempt(value=>value+1);}}/>{[shown,pending].map(image=>image&&<img key={image.url} className={image===pending?'nc-page-image-pending':'nc-page-image'} src={image.url} alt={image===pending?'':`${alt}${image.job?msg("译图"):msg("原图")}`} aria-hidden={image===pending||undefined} style={image===pending?{position:'absolute',visibility:'hidden',pointerEvents:'none'}:undefined} data-result-job={image.job?.id??'original'} onLoad={event=>confirm(image,event.currentTarget)} onError={()=>fail(image)}/>)}{!shown&&!failure?<div className="nc-image-placeholder"><span className="spinner"/>{msg("正在读取这一页")}</div>:null}{failure&&(shown&&dismissed===failureSignature?<button ref={retryButton} className="nc-image-failure-retry" title={failure} aria-label={msg('重试')} disabled={reloadBusy} onClick={e=>{e.stopPropagation();reload();}}><Icon name="refresh" size={16}/></button>:<div className={`nc-image-failure ${shown?'over-image':''}`} role="status">{shown&&<button className="nc-image-failure-dismiss" aria-label={msg('关闭错误提示')} onClick={e=>{e.stopPropagation();setDismissed(failureSignature);}}><Icon name="close" size={16}/></button>}<Icon name="image"/><b>{shown?msg("新图片暂未显示"):msg("图片暂不可用")}</b><p>{failure}</p><div className="nc-image-failure-actions">{blobKey&&<button className="button secondary" disabled={reloadBusy} onClick={reload}>{msg('重试')}</button>}{onReload&&<button className="button secondary" disabled={reloadBusy} onClick={onReload}><Icon name="refresh" size={16}/>{msg('重新载入')}</button>}{!sourceUrl&&<button className="button secondary" onClick={onImport}>{msg("重新导入")}</button>}{sourceUrl&&<a className="button secondary" href={sourceUrl} target="_blank" rel="noopener noreferrer">{msg("返回来源网页")}</a>}</div></div>)}</>;
}
