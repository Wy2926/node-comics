import {useEffect,useRef,useState,type HTMLAttributes} from 'react';
import {formatDate,msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {Thumbnail} from '../reader/Images';
import {coverReference,hasCatalogUpdates,shelfReadingProgress,type Comic} from '../comics/application/library-service';
type Selection={checked:boolean;disabled:boolean;onToggle:()=>void};
export function ShelfCard({active,comic,onOpen,menu,selection}:{active:boolean;comic:Comic;onOpen:()=>void;menu:HTMLAttributes<HTMLElement>;selection?:Selection}){
 const action=selection?.onToggle??onOpen,selectLabel=msg('选择漫画 {0}',{'0':comic.title});
 const lastRead=comic.lastReadAt&&Number.isFinite(comic.lastReadAt)?comic.lastReadAt:undefined;
 const [progress,setProgress]=useState(0),progressComic=useRef<Comic>(undefined);
 useEffect(()=>{
  if(!active||progressComic.current===comic)return;
  let current=true;
  void shelfReadingProgress(comic).then(value=>{if(current){progressComic.current=comic;setProgress(value);}}).catch(()=>{if(current)setProgress(0);});
  return()=>{current=false;};
 },[active,comic]);
 const coverKey=coverReference(comic),[coverFailure,setCoverFailure]=useState<{key:string;error:unknown}>(),[retry,setRetry]=useState(0);
 const failedCover=coverFailure?.key===coverKey?coverFailure:undefined;
 const retryLabel=msg('重试');
 const retryCover=()=>{setCoverFailure(undefined);setRetry(value=>value+1);};
 return <article className={'nc-book'+(selection?.checked?' is-selected':'')+(selection?' is-managing':'')} data-comic-id={comic.id} {...(!selection?menu:{})}>
  {selection&&<input className="nc-card-select" type="checkbox" aria-label={selectLabel} checked={selection.checked} disabled={selection.disabled} onChange={selection.onToggle}/>}
  <button className="nc-book-cover" aria-label={selection?selectLabel:msg('打开漫画 {0}',{'0':comic.title})} aria-pressed={selection?.checked} disabled={selection?.disabled} onClick={action}>
   <Thumbnail key={comic.source.generation+':'+comic.source.status} blobKey={comic.source.status==='active'?coverKey:undefined} alt={msg('{0}封面',{'0':comic.title})} retryKey={retry} onError={comic.sourceCover?error=>setCoverFailure({key:coverKey!,error}):undefined}/>
   <span className="nc-card-source" title={comic.sourceName}>{comic.sourceName}</span>
   <span className="nc-card-reading-time"><Icon name="clock" size={14}/>{lastRead?<time dateTime={new Date(lastRead).toISOString()} title={formatDate(lastRead,true)}>{formatDate(lastRead,true)}</time>:<span>{msg('还没阅读')}</span>}</span>
  </button>
  <div className="nc-card-progress" role="progressbar" aria-label={msg('阅读进度')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} title={`${msg('阅读进度')} · ${Math.round(progress)}%`}><span style={{width:`${progress}%`}}/></div>
  {failedCover&&!selection&&<button className="button secondary small nc-cover-retry" onClick={retryCover}
   aria-label={msg('{0}封面',{'0':comic.title})+' · '+retryLabel}
   title={failedCover.error instanceof Error?failedCover.error.message:msg('图片暂不可用')}>{retryLabel}</button>}
   {hasCatalogUpdates(comic)&&<span className="nc-card-update" role="img" aria-label={msg('有更新')} title={msg('新增 {0} 个条目，目录已自动同步',{'0':comic.catalogUpdates?.count??0})}>
    <Icon name="new" size={92}/>
   </span>}
  <div className="nc-library-card-body"><h2 className="nc-card-title"><button disabled={selection?.disabled} onClick={action}>{comic.title}</button></h2></div>
 </article>;
}
