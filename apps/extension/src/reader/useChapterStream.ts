import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {ReadingCopy,Settings} from '../types';
import {readPosition,savePosition} from '../library/store';
import {anchorFor} from './model';
import {completePageList} from '../library/model';

export const pageKey=(copy:ReadingCopy,pageId:string)=>`${copy.id}:${pageId}`;
export const completeManifest=completePageList;

type Props={copy:ReadingCopy;sequence:ReadingCopy[];layout:Settings['layout'];update:(copy:ReadingCopy)=>void;onActiveCopy:(id:string)=>void;onLoadCopy:(id:string)=>void;onMarkRead:(id:string)=>Promise<void>;notify:(message:string)=>void};

/** Keep chapter geometry mounted while the active chapter and translation scope follow scrolling. */
export function useChapterStream({copy,sequence,layout,update,onActiveCopy,onLoadCopy,onMarkRead,notify}:Props){
 const stored=readPosition(copy.id,copy.manifestRevision);
 const initial=stored&&copy.pages.some(p=>p.id===stored.pageId)?stored:{pageId:copy.pageId,relativeOffset:copy.relativeOffset};
 const [index,setIndex]=useState(()=>Math.max(0,copy.pages.findIndex(p=>p.id===initial.pageId)));
 const [loadedIds,setLoadedIds]=useState([copy.id]);
 const stream=loadedIds.flatMap(id=>{const c=id===copy.id?copy:sequence.find(c=>c.id===id);return c?[c]:[];});
 const visible=layout==='single'?[copy]:stream;
 const viewport=useRef<HTMLDivElement>(null),cells=useRef(new Map<string,HTMLDivElement>()),ends=useRef(new Map<string,HTMLDivElement>());
 const copyRef=useRef(copy),indexRef=useRef(index);copyRef.current=copy;indexRef.current=index;
 const anchor=useRef(initial),suppressScroll=useRef(false),lastScrollTop=useRef(0);
 const saveTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const pendingJump=useRef<{copyId:string;pageId:string}|undefined>(undefined);
 const prependAnchor=useRef<{key:string;top:number}|undefined>(undefined);
 const requested=useRef(new Set<string>()),read=useRef(new Set<string>());
 const nextOf=(c:ReadingCopy)=>{const at=sequence.findIndex(item=>item.id===c.id);return at<0?undefined:sequence[at+1];};
 const next=completeManifest(copy)?nextOf(copy):undefined;
 function preserve(){const c=copyRef.current,p=c.pages[indexRef.current],el=p&&cells.current.get(pageKey(c,p.id)),v=viewport.current;if(el&&v)anchor.current={pageId:p.id,relativeOffset:layout==='single'?anchorFor(0,el.offsetHeight,v.scrollTop):anchorFor(el.offsetTop,el.offsetHeight,v.scrollTop)};}
 function persist(){clearTimeout(saveTimer.current);const c=copyRef.current;if(!c.pages.some(p=>p.id===anchor.current.pageId))return;savePosition(c.id,c.manifestRevision,anchor.current);update({...c,...anchor.current,lastReadAt:Date.now(),updatedAt:Date.now()});}
 function restore(){const v=viewport.current,el=cells.current.get(pageKey(copyRef.current,anchor.current.pageId));if(v&&el){suppressScroll.current=true;v.scrollTop=(layout==='single'?0:el.offsetTop)+el.offsetHeight*anchor.current.relativeOffset;lastScrollTop.current=v.scrollTop;requestAnimationFrame(()=>{suppressScroll.current=false;});}}
 function append(c:ReadingCopy){setLoadedIds(ids=>ids.includes(c.id)?ids:[...ids,c.id]);if(!requested.current.has(c.id)){requested.current.add(c.id);onLoadCopy(c.id);}}
 function markRead(c:ReadingCopy){
  // An unfinished manifest or missing original must remain actionable in the library.
  if(!completeManifest(c)||c.pages.some(p=>!p.blobKey))return;
  const key=`${c.id}:${c.manifestRevision}`;if(read.current.has(key))return;read.current.add(key);
  void onMarkRead(c.id).catch(e=>{read.current.delete(key);notify('已读状态未保存：'+(e as Error).message);});
 }
 function activate(c:ReadingCopy,n:number){if(c.id!==copyRef.current.id){persist();copyRef.current=c;onActiveCopy(c.id);}indexRef.current=n;setIndex(n);}
 function scroll(){
  const v=viewport.current;if(!v||suppressScroll.current)return;
  const previousTop=lastScrollTop.current;
  const forward=v.scrollTop>previousTop;lastScrollTop.current=v.scrollTop;
  const line=v.scrollTop+Math.min(80,v.clientHeight*.1);
  if(layout==='continuous'){
   let active=stream[0]??copyRef.current,closest=0;
   for(const c of stream)for(const [n,p] of c.pages.entries()){const el=cells.current.get(pageKey(c,p.id));if(el&&el.offsetTop<=line){active=c;closest=n;}}
   activate(active,closest);
  }
  preserve();clearTimeout(saveTimer.current);saveTimer.current=setTimeout(persist,350);
  if(forward){
   for(const c of visible){const end=ends.current.get(c.id);if(!end)continue;
    const crossed=layout==='continuous'&&!!nextOf(c)?.pages.length?end.offsetTop<=line:end.offsetTop+end.offsetHeight<=v.scrollTop+v.clientHeight+1;
    if(crossed&&end.offsetTop>previousTop&&(layout==='continuous'||indexRef.current===c.pages.length-1))markRead(c);
   }
   const end=ends.current.get(copyRef.current.id);
   if(layout==='single'&&indexRef.current===copyRef.current.pages.length-1&&end&&end.offsetTop+end.offsetHeight<=v.scrollTop+v.clientHeight+1&&next)jump(copyRef.current.pages.length);
  }
 }
 function jump(n:number){
  const c=copyRef.current;if(!c.pages.length||!Number.isFinite(n))return;
  if(n>=c.pages.length&&completeManifest(c)){
   const destination=nextOf(c);
   if(destination){append(destination);markRead(c);suppressScroll.current=true;pendingJump.current={copyId:destination.id,pageId:destination.pages[0]?.id??''};activate(destination,0);anchor.current={pageId:pendingJump.current.pageId,relativeOffset:0};persist();return;}
  }
  const target=Math.max(0,Math.min(c.pages.length-1,Math.trunc(n)));suppressScroll.current=true;pendingJump.current={copyId:c.id,pageId:c.pages[target].id};indexRef.current=target;setIndex(target);anchor.current={pageId:c.pages[target].id,relativeOffset:0};persist();
 }
 // React may commit a different chapter after the next animation frame; restore only once its cell exists.
 useLayoutEffect(()=>{const pending=pendingJump.current;if(!pending||pending.copyId!==copy.id)return;const pageId=pending.pageId||copy.pages[0]?.id;if(!pageId||!cells.current.has(pageKey(copy,pageId)))return;anchor.current={pageId,relativeOffset:0};pendingJump.current=undefined;restore();});
 // Preserve the actual screen coordinate, including headings and gaps, when inserting above it.
 useLayoutEffect(()=>{
  const pending=prependAnchor.current,v=viewport.current;if(!pending||!v)return;
  const cell=cells.current.get(pending.key);prependAnchor.current=undefined;
  if(cell)v.scrollTop+=cell.getBoundingClientRect().top-pending.top;
  lastScrollTop.current=v.scrollTop;
  requestAnimationFrame(()=>{suppressScroll.current=false;});
 },[loadedIds]);
 // Only load one adjacent chapter when the mounted head is near the viewport.
 useEffect(()=>{
  if(layout!=='continuous')return;
  const head=stream[0];if(!head||head.id!==copy.id)return;
  const at=sequence.findIndex(c=>c.id===head.id),destination=sequence[at-1];
  const start=head.pages[0]&&cells.current.get(pageKey(head,head.pages[0].id));
  if(!destination||!start||loadedIds.includes(destination.id))return;
  const observer=new IntersectionObserver(entries=>{
   if(!entries.some(e=>e.isIntersecting)||prependAnchor.current||pendingJump.current)return;
   const c=copyRef.current,p=c.pages[indexRef.current],cell=p&&cells.current.get(pageKey(c,p.id));if(!cell)return;
   prependAnchor.current={key:pageKey(c,p.id),top:cell.getBoundingClientRect().top};suppressScroll.current=true;
   setLoadedIds(ids=>ids.includes(destination.id)?ids:[destination.id,...ids]);
   if(!requested.current.has(destination.id)){requested.current.add(destination.id);onLoadCopy(destination.id);}
  },{root:viewport.current,rootMargin:'160px 0px 0px 0px'});
  observer.observe(start);return()=>observer.disconnect();
 },[layout,copy,sequence,loadedIds]);
 // Append once the end enters the loading margin. Appending never marks a chapter read.
 useEffect(()=>{
  if(layout!=='continuous')return;
  const tail=stream.at(-1);if(!tail||tail.id!==copy.id||!completeManifest(tail))return;
  const destination=nextOf(tail),end=ends.current.get(tail.id);if(!destination||!end||loadedIds.includes(destination.id))return;
  const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))append(destination);},{root:viewport.current,rootMargin:'0px 0px 160px 0px'});observer.observe(end);return()=>observer.disconnect();
 },[layout,copy,sequence,loadedIds]);
 useEffect(()=>()=>clearTimeout(saveTimer.current),[]);
 return {index,setIndex,indexRef,copyRef,anchor,suppressScroll,viewport,cells,ends,stream:visible,next,nextOf,preserve,persist,restore,scroll,jump};
}
