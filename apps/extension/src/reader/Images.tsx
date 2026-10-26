import {useCallback,useEffect,useRef,useState} from 'react';
import {Icon} from '../icons';
import {acquireImage,promoteImage,readThumbnail,type PagePreviewTarget} from '../comics/application/image-access';
import './image-notices.css';

type ThumbnailKeyResolver=(signal:AbortSignal)=>Promise<string|undefined>;
export function Thumbnail({blobKey,resolveKey,alt='',className='',retryKey=0,onError}:{blobKey?:string;resolveKey?:ThumbnailKeyResolver;alt?:string;className?:string;retryKey?:number;onError?:(error:unknown)=>void}){
  const ref=useRef<HTMLSpanElement>(null);const [visible,setVisible]=useState(false);const [loaded,setLoaded]=useState<{source:string|ThumbnailKeyResolver;url:string}>();
  const failure=useRef(onError);failure.current=onError;
  useEffect(()=>{if(!ref.current)return;const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting),{rootMargin:'160px'});observer.observe(ref.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    setLoaded(undefined);
    const source=blobKey??resolveKey;if(!visible||!source)return;
    let alive=true,url='';const controller=new AbortController(),{signal}=controller;
    void (async()=>{
      const key=typeof source==='string'?source:await source(signal);signal.throwIfAborted();if(!key)return;
      const blob=await readThumbnail(key,signal);
      if(alive){url=URL.createObjectURL(blob);setLoaded({source,url});}
    })().catch(error=>{if(alive)failure.current?.(error);});
    return()=>{alive=false;controller.abort();if(url)URL.revokeObjectURL(url);};
  },[blobKey,resolveKey,visible,retryKey]);
  return <span className={`nc-thumbnail ${className}`} data-thumbnail-visible={visible||undefined} ref={ref}>{visible&&loaded&&loaded.source===(blobKey??resolveKey)?<img src={loaded.url} alt={alt}/>:<Icon name="book" size={28}/>}</span>;
}
export {type ShownImage} from './ReaderPicture';
import {ReaderPicture,type ReaderPictureProps} from './ReaderPicture';
export type BlobPictureProps=Omit<ReaderPictureProps,'acquire'>;
export function BlobPicture({priority='current',...props}:BlobPictureProps){
  const current=useRef(priority);current.current=priority;
  const acquire=useCallback(async(key:string,signal:AbortSignal,preview?:PagePreviewTarget)=>{
    // Let the current page claim a source slot before earlier DOM neighbors from the same commit.
    if(current.current==='prefetch')await Promise.resolve();
    return acquireImage(key,signal,current.current,preview);
  },[]);
  useEffect(()=>{
    if(priority==='current')for(const key of new Set([props.blobKey,props.originalKey]))if(key)promoteImage(key);
  },[priority,props.blobKey,props.originalKey]);
  return <ReaderPicture {...props} priority={priority} acquire={acquire}/>;
}
