import type {HTMLAttributes,MouseEvent} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {Thumbnail} from '../reader/Images';
import {coverReference,type Comic} from '../comics/application/library-service';
export function ShelfCard({comic,onOpen,onMore,menu}:{comic:Comic;onOpen:()=>void;onMore:(event:MouseEvent<HTMLButtonElement>)=>void;menu:HTMLAttributes<HTMLElement>}){
 return <article className="nc-book" data-comic-id={comic.id} {...menu}>
  <button className="nc-book-cover" aria-label={msg('打开漫画 {0}',{'0':comic.title})} onClick={onOpen}><Thumbnail blobKey={coverReference(comic.cover)} alt={msg('{0}封面',{'0':comic.title})}/><span className="nc-cover-details"><span className="nc-cover-tag">{comic.sourceName}</span><span className="nc-cover-reading">{comic.lastPage?(comic.lastPageCount?msg('第 {0} / {1} 页',{'0':comic.lastPage,'1':comic.lastPageCount}):msg('第 {0} 页',{'0':comic.lastPage})):msg('还没阅读')}</span></span></button>
  <div className="nc-library-card-body"><h2 className="nc-card-title"><button onClick={onOpen}>{comic.title}</button></h2><div className="nc-library-card-actions"><button className="button primary small" onClick={onOpen}>{comic.lastReadAt?msg('继续阅读'):msg('开始阅读')}</button><button className="icon-button" aria-label={msg('更多操作 · {0}',{'0':comic.title})} aria-haspopup="menu" onClick={onMore}><Icon name="more" size={18}/></button></div></div>
 </article>;
}
