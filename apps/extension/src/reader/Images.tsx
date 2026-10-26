import {useCallback,useEffect,useRef,useState} from 'react';
import {Icon} from '../icons';
import {acquireImage,promoteImage,readThumbnail} from '../comics/application/image-access';
import './image-notices.css';

export function Thumbnail({blobKey,alt='',className='',retryKey=0,onError}:{blobKey?:string;alt?:string;className?:string;retryKey?:number;onError?:(error:unknown)=>void}){
  const ref=useRef<HTMLSpanElement>(null);const [visible,setVisible]=useState(false);const [loaded,setLoaded]=useState<{key:string;url:string}>();
  const failure=useRef(onError);failure.current=onError;
  useEffect(()=>{if(!ref.current)return;const observer=new IntersectionObserver(([entry])=>{if(entry.isIntersecting){setVisible(true);observer.disconnect();}},{rootMargin:'160px'});observer.observe(ref.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(!visible||!blobKey)return;let alive=true;let url='';const controller=new AbortController();void readThumbnail(blobKey,controller.signal).then(blob=>{if(alive&&blob){url=URL.createObjectURL(blob);setLoaded({key:blobKey,url});}}).catch(error=>{if(alive)failure.current?.(error);});return()=>{alive=false;controller.abort();if(url)URL.revokeObjectURL(url);};},[blobKey,visible,retryKey]);
  return <span className={`nc-thumbnail ${className}`} ref={ref}>{loaded&&loaded.key===blobKey?<img src={loaded.url} alt={alt}/>:<Icon name="book" size={28}/>}</span>;
}
export {type ShownImage} from './ReaderPicture';
import {ReaderPicture,type ReaderPictureProps} from './ReaderPicture';
export type BlobPictureProps=Omit<ReaderPictureProps,'acquire'>;
export function BlobPicture({priority='current',...props}:BlobPictureProps){
  const current=useRef(priority);current.current=priority;
  const acquire=useCallback(async(key:string,signal:AbortSignal)=>{
    // Let the current page claim a source slot before earlier DOM neighbors from the same commit.
    if(current.current==='prefetch')await Promise.resolve();
    return acquireImage(key,signal,current.current);
  },[]);
  useEffect(()=>{
    if(priority==='current')for(const key of new Set([props.blobKey,props.originalKey]))if(key)promoteImage(key);
  },[priority,props.blobKey,props.originalKey]);
  return <ReaderPicture {...props} priority={priority} acquire={acquire}/>;
}
