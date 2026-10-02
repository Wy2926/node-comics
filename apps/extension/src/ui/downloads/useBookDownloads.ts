import {useCallback,useEffect,useRef,useState} from 'react';
import {subscribeLibrary} from '../../comics/application/library-service';
import {hostBookDownloads,isBookDownloadActive,listBookDownloads,startBookDownload,readComicOfflineCapability,type BookDownloadView} from '../../comics/acquisition/books';
import {msg} from '../../i18n/runtime';
import {listRemoteFileDownloads,queueRemoteFileDownload,prepareRemoteFileDownload,type FileDownloadView} from '../../comics/acquisition/files';
import type {RemoteReadingPlan} from '../../comics/sources/contracts';

export function useBookDownloads(notify:(message:string)=>void,onOpenCenter:()=>void){
  const [books,setBooks]=useState<BookDownloadView[]>([]),[languagePicker,setLanguagePicker]=useState<{comicId:string;anchor:HTMLElement}>();
  const [files,setFiles]=useState<FileDownloadView[]>([]),[filePrompt,setFilePrompt]=useState<{connectionId:string;plan:RemoteReadingPlan}>();
  const [focusedComicId,setFocusedComicId]=useState<string>();
  const navigate=useRef(onOpenCenter);navigate.current=onOpenCenter;
  const refreshRef=useRef<()=>void>(()=>{}),notice=useRef(notify);notice.current=notify;
  const focusReturn=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    let disposed=false,loading=false,dirty=true;const previous=new Map<string,string>();let initialized=false;
    const refresh=async()=>{
      if(disposed||loading||!dirty)return;loading=true;dirty=false;
      try{
        const [next,nextFiles]=await Promise.all([listBookDownloads(),listRemoteFileDownloads()]);if(disposed)return;
        const ids=new Set(next.map(item=>item.comic.id));
        for(const item of nextFiles)ids.add(item.intent.id);
        for(const id of previous.keys())if(!ids.has(id))previous.delete(id);
        for(const item of next){
          const state=item.status+':'+(item.plan.reason??'');
          if(initialized&&previous.get(item.comic.id)!==state){
            if(item.status==='complete')notice.current(msg('《{0}》的缓存已完成',{'0':item.comic.title}));
            else if(item.status==='partial'||item.status==='paused'&&item.plan.reason)notice.current(msg('《{0}》的缓存需要处理',{'0':item.comic.title}));
          }
          previous.set(item.comic.id,state);
        }
        for(const {intent} of nextFiles){
          const state=intent.status+':'+(intent.reason??'');
          if(initialized&&previous.get(intent.id)!==state){
            if(intent.status==='complete')notice.current(msg('《{0}》的缓存已完成',{'0':intent.title}));
            else if(intent.status==='failed'||intent.status==='paused'&&intent.reason)notice.current(msg('《{0}》的缓存需要处理',{'0':intent.title}));
          }
          previous.set(intent.id,state);
        }
        initialized=true;setBooks(next);setFiles(nextFiles);
      }catch(error){if(!disposed)notice.current((error as Error).message);}finally{loading=false;}
    };
    refreshRef.current=()=>{dirty=true;void refresh();};
    const unsubscribe=subscribeLibrary(change=>{
      if(change.table==='metadata'||change.table==='tasks'){
        const prefix=change.table==='metadata'?'book-download:':'download:';
        if(change.ids.some(id=>typeof id==='string'&&(id.startsWith(prefix)||change.table==='metadata'&&id.startsWith('file-download:'))))dirty=true;
      }else if(['entries','comics','catalogs'].includes(change.table))dirty=true;
    });
    const timer=setInterval(()=>void refresh(),750);void refresh();
    const controller=new AbortController(),stop=()=>controller.abort();window.addEventListener('pagehide',stop);
    void hostBookDownloads(controller.signal).catch(error=>{if(!disposed)notice.current((error as Error).message);});
    return()=>{disposed=true;controller.abort();clearInterval(timer);unsubscribe();window.removeEventListener('pagehide',stop);};
  },[]);
  const open=useCallback((comicId?:string,languages=false,anchor=document.activeElement as HTMLElement)=>{
    if(languages&&comicId){focusReturn.current=anchor;setLanguagePicker({comicId,anchor});}
    else{setLanguagePicker(undefined);setFocusedComicId(comicId);navigate.current();}
  },[]);
  const close=useCallback((restoreFocus=true)=>{setLanguagePicker(undefined);if(restoreFocus)requestAnimationFrame(()=>{
    (focusReturn.current?.isConnected?focusReturn.current:document.querySelector<HTMLElement>('[data-downloads-trigger]'))?.focus({preventScroll:true});
  });},[]);
  const run=useCallback(async(action:()=>Promise<unknown>)=>{try{await action();refreshRef.current();}catch(error){notice.current((error as Error).message);}},[]);
  const start=useCallback((comicId:string)=>run(async()=>{
    if(await readComicOfflineCapability(comicId)==='file'){setFilePrompt(await prepareRemoteFileDownload(comicId));return;}
    if(await startBookDownload(comicId))notice.current(msg('已加入整本缓存，可在离线缓存中查看进度。'));
    else open(comicId);
  }),[open,run]);
  const confirmFile=useCallback(async()=>{if(!filePrompt)return;await queueRemoteFileDownload(filePrompt.connectionId,filePrompt.plan,{confirmed:true});setFilePrompt(undefined);refreshRef.current();notice.current(msg('已加入下载，可在离线中心查看进度。'));},[filePrompt]);
  const promptFileDownload=useCallback((connectionId:string,plan:RemoteReadingPlan)=>setFilePrompt({connectionId,plan}),[]);
  return {books,files,activeCount:books.filter(book=>isBookDownloadActive(book.status)).length+files.filter(file=>file.intent.status==='queued'||file.intent.status==='running').length,languagePicker,focusedComicId,open,close,start,filePrompt,promptFileDownload,closeFilePrompt:()=>setFilePrompt(undefined),confirmFile,refresh:()=>refreshRef.current()};
}
export type BookDownloadsController=ReturnType<typeof useBookDownloads>;
