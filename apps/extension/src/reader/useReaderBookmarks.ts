import {useEffect,useRef,useState} from 'react';
import {msg} from '../i18n/runtime';
import {addBookmark,deleteBookmark,noteBookmark,countBookmarks,findBookmark,listBookmarks,subscribeBookmarks,bookmarkKey,type BookmarkLocation,type ReaderBookmark} from '../comics/application/bookmarks';

type Notice={text:string;action?:string;run?:()=>Promise<unknown>};
export function useReaderBookmarks({comicId,current,open,capture,navigate,close}:{
  comicId?:string;current?:BookmarkLocation;open:boolean;
  capture():BookmarkLocation|undefined;navigate(location:BookmarkLocation):boolean|Promise<boolean>;close():void;
}){
  const [count,setCount]=useState(0),[items,setItems]=useState<ReaderBookmark[]>([]),[savedState,setSaved]=useState<{key?:string;value:boolean}>({value:false});
  const [loading,setLoading]=useState(true),[error,setError]=useState(false),[revision,setRevision]=useState(0);
  const [busy,setBusy]=useState(false),lock=useRef(false),alive=useRef(true);
  const [notice,setNotice]=useState<Notice>(),[returnTo,setReturnTo]=useState<BookmarkLocation>();
  const listEpoch=useRef(0);
  const currentKey=current&&bookmarkKey(current),latest=useRef(current);latest.current=current;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>subscribeBookmarks(()=>setRevision(n=>n+1)),[]);
  useEffect(()=>{
    let active=true;
    if(latest.current)void findBookmark(latest.current).then(value=>{if(active)setSaved({key:currentKey,value:!!value});}).catch(()=>{});
    return()=>{active=false;};
  },[currentKey,revision]);
  useEffect(()=>{
    let active=true;
    if(comicId)void countBookmarks(comicId).then(value=>{if(active)setCount(value);}).catch(()=>{if(active)setError(true);});
    return()=>{active=false;};
  },[comicId,revision]);
  useEffect(()=>{
    listEpoch.current++;
    if(!open)return;
    if(!comicId){setLoading(false);setItems([]);return;}
    let active=true;setLoading(true);setError(false);
    void listBookmarks(comicId).then(value=>{if(active)setItems(value);}).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[comicId,open,revision]);
  async function run(operation:()=>Promise<unknown>){
    if(lock.current)return false;lock.current=true;setBusy(true);
    try{await operation();return true;}
    catch{if(alive.current)setNotice({text:msg('书签操作失败，请重试；原有书签仍保留。')});return false;}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  async function remove(item:ReaderBookmark){
    const deleted=await deleteBookmark(item.id);
    if(deleted&&alive.current)setNotice({text:msg('已删除书签'),action:msg('撤销'),run:async()=>{await addBookmark(deleted,deleted);setNotice({text:msg('已恢复书签')});}});
  }
  function toggle(){void run(async()=>{
    const location=capture();if(!location)return;
    const existing=await findBookmark(location);
    if(existing)await remove(existing);
    else{await addBookmark(location);if(alive.current)setNotice({text:msg('已添加书签')});}
  });}
  function jump(location:BookmarkLocation,returning=false){void run(async()=>{
    const previous=capture();
    if(!await navigate(location)){setNotice({text:msg('书签位置已不可用，请重新打开内容。')});return;}
    if(!alive.current)return;
    setReturnTo(returning?undefined:previous);setNotice(undefined);close();
  });}
  return {items,count,saved:savedState.key===currentKey&&savedState.value,loading,error,busy,current,notice,returnTo,toggle,jump,
    retry:()=>setRevision(n=>n+1),dismiss:()=>{setNotice(undefined);setReturnTo(undefined);},
    act:()=>{if(notice?.run)void run(notice.run);else if(returnTo)jump(returnTo,true);},
    remove:(item:ReaderBookmark)=>run(()=>remove(item)),
    saveNote:(item:ReaderBookmark,note:string)=>run(async()=>{await noteBookmark(item.id,note);setNotice(undefined);}),
    more:()=>{if(!comicId)return;void run(async()=>{const epoch=listEpoch.current,next=await listBookmarks(comicId,items.at(-1));if(alive.current&&epoch===listEpoch.current)setItems(previous=>[...previous,...next.filter(item=>!previous.some(old=>old.id===item.id))]);});},
  };
}
export type ReaderBookmarksController=ReturnType<typeof useReaderBookmarks>;
