import {useMemo,useState,type RefObject} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {continueEntry,removeComic,type Comic,type Entry} from '../comics/application/library-service';
import type {LibraryViewModel} from '../comics/application/types';
import {useContextMenu} from './ContextMenu';
import {Select} from './Select';
import {Modal} from './components';
import {ShelfGrid,type ShelfView} from './ShelfGrid';
import {ShelfCard} from './ShelfCard';
import './shelf.css';
type Props={library:LibraryViewModel;onOpen:(comicId:string)=>void;onDirectory:(comicId:string)=>void;onImport:()=>void;onSource:(providerId:string)=>void;sourceActions:{id:string;label:string}[];onChanged:()=>void|Promise<void>;notify:(message:string)=>void;onExport:(entry:Entry)=>void;shelfView:RefObject<ShelfView>};
export function Library({library,onOpen,onDirectory,onImport,onSource,sourceActions,onChanged,notify,onExport,shelfView}:Props){
 const menu=useContextMenu(),[removing,setRemoving]=useState<Comic>(),[busy,setBusy]=useState(false);
 const [search,setSearch]=useState(shelfView.current.search),[sort,setSort]=useState(shelfView.current.sort);
 const matching=useMemo(()=>library.comics.filter(value=>value.title.normalize('NFKC').toLocaleLowerCase().includes(search.trim().normalize('NFKC').toLocaleLowerCase())).sort((a,b)=>(sort==='title'?a.title.localeCompare(b.title,undefined,{numeric:true}):sort==='recent'?(b.lastReadAt??b.createdAt)-(a.lastReadAt??a.createdAt):b.updatedAt-a.updatedAt)||a.id.localeCompare(b.id)),[library.comics,search,sort]);
 const changeSearch=(value:string)=>{shelfView.current.search=value;shelfView.current.scrollTop=0;setSearch(value);window.scrollTo({top:0,behavior:'instant'});};
 const changeSort=(value:string)=>{shelfView.current.sort=value;shelfView.current.scrollTop=0;setSort(value);window.scrollTo({top:0,behavior:'instant'});};
 const open=(id:string)=>{shelfView.current.scrollTop=window.scrollY;onOpen(id);};
 const actions=(comic:Comic)=>[
  {label:comic.lastReadAt?msg('继续阅读'):msg('开始阅读'),onSelect:()=>open(comic.id)},
  ...(comic.sourceUrl?[{label:msg('目录'),onSelect:()=>onDirectory(comic.id)},{label:msg('打开来源'),onSelect:()=>window.open(comic.sourceUrl,'_blank','noopener,noreferrer')}]:[]),
  {label:msg('导出漫画'),onSelect:()=>void continueEntry(comic.id).then(async id=>{if(!id){onDirectory(comic.id);return;}onExport(id);}).catch(e=>notify(e.message))},
  {label:msg('移除漫画'),danger:true,onSelect:()=>setRemoving(comic)},
 ];
 return <div className="nc-library">
  <div className="nc-page-heading"><div><span className="nc-eyebrow">YOUR STORIES, YOUR PACE</span><h1 className="nc-shelf-title"><span>{msg('我的漫画')}</span><span className="nc-profile-avatar nc-shelf-count">{library.comics.length}</span></h1><p>{msg('保存喜欢的故事，随时继续上次阅读。')}</p></div><div className="nc-inline"><button className="button primary" onClick={onImport}><Icon name="plus"/>{msg('导入漫画')}</button>{!!sourceActions.length&&<button className="button secondary" aria-haspopup="menu" onClick={e=>menu.open(e.currentTarget,msg('云盘'),sourceActions.map(action=>({label:action.label,onSelect:()=>onSource(action.id)})))}>{msg('云盘')}</button>}</div></div>
  <div className="nc-library-tools nc-shelf-tools"><label className="nc-search"><Icon name="book" size={18}/><input type="search" aria-label={msg('搜索漫画')} placeholder={msg('搜索漫画')} value={search} onChange={e=>changeSearch(e.target.value)}/></label><label className="nc-sort-label">{msg('排序')}<Select aria-label={msg('排序')} value={sort} onChange={e=>changeSort(e.target.value)}><option value="recent">{msg('最近阅读')}</option><option value="updated">{msg('最近更新')}</option><option value="title">{msg('按名称')}</option></Select></label></div>
  {!library.comics.length?<section className="nc-empty nc-import-empty"><span className="nc-empty-symbol">✦</span><h2>{msg('把喜欢的故事带进来')}</h2><p>{msg('选择漫画文件即可阅读，已适配网站也可直接添加。')}</p><button className="button primary" onClick={onImport}>{msg('选择漫画文件')}</button><span className="nc-muted">CBZ / ZIP · CBR / RAR · PDF · MOBI</span></section>:!matching.length?<div className="nc-empty nc-compact-empty"><h3>{msg('没有找到这部作品')}</h3><button className="text-link" onClick={()=>changeSearch('')}>{msg('清除搜索')}</button></div>:<ShelfGrid key={search+'|'+sort} comics={matching} view={shelfView}>{comic=><ShelfCard key={comic.id} comic={comic} onOpen={()=>open(comic.id)} onMore={e=>menu.open(e.currentTarget,comic.title,actions(comic))} menu={menu.bind(comic.title,actions(comic))}/>}</ShelfGrid>}
  {menu.menu}
  {removing&&<Modal title={msg('移除漫画')} onClose={()=>{if(!busy)setRemoving(undefined);}}><p>{msg('从书架移除《{0}》及其阅读记录？',{'0':removing.title})}</p><p className="nc-muted">{msg('来源网站和云盘中的文件不会删除。')}</p><button className="button danger" disabled={busy} onClick={()=>{setBusy(true);void removeComic(removing.id).then(async()=>{setRemoving(undefined);await onChanged();}).catch(e=>notify(e.message)).finally(()=>setBusy(false));}}>{msg('移除漫画')}</button></Modal>}
 </div>;
}
