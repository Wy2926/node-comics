import {msg} from '../i18n/runtime';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {ReadingCopy,Settings} from '../types';
import {anchorFor} from './model';
import {completePageList} from '../comics/application/library-service';
import {chapterWindow,pageAtHeight,type ChapterWindow} from './virtual-window';

export const pageKey=(copy:ReadingCopy,pageId:string)=>`${copy.id}:${pageId}`;
export const completeManifest=completePageList;
type Props={copy:ReadingCopy;sequence:ReadingCopy[];layout:Settings['layout'];update:(copy:ReadingCopy)=>void;onActiveCopy:(id:string)=>void;onLoadCopy:(id:string)=>void;onMarkRead:(id:string)=>Promise<void>;notify:(message:string)=>void};
/** Three metadata chapters, with viewport position independent of mounted page DOM. */
export function useChapterStream({copy,sequence,layout,update,onActiveCopy,onLoadCopy,onMarkRead,notify}:Props){
 const initialIndex=Math.max(0,copy.pages.findIndex(page=>page.id===copy.pageId));
 const [active,setActive]=useState({copyId:copy.id,index:initialIndex});
 const index=active.copyId===copy.id?Math.min(active.index,Math.max(0,copy.pages.length-1)):initialIndex;
 const stream=useMemo(()=>layout==='single'?[copy]:chapterWindow(sequence,copy),[layout,sequence,copy]);
 const viewport=useRef<HTMLDivElement>(null),cells=useRef(new Map<string,HTMLDivElement>()),ends=useRef(new Map<string,HTMLDivElement>()),stacks=useRef(new Map<string,HTMLDivElement>());
 const geometry=useRef(new Map<string,ChapterWindow>());
 const copyRef=useRef(copy),indexRef=useRef(index);copyRef.current=copy;indexRef.current=index;
 const anchor=useRef({copyId:copy.id,pageId:copy.pages[initialIndex]?.id??copy.pageId,relativeOffset:copy.relativeOffset});
 const suppressScroll=useRef(false),lastScrollTop=useRef(0),saveTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),restoreFrame=useRef<number|undefined>(undefined);
 const requested=useRef(new Set<string>()),read=useRef(new Set<string>());
 const navigationReason=useRef<'scroll'|'direct'>('direct');
 const nextOf=(chapter:ReadingCopy)=>{const at=sequence.findIndex(item=>item.id===chapter.id);return at<0?undefined:sequence[at+1];};
 const next=completeManifest(copy)?nextOf(copy):undefined;
 const elementTop=(element:HTMLElement)=>{const v=viewport.current!;return element.getBoundingClientRect().top-v.getBoundingClientRect().top+v.scrollTop-v.clientTop;};
 function position(chapter:ReadingCopy,n:number){
  const metrics=geometry.current.get(chapter.id),stack=stacks.current.get(chapter.id);
  if(!metrics||!stack||!viewport.current||n<0||n>=chapter.pages.length)return;
  return {top:elementTop(stack)+(layout==='single'?0:metrics.offsets[n]),height:metrics.offsets[n+1]-metrics.offsets[n]};
 }
 function preserve(){
  const chapter=copyRef.current,n=indexRef.current,page=chapter.pages[n],p=position(chapter,n),v=viewport.current;
  if(page&&p&&v)anchor.current={copyId:chapter.id,pageId:page.id,relativeOffset:anchorFor(p.top,p.height,v.scrollTop)};
 }
 function persist(){
  clearTimeout(saveTimer.current);const chapter=copyRef.current;
  if(anchor.current.copyId!==chapter.id||!chapter.pages.some(page=>page.id===anchor.current.pageId))return;
  const {pageId,relativeOffset}=anchor.current;update({...chapter,pageId,relativeOffset,lastReadAt:Date.now(),updatedAt:Date.now()});
 }
 function restore(){
  const chapter=copyRef.current,v=viewport.current,n=chapter.pages.findIndex(page=>page.id===anchor.current.pageId),p=position(chapter,n);
  if(!v||!p||anchor.current.copyId!==chapter.id)return;
  const desired=Math.max(0,Math.min(v.scrollHeight-v.clientHeight,p.top+p.height*anchor.current.relativeOffset));
  if(Math.abs(v.scrollTop-desired)<.5)return;
  suppressScroll.current=true;v.scrollTop=desired;lastScrollTop.current=v.scrollTop;
  if(restoreFrame.current!==undefined)cancelAnimationFrame(restoreFrame.current);
  restoreFrame.current=requestAnimationFrame(()=>{suppressScroll.current=false;});
 }
 function markRead(chapter:ReadingCopy){
  if(!completeManifest(chapter))return;const key=`${chapter.id}:${chapter.manifestRevision}`;
  if(read.current.has(key))return;read.current.add(key);
  void onMarkRead(chapter.id).catch(error=>{read.current.delete(key);notify(msg('已读状态未保存：{0}',{'0':(error as Error).message}));});
 }
 function activate(chapter:ReadingCopy,n:number){
  if(chapter.id!==copyRef.current.id){persist();copyRef.current=chapter;onActiveCopy(chapter.id);}
  indexRef.current=n;setActive(previous=>previous.copyId===chapter.id&&previous.index===n?previous:{copyId:chapter.id,index:n});
 }
 function scroll(){
  const v=viewport.current;if(!v||suppressScroll.current)return;
  navigationReason.current='scroll';const previous=lastScrollTop.current,forward=v.scrollTop>previous;lastScrollTop.current=v.scrollTop;
  const line=v.scrollTop+Math.min(80,v.clientHeight*.1);
  if(layout==='continuous'){
   let selected:{chapter:ReadingCopy;index:number}|undefined;
   for(const chapter of stream){const stack=stacks.current.get(chapter.id),metrics=geometry.current.get(chapter.id);if(!stack||!metrics||!chapter.pages.length)continue;const top=elementTop(stack);if(top<=line||!selected)selected={chapter,index:pageAtHeight(metrics.offsets,line-top)};}
   if(selected)activate(selected.chapter,selected.index);
  }
  preserve();clearTimeout(saveTimer.current);saveTimer.current=setTimeout(persist,350);
  if(forward){
   for(const chapter of stream){const end=ends.current.get(chapter.id);if(!end)continue;const top=elementTop(end),crossed=top>previous&&top+end.offsetHeight<=v.scrollTop+v.clientHeight+1;if(crossed&&(layout==='continuous'||indexRef.current===chapter.pages.length-1))markRead(chapter);}
  }
 }
 function jump(n:number){
  navigationReason.current='direct';const chapter=copyRef.current;if(!Number.isFinite(n)||!chapter.pages.length)return;
  if(n>=chapter.pages.length&&completeManifest(chapter)){
   const destination=nextOf(chapter);
   if(destination){markRead(chapter);persist();anchor.current={copyId:destination.id,pageId:destination.pages[0]?.id??'',relativeOffset:0};activate(destination,0);onLoadCopy(destination.id);return;}
  }
  const target=Math.max(0,Math.min(chapter.pages.length-1,Math.trunc(n)));
  anchor.current={copyId:chapter.id,pageId:chapter.pages[target].id,relativeOffset:0};indexRef.current=target;setActive({copyId:chapter.id,index:target});persist();
 }
 // New geometry is already committed. Restore by stable page identity even when its old DOM was evicted.
 useLayoutEffect(()=>{
  if(anchor.current.copyId!==copy.id){anchor.current={copyId:copy.id,pageId:copy.pages[initialIndex]?.id??copy.pageId,relativeOffset:copy.relativeOffset};setActive({copyId:copy.id,index:initialIndex});}
  if(!anchor.current.pageId&&copy.pages.length){anchor.current.pageId=copy.pages[0].id;setActive({copyId:copy.id,index:0});}
  restore();
 });
 useEffect(()=>{
  for(const chapter of stream){if(chapter.pages.length||requested.current.has(chapter.id))continue;requested.current.add(chapter.id);onLoadCopy(chapter.id);}
  const keep=new Set(stream.map(chapter=>chapter.id));for(const id of requested.current)if(!keep.has(id))requested.current.delete(id);
 },[copy.id,sequence,layout]);
 useEffect(()=>()=>{clearTimeout(saveTimer.current);if(restoreFrame.current!==undefined)cancelAnimationFrame(restoreFrame.current);},[]);
 return {index,indexRef,copyRef,anchor,suppressScroll,viewport,cells,ends,stacks,geometry,stream,next,nextOf,preserve,persist,restore,scroll,jump,navigationReason};
}
