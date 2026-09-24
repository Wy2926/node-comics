import {useState,type HTMLAttributes,type MouseEvent} from 'react';
import {formatDate,msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {Thumbnail} from '../reader/Images';
import {coverReference,type Comic} from '../comics/application/library-service';
import {ImagePermissionsRequired,requestImagePermissions} from '../sources';
type Selection={checked:boolean;disabled:boolean;onToggle:()=>void};
export function ShelfCard({comic,onOpen,onMore,menu,selection}:{comic:Comic;onOpen:()=>void;onMore:(event:MouseEvent<HTMLButtonElement>)=>void;menu:HTMLAttributes<HTMLElement>;selection?:Selection}){
 const action=selection?.onToggle??onOpen,selectLabel=msg('选择漫画 {0}',{'0':comic.title});
 const lastRead=comic.lastReadAt&&Number.isFinite(comic.lastReadAt)?comic.lastReadAt:undefined;
 const coverKey=coverReference(comic),[coverFailure,setCoverFailure]=useState<{key:string;error:unknown}>(),[retry,setRetry]=useState(0),[retrying,setRetrying]=useState(false);
 const failedCover=coverFailure?.key===coverKey?coverFailure:undefined;
 const permission=failedCover?.error instanceof ImagePermissionsRequired?failedCover.error:undefined;
 const retryLabel=permission?msg('授权并继续'):msg('重试');
 const retryCover=()=>{
  setRetrying(true);
  const authorization=permission?requestImagePermissions(permission.origins):Promise.resolve();
  void authorization.then(()=>{setCoverFailure(undefined);setRetry(value=>value+1);})
   .catch(error=>setCoverFailure({key:coverKey!,error:permission??error})).finally(()=>setRetrying(false));
 };
 return <article className={'nc-book'+(selection?.checked?' is-selected':'')+(selection?' is-managing':'')} data-comic-id={comic.id} {...(!selection?menu:{})}>
  {selection&&<input className="nc-card-select" type="checkbox" aria-label={selectLabel} checked={selection.checked} disabled={selection.disabled} onChange={selection.onToggle}/>}
  <button className="nc-book-cover" aria-label={selection?selectLabel:msg('打开漫画 {0}',{'0':comic.title})} aria-pressed={selection?.checked} disabled={selection?.disabled} onClick={action}>
   <Thumbnail blobKey={coverKey} alt={msg('{0}封面',{'0':comic.title})} retryKey={retry} onError={comic.sourceCover?error=>setCoverFailure({key:coverKey!,error}):undefined}/>
   <span className="nc-card-source">{comic.sourceName}</span>
   <span className="nc-card-reading-time"><Icon name="clock" size={14}/>{lastRead?<time dateTime={new Date(lastRead).toISOString()} title={formatDate(lastRead,true)}>{formatDate(lastRead,true)}</time>:<span>{msg('还没阅读')}</span>}</span>
  </button>
  {failedCover&&!selection&&<button className="button secondary small nc-cover-retry" disabled={retrying} onClick={retryCover}
   aria-label={msg('{0}封面',{'0':comic.title})+' · '+retryLabel}
   title={failedCover.error instanceof Error?failedCover.error.message:msg('图片暂不可用')}>{retryLabel}</button>}
   {!!comic.catalogUpdates?.count&&comic.catalogUpdates.revision>comic.catalogUpdates.seenRevision&&<span className="nc-card-update" role="img" aria-label={msg('有更新')} title={msg('新增 {0} 个条目，目录已自动同步',{'0':comic.catalogUpdates.count})}>
    <svg viewBox="0 0 104 92" aria-hidden="true" focusable="false">
     <path d="m53 7 10 10 17-4 1 15 16 8-10 14 8 16-18 2-5 17-16-7-14 9-9-14-18-1 4-18L7 42l15-9-1-16 18 2Z" fill="#17233b" transform="translate(1 3)"/>
     <path d="m53 7 10 10 17-4 1 15 16 8-10 14 8 16-18 2-5 17-16-7-14 9-9-14-18-1 4-18L7 42l15-9-1-16 18 2Z" fill="#ffe45e" stroke="#fff" strokeWidth="3" strokeLinejoin="round"/>
     <path d="m30 31 48-8 9 39-52 10-12-24Z" fill="#ed277a" stroke="#17233b" strokeWidth="2.5" strokeLinejoin="round"/>
     <path d="m30 37 45-8M40 65l37-7" stroke="#ff91c6" strokeWidth="2" strokeLinecap="round"/>
     <text x="55" y="55" textAnchor="middle" transform="rotate(-10 55 48)" fill="#fff" stroke="#17233b" strokeWidth="3" paintOrder="stroke" fontFamily="Arial, sans-serif" fontSize="24" fontWeight="900" letterSpacing="-1">NEW</text>
     <path d="m89 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2ZM12 68l2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill="#ffe45e" stroke="#17233b" strokeWidth="1.5" strokeLinejoin="round"/>
     <circle cx="18" cy="8" r="3" fill="#ed277a" stroke="#fff" strokeWidth="1.5"/>
    </svg>
   </span>}
  <div className="nc-library-card-body"><h2 className="nc-card-title"><button disabled={selection?.disabled} onClick={action}>{comic.title}</button></h2><div className="nc-library-card-actions"><button className={'button small '+(selection&&!selection.checked?'secondary':'primary')} disabled={selection?.disabled} aria-pressed={selection?.checked} onClick={action}>{selection?(selection.checked?msg('✓ 已选择'):msg('选择')):comic.lastReadAt?msg('继续阅读'):msg('开始阅读')}</button>{!selection&&<button className="icon-button" aria-label={msg('更多操作 · {0}',{'0':comic.title})} aria-haspopup="menu" onClick={onMore}><Icon name="more" size={18}/></button>}</div></div>
 </article>;
}
