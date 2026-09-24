import {useMemo,useRef,useState,type RefObject} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {continueEntry,removeComics,type Comic,type Entry} from '../comics/application/library-service';
import type {LibraryViewModel} from '../comics/application/types';
import {useContextMenu} from './ContextMenu';
import {Select} from './Select';
import {Modal} from './components';
import {ShelfGrid,type ShelfView} from './ShelfGrid';
import {ShelfCard} from './ShelfCard';
import './shelf.css';
type Props={library:LibraryViewModel;onOpen:(comicId:string)=>void;onImport:()=>void;onSource:(providerId:string)=>void;sourceActions:{id:string;label:string}[];onChanged:()=>void|Promise<void>;notify:(message:string)=>void;onExport:(entry:Entry)=>void;shelfView:RefObject<ShelfView>};
export function Library({library,onOpen,onImport,onSource,sourceActions,onChanged,notify,onExport,shelfView}:Props){
 const menu=useContextMenu(),[removing,setRemoving]=useState<Comic[]>(),[busy,setBusy]=useState(false),removalRunning=useRef(false);
 const [managing,setManaging]=useState(false),[selected,setSelected]=useState<Set<string>>(()=>new Set());
 const [search,setSearch]=useState(shelfView.current.search),[sort,setSort]=useState(shelfView.current.sort);
 const matching=useMemo(()=>library.comics.filter(value=>value.title.normalize('NFKC').toLocaleLowerCase().includes(search.trim().normalize('NFKC').toLocaleLowerCase())).sort((a,b)=>(sort==='title'?a.title.localeCompare(b.title,undefined,{numeric:true}):sort==='recent'?(b.lastReadAt??b.createdAt)-(a.lastReadAt??a.createdAt):b.updatedAt-a.updatedAt)||a.id.localeCompare(b.id)),[library.comics,search,sort]);
 const selectedComics=useMemo(()=>library.comics.filter(comic=>selected.has(comic.id)),[library.comics,selected]);
 const changeSearch=(value:string)=>{shelfView.current.search=value;shelfView.current.scrollTop=0;setSearch(value);window.scrollTo({top:0,behavior:'instant'});};
 const changeSort=(value:string)=>{shelfView.current.sort=value;shelfView.current.scrollTop=0;setSort(value);window.scrollTo({top:0,behavior:'instant'});};
 const open=(id:string)=>{shelfView.current.scrollTop=window.scrollY;onOpen(id);};
 const toggle=(id:string)=>setSelected(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next;});
 const actions=(comic:Comic)=>[
  {label:comic.lastReadAt?msg('继续阅读'):msg('开始阅读'),onSelect:()=>open(comic.id)},
  ...(comic.sourceUrl?[{label:msg('打开来源'),onSelect:()=>window.open(comic.sourceUrl,'_blank','noopener,noreferrer')}]:[]),
  {label:msg('导出漫画'),onSelect:()=>void continueEntry(comic.id).then(entry=>{if(!entry){open(comic.id);return;}onExport(entry);}).catch(e=>notify(e.message))},
  {label:msg('移除漫画'),danger:true,onSelect:()=>setRemoving([comic])},
 ];
 async function confirmRemoval(){
  if(!removing?.length||removalRunning.current)return;
  removalRunning.current=true;setBusy(true);
  try{
   const result=await removeComics(removing.map(comic=>comic.id)),removed=new Set(result.removed);
   setSelected(previous=>new Set([...previous].filter(id=>!removed.has(id))));
   const failed=removing.filter(comic=>result.failures.some(failure=>failure.id===comic.id));
   setRemoving(failed.length?failed:undefined);
   await onChanged();
   if(result.failures.length)notify(result.failures.map(failure=>`${removing.find(comic=>comic.id===failure.id)?.title}: ${failure.error}`).join('\n'));
   else notify(msg('已移除 {0} 部漫画',{'0':result.removed.length}));
  }catch(error){notify((error as Error).message);}
  finally{removalRunning.current=false;setBusy(false);}
 }
 return <div className="nc-library">
  <div className="nc-page-heading"><div><span className="nc-eyebrow">{msg('YOUR STORIES, YOUR PACE')}</span><h1 className="nc-shelf-title"><span>{msg('我的漫画')}</span><span className="nc-profile-avatar nc-shelf-count">{library.comics.length}</span></h1><p>{msg('保存喜欢的故事，随时继续上次阅读。')}</p></div><div className="nc-inline"><button className="button primary" onClick={onImport}><Icon name="plus"/>{msg('导入漫画')}</button>{!!sourceActions.length&&<button className="button secondary" aria-haspopup="menu" onClick={e=>menu.open(e.currentTarget,msg('云盘'),sourceActions.map(action=>({label:action.label,onSelect:()=>onSource(action.id)})))}>{msg('云盘')}</button>}</div></div>
  <div className="nc-library-tools nc-shelf-tools">
   <label className="nc-search"><Icon name="book" size={18}/><input type="search" aria-label={msg('搜索漫画')} placeholder={msg('搜索漫画')} value={search} onChange={e=>changeSearch(e.target.value)}/></label>
   <label className="nc-sort-label">{msg('排序')}<Select aria-label={msg('排序')} value={sort} onChange={e=>changeSort(e.target.value)}><option value="recent">{msg('最近阅读')}</option><option value="updated">{msg('最近更新')}</option><option value="title">{msg('按名称')}</option></Select></label>
   {!!library.comics.length&&<button className="button secondary" aria-pressed={managing} disabled={busy} onClick={()=>{setManaging(value=>!value);setSelected(new Set());}}>{managing?msg('完成管理'):msg('批量管理')}</button>}
  </div>
  {managing&&!!library.comics.length&&<div className="nc-batch-toolbar" role="region" aria-label={msg('批量管理')}>
   <span role="status">{msg('已选 {0} 部作品',{'0':selectedComics.length})}</span>
   <div className="nc-inline"><button className="button secondary small" disabled={busy||!matching.length||matching.every(comic=>selected.has(comic.id))} onClick={()=>setSelected(previous=>new Set([...previous,...matching.map(comic=>comic.id)]))}>{msg('全选 {0} 部',{'0':matching.length})}</button><button className="text-link" disabled={busy||!selectedComics.length} onClick={()=>setSelected(new Set())}>{msg('取消选择')}</button></div>
   <button className="button danger small" disabled={busy||!selectedComics.length} onClick={()=>setRemoving(selectedComics)}>{msg('移除漫画')}</button>
  </div>}
  {!library.comics.length?<section className="nc-empty nc-import-empty"><span className="nc-empty-symbol">✦</span><h2>{msg('把喜欢的故事带进来')}</h2><p>{msg('选择漫画文件即可阅读，已适配网站也可直接添加。')}</p><button className="button primary" onClick={onImport}>{msg('选择漫画文件')}</button><span className="nc-muted">CBZ / ZIP · CBR / RAR · PDF · MOBI</span></section>:!matching.length?<div className="nc-empty nc-compact-empty"><h3>{msg('没有找到这部作品')}</h3><button className="text-link" onClick={()=>changeSearch('')}>{msg('清除搜索')}</button></div>:<ShelfGrid key={search+'|'+sort} comics={matching} view={shelfView}>{comic=><ShelfCard key={comic.id} comic={comic} onOpen={()=>open(comic.id)} onMore={e=>menu.open(e.currentTarget,comic.title,actions(comic))} menu={menu.bind(comic.title,actions(comic))} selection={managing?{checked:selected.has(comic.id),disabled:busy,onToggle:()=>toggle(comic.id)}:undefined}/>}</ShelfGrid>}
  {menu.menu}
  {!!removing?.length&&<Modal title={msg('移除漫画')} onClose={()=>{if(!busy)setRemoving(undefined);}}>
   <p>{removing.length===1?msg('从书架移除《{0}》及其阅读记录？',{'0':removing[0].title}):msg('从书架移除选中的 {0} 部漫画及其阅读记录？',{'0':removing.length})}</p>
   {removing.length>1&&<ul className="nc-removal-list">{removing.slice(0,5).map(comic=><li key={comic.id}>{comic.title}</li>)}{removing.length>5&&<li>…</li>}</ul>}
   <p className="nc-muted">{msg('来源网站和云盘中的文件不会删除。')}</p>
   <div className="nc-inline"><button className="button secondary" disabled={busy} onClick={()=>setRemoving(undefined)}>{msg('取消')}</button><button className="button danger" disabled={busy} onClick={()=>void confirmRemoval()}>{busy?msg('正在移除作品'):msg('移除漫画')}</button></div>
  </Modal>}
 </div>;
}
