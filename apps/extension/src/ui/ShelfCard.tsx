import type {HTMLAttributes,MouseEvent} from 'react';
import {formatDate,msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {Thumbnail} from '../reader/Images';
import {coverReference,type Comic} from '../comics/application/library-service';
type Selection={checked:boolean;disabled:boolean;onToggle:()=>void};
export function ShelfCard({comic,onOpen,onMore,menu,selection}:{comic:Comic;onOpen:()=>void;onMore:(event:MouseEvent<HTMLButtonElement>)=>void;menu:HTMLAttributes<HTMLElement>;selection?:Selection}){
 const action=selection?.onToggle??onOpen,selectLabel=msg('选择漫画 {0}',{'0':comic.title});
 const lastRead=comic.lastReadAt&&Number.isFinite(comic.lastReadAt)?comic.lastReadAt:undefined;
 return <article className={'nc-book'+(selection?.checked?' is-selected':'')+(selection?' is-managing':'')} data-comic-id={comic.id} {...(!selection?menu:{})}>
  {selection&&<input className="nc-card-select" type="checkbox" aria-label={selectLabel} checked={selection.checked} disabled={selection.disabled} onChange={selection.onToggle}/>}
  <button className="nc-book-cover" aria-label={selection?selectLabel:msg('打开漫画 {0}',{'0':comic.title})} aria-pressed={selection?.checked} disabled={selection?.disabled} onClick={action}>
   <Thumbnail blobKey={coverReference(comic.cover)} alt={msg('{0}封面',{'0':comic.title})}/>
   <span className="nc-card-reading-time"><Icon name="clock" size={14}/>{lastRead?<time dateTime={new Date(lastRead).toISOString()} title={formatDate(lastRead,true)}>{formatDate(lastRead,true)}</time>:<span>{msg('还没阅读')}</span>}</span>
   <span className="nc-cover-details"><span className="nc-cover-tag">{comic.sourceName}</span><span className="nc-cover-reading">{comic.lastPage?(comic.lastPageCount?msg('第 {0} / {1} 页',{'0':comic.lastPage,'1':comic.lastPageCount}):msg('第 {0} 页',{'0':comic.lastPage})):msg('还没阅读')}</span></span>
  </button>
  <div className="nc-library-card-body"><h2 className="nc-card-title"><button disabled={selection?.disabled} onClick={action}>{comic.title}</button></h2><div className="nc-library-card-actions"><button className={'button small '+(selection&&!selection.checked?'secondary':'primary')} disabled={selection?.disabled} aria-pressed={selection?.checked} onClick={action}>{selection?(selection.checked?msg('✓ 已选择'):msg('选择')):comic.lastReadAt?msg('继续阅读'):msg('开始阅读')}</button>{!selection&&<button className="icon-button" aria-label={msg('更多操作 · {0}',{'0':comic.title})} aria-haspopup="menu" onClick={onMore}><Icon name="more" size={18}/></button>}</div></div>
 </article>;
}
