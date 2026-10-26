import {msg} from '../i18n/runtime';
import {useEffect,useLayoutEffect,useMemo,useRef,useState,type RefObject} from 'react';
import type {ReadingEntry,Settings} from '../types';
import {scrollAnchorFor,completePageList} from './model';
import {chapterWindow,chapterResources,pageAtHeight,type ChapterWindow} from './virtual-window';
import {ChapterResourceWindow,type ChapterLoadOptions} from './chapter-resources';
import {ReadingProgress,READING_TARGETS} from '../reading-window';

export const pageKey=(copy:ReadingEntry,pageId:string)=>`${copy.id}:${pageId}`;
export const completeManifest=completePageList;
type Props={copy:ReadingEntry;sequence:ReadingEntry[];layout:Settings['layout'];previewEntry?:string;motion?:RefObject<boolean>;update:(copy:ReadingEntry)=>void;onActiveEntry:(id:string)=>void;onLoadEntry:(id:string,options?:ChapterLoadOptions)=>void|Promise<void>;onMarkRead:(id:string)=>Promise<void>;notify:(message:string)=>void};
/** Three metadata chapters, with viewport position independent of mounted page DOM. */
export function useChapterStream({copy,sequence,layout,previewEntry,motion,update,onActiveEntry,onLoadEntry,onMarkRead,notify}:Props){
 const initialIndex=useMemo(()=>Math.max(0,copy.pages.findIndex(page=>page.id===copy.pageId)),[copy.pages,copy.pageId]);
 const [active,setActive]=useState({entryId:copy.id,index:initialIndex});
 const pendingChapterEnd=useRef<string|undefined>(undefined);
 const index=pendingChapterEnd.current===copy.id&&completeManifest(copy)?copy.pages.length-1
  :active.entryId===copy.id?Math.min(active.index,Math.max(0,copy.pages.length-1)):initialIndex;
 const stream=useMemo(()=>layout==='continuous'?chapterWindow(sequence,copy):[copy],[layout,sequence,copy]);
 const viewport=useRef<HTMLDivElement>(null),cells=useRef(new Map<string,HTMLDivElement>()),ends=useRef(new Map<string,HTMLDivElement>()),stacks=useRef(new Map<string,HTMLDivElement>());
 const geometry=useRef(new Map<string,ChapterWindow>());
 const copyRef=useRef(copy),indexRef=useRef(index);copyRef.current=copy;indexRef.current=index;
 const anchor=useRef<{entryId:string;pageId:string;relativeOffset:number;edgeOffset?:number}>({entryId:copy.id,pageId:copy.pages[initialIndex]?.id??copy.pageId,relativeOffset:copy.relativeOffset});
 const restoredGeometry=useRef(''),restorePending=useRef(true);
 const restoredPages=useRef<Pick<ChapterWindow,'copy'|'offsets'>|undefined>(undefined);
 const suppressScroll=useRef(false),lastScrollTop=useRef(0),saveTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),restoreFrame=useRef<number|undefined>(undefined);
 const flushPending=useRef(()=>{});
 const [resources]=useState(()=>new ChapterResourceWindow(copy)),[resourceVersion,setResourceVersion]=useState(0);
 const read=useRef(new Set<string>()),shown=useRef(new Set<string>());
 const deferredShown=useRef<{window:string;pages:Set<string>}|undefined>(undefined);
 const navigationReason=useRef<'scroll'|'direct'>('direct');
 const [readingProgress]=useState(()=>new ReadingProgress());
 const [ahead,setAhead]=useState({key:'',count:READING_TARGETS});
 const nextOf=(chapter:ReadingEntry)=>{const at=sequence.findIndex(item=>item.id===chapter.id);return at<0?undefined:sequence[at+1];};
 const previous=useMemo(()=>sequence[sequence.findIndex(chapter=>chapter.id===copy.id)-1],[sequence,copy.id]);
 const next=completeManifest(copy)?nextOf(copy):undefined;
 const [foreground,setForeground]=useState(()=>!document.hidden);
 const resourceChapters=useMemo(()=>{
  const chapters=foreground?chapterResources(stream,copy,index,next,layout):[copy];
  const preview=foreground&&layout!=='continuous'&&previewEntry?sequence.find(chapter=>chapter.id===previewEntry):undefined;
  return preview&&!chapters.some(chapter=>chapter.id===preview.id)?[...chapters,preview]:chapters;
 },[foreground,stream,copy,index,next,layout,previewEntry,sequence]);
 const elementTop=(element:HTMLElement)=>{const v=viewport.current!;return element.getBoundingClientRect().top-v.getBoundingClientRect().top+v.scrollTop-v.clientTop;};
 function position(chapter:ReadingEntry,n:number):{top:number;height:number;stackTop?:number}|undefined{
  if(!viewport.current||n<0||n>=chapter.pages.length)return;
  if(layout!=='continuous'){
   const cell=cells.current.get(pageKey(chapter,chapter.pages[n].id));
   return cell?{top:elementTop(cell),height:cell.getBoundingClientRect().height}:undefined;
  }
  const metrics=geometry.current.get(chapter.id),stack=stacks.current.get(chapter.id);
  if(metrics&&stack){const stackTop=elementTop(stack);return {top:stackTop+metrics.offsets[n],height:metrics.offsets[n+1]-metrics.offsets[n],stackTop};}
 }
 function preserve(){
  const chapter=copyRef.current,n=indexRef.current,page=chapter.pages[n],p=position(chapter,n),v=viewport.current;
  if(page&&p&&v)anchor.current={entryId:chapter.id,pageId:page.id,...(layout==='double'?{relativeOffset:0}:scrollAnchorFor(p.top,p.height,v.scrollTop))};
 }
 function updateReadingProgress(){
  const chapter=copyRef.current,n=indexRef.current,page=chapter.pages[n],p=position(chapter,n),v=viewport.current;
  if(!page||!p||!v)return;
  const key=pageKey(chapter,page.id),count=readingProgress.update(key,p.top-v.scrollTop,p.height,v.clientHeight);
  setAhead(previous=>previous.key===key&&previous.count===count?previous:{key,count});
 }
 function persist(){
  clearTimeout(saveTimer.current);saveTimer.current=undefined;const chapter=copyRef.current;
  if(anchor.current.entryId!==chapter.id||!chapter.pages.some(page=>page.id===anchor.current.pageId))return;
  const {pageId,relativeOffset}=anchor.current;update({...chapter,pageId,relativeOffset,lastReadAt:Date.now(),updatedAt:Date.now()});
 }
 // Only flush an observed scroll, using the cached anchor even after the DOM detaches.
 // The ref also keeps deferred saves on the latest update callback.
 flushPending.current=()=>{if(saveTimer.current!==undefined)persist();};
 function restore(){
  const chapter=copyRef.current,v=viewport.current,n=chapter.pages.findIndex(page=>page.id===anchor.current.pageId),p=position(chapter,n);
  if(!v||!p||anchor.current.entryId!==chapter.id)return;
  const desired=layout==='double'?0:Math.max(0,Math.min(v.scrollHeight-v.clientHeight,p.top+p.height*anchor.current.relativeOffset+(anchor.current.edgeOffset??0)));
  if(Math.abs(v.scrollTop-desired)<.5)return;
  suppressScroll.current=true;v.scrollTop=desired;lastScrollTop.current=v.scrollTop;
  if(restoreFrame.current!==undefined)cancelAnimationFrame(restoreFrame.current);
  restoreFrame.current=requestAnimationFrame(()=>{suppressScroll.current=false;});
 }
 function markRead(chapter:ReadingEntry){
  if(motion?.current||!completeManifest(chapter))return;const key=`${chapter.id}:${chapter.generation}`;
  if(read.current.has(key))return;
  if(!chapter.pages.every(page=>shown.current.has(`${chapter.contentId??chapter.id}:${page.id}`)))return;
  read.current.add(key);
  void onMarkRead(chapter.id).catch(error=>{read.current.delete(key);notify(msg('已读状态未保存：{0}',{'0':(error as Error).message}));});
 }
 function pageShown(chapter:ReadingEntry,pageId:string){
  if(motion?.current){
   const window=motionWindow(chapter);
   if(deferredShown.current?.window!==window)deferredShown.current={window,pages:new Set()};
   deferredShown.current.pages.add(pageId);return;
  }
  shown.current.add(`${chapter.contentId??chapter.id}:${pageId}`);
  markVisibleEnd(chapter);
 }
 function motionWindow(chapter:ReadingEntry){const range=geometry.current.get(chapter.id);return JSON.stringify([chapter.id,chapter.contentId,chapter.generation,range?.start,range?.end]);}
 // Loaded pixels sliding in from outside the viewport are not reading evidence yet.
 function settleMotion(){
  if(motion?.current)return;
  const chapter=copyRef.current,pending=deferredShown.current;deferredShown.current=undefined;
  if(pending?.window===motionWindow(chapter))for(const pageId of pending.pages){
   if(cells.current.has(pageKey(chapter,pageId)))shown.current.add(`${chapter.contentId??chapter.id}:${pageId}`);
  }
  markVisibleEnd(chapter);
 }
 function markVisibleEnd(chapter:ReadingEntry){
  const v=viewport.current,end=ends.current.get(chapter.id);
  if(v&&end&&elementTop(end)+end.offsetHeight<=v.scrollTop+v.clientHeight+1&&atEnd(chapter))markRead(chapter);
 }
 function atEnd(chapter:ReadingEntry){return layout==='continuous'||chapter.id===copyRef.current.id&&geometry.current.get(chapter.id)?.end===chapter.pages.length;}
 function activate(chapter:ReadingEntry,n:number){
  if(chapter.id!==copyRef.current.id){persist();copyRef.current=chapter;onActiveEntry(chapter.id);}
  indexRef.current=n;setActive(previous=>previous.entryId===chapter.id&&previous.index===n?previous:{entryId:chapter.id,index:n});
 }
 function scroll(){
  const v=viewport.current;if(!v||suppressScroll.current)return;
  pendingChapterEnd.current=undefined;
  navigationReason.current='scroll';const previous=lastScrollTop.current,forward=v.scrollTop>previous;lastScrollTop.current=v.scrollTop;
  const line=v.scrollTop+Math.min(80,v.clientHeight*.1);
  if(layout==='continuous'){
   let selected:{chapter:ReadingEntry;index:number}|undefined;
   for(const chapter of stream){const stack=stacks.current.get(chapter.id),metrics=geometry.current.get(chapter.id);if(!stack||!metrics||!chapter.pages.length)continue;const top=elementTop(stack);if(top<=line||!selected)selected={chapter,index:pageAtHeight(metrics.offsets,line-top)};}
   if(selected)activate(selected.chapter,selected.index);
  }
  preserve();updateReadingProgress();clearTimeout(saveTimer.current);saveTimer.current=setTimeout(()=>flushPending.current(),350);
  if(forward){
   for(const chapter of stream){const end=ends.current.get(chapter.id);if(!end)continue;const top=elementTop(end),crossed=top>previous&&top+end.offsetHeight<=v.scrollTop+v.clientHeight+1;if(crossed&&atEnd(chapter))markRead(chapter);}
  }
 }
 function jump(n:number,relativeOffset=0){
  navigationReason.current='direct';const chapter=copyRef.current;if(!Number.isFinite(n)||!chapter.pages.length)return;
  pendingChapterEnd.current=undefined;
  restorePending.current=true;
  if(n<0||n>=chapter.pages.length&&completeManifest(chapter)){
   const destination=n<0?sequence[sequence.findIndex(item=>item.id===chapter.id)-1]:nextOf(chapter);
   if(destination){
    if(n>=chapter.pages.length)markRead(chapter);
    persist();const target=n<0?Math.max(0,destination.pages.length-1):0;
    // The refreshed manifest may differ from retained descriptors. Resolve its
    // last page once loading finishes, unless another navigation supersedes it.
    if(n<0)pendingChapterEnd.current=destination.id;
    anchor.current={entryId:destination.id,pageId:destination.pages[target]?.id??'',relativeOffset:0};activate(destination,target);return;
   }
  }
  const target=Math.max(0,Math.min(chapter.pages.length-1,Math.trunc(n)));
  anchor.current={entryId:chapter.id,pageId:chapter.pages[target].id,relativeOffset:Math.max(0,Math.min(1,relativeOffset))};indexRef.current=target;setActive({entryId:chapter.id,index:target});persist();
 }
 // New geometry is already committed. Restore by stable page identity even when its old DOM was evicted.
 useLayoutEffect(()=>{
  if(pendingChapterEnd.current!==copy.id)pendingChapterEnd.current=undefined;
  if(pendingChapterEnd.current&&resources.ready(copy)&&completeManifest(copy)){
   pendingChapterEnd.current=undefined;
   const n=copy.pages.length-1;anchor.current={entryId:copy.id,pageId:copy.pages[n].id,relativeOffset:0};
   indexRef.current=n;setActive({entryId:copy.id,index:n});restorePending.current=true;persist();
  }
  if(anchor.current.entryId!==copy.id){anchor.current={entryId:copy.id,pageId:copy.pages[initialIndex]?.id??copy.pageId,relativeOffset:copy.relativeOffset};setActive({entryId:copy.id,index:initialIndex});}
  if(!anchor.current.pageId&&copy.pages.length){anchor.current.pageId=copy.pages[0].id;setActive({entryId:copy.id,index:0});}
  const v=viewport.current,n=copy.pages[indexRef.current]?.id===anchor.current.pageId?indexRef.current:copy.pages.findIndex(page=>page.id===anchor.current.pageId),p=position(copy,n);
  if(!v||!p)return;
  // A canceled entrance also restores the current DOM to x=0. Reconcile only after
  // that commit, so an external jump cannot credit the page it has just discarded.
  if(!motion?.current&&deferredShown.current)settleMotion();
  const metrics=layout==='continuous'?geometry.current.get(copy.id):undefined,previous=restoredPages.current;
  const pageGeometryChanged=!!metrics&&(!previous||previous.copy.id!==copy.id||previous.copy.pages[n]?.id!==copy.pages[n]?.id
   ||previous.offsets[n]!==metrics.offsets[n]||previous.offsets[n+1]!==metrics.offsets[n+1]);
  // A new reading page is not a layout change. Compare its offsets against the
  // last committed geometry so a status commit cannot replay the previous
  // scroll event's anchor while the next native scroll is still pending.
  const signature=JSON.stringify([copy.id,layout,metrics?p.stackTop:[anchor.current.pageId,p.top,p.height],v.clientHeight,v.scrollHeight]);
  // Status/image updates must not replay a stale anchor while a native scroll event is pending.
  if(restorePending.current||pageGeometryChanged||restoredGeometry.current!==signature){restore();markVisibleEnd(copy);}
  restoredPages.current=metrics;
  restoredGeometry.current=signature;restorePending.current=false;
  updateReadingProgress();
 });
 useEffect(()=>{
  const flush=()=>flushPending.current();
  const visibility=()=>{if(document.hidden)flush();setForeground(!document.hidden);};
  document.addEventListener('visibilitychange',visibility);
  window.addEventListener('pagehide',flush);
  return()=>{flush();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',flush);};
 },[]);
 useEffect(()=>{
  resources.prepare(resourceChapters,onLoadEntry,()=>setResourceVersion(value=>value+1),resourceChapters.filter(chapter=>chapter.id!==copy.id).map(chapter=>chapter.id));
 },[resourceChapters,copy.id,onLoadEntry,resources]);
 useEffect(()=>()=>{resources.clear();clearTimeout(saveTimer.current);if(restoreFrame.current!==undefined)cancelAnimationFrame(restoreFrame.current);},[]);
 const readingAhead=ahead.key===pageKey(copy,copy.pages[index]?.id??'')?ahead.count:READING_TARGETS;
 return {index,indexRef,copyRef,anchor,suppressScroll,viewport,cells,ends,stacks,geometry,stream,previous,next,nextOf,preserve,persist,restore,scroll,jump,navigationReason,pageShown,settleMotion,resources,resourceVersion,readingAhead};
}
