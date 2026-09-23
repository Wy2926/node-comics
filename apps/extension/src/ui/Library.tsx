import {useEffect,useMemo,useRef,useState,type RefObject} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {loadWorkDetails,type Document} from '../comics/application/library-service';
import type {ImportAssignment,LibraryViewModel} from '../comics/application/types';
import {WorkDetails} from './WorkDetails';
import {useContextMenu} from './ContextMenu';
import {Select} from './Select';
import {ShelfGrid,type ShelfView} from './ShelfGrid';
import {ShelfCard} from './ShelfCard';
import './shelf.css';

type Props={library:LibraryViewModel;workId?:string;onSelectWork:(id?:string)=>void;onOpen:(id:string)=>void;onImport:(assignment?:ImportAssignment)=>void;onChanged:()=>void|Promise<void>;notify:(message:string)=>void;onExport:(doc:Document)=>void;shelfView:RefObject<ShelfView>};
export function Library({library,workId,onSelectWork,onOpen,onImport,onChanged,notify,onExport,shelfView}:Props){
 const contextMenu=useContextMenu();
 const [initialDialog,setInitialDialog]=useState<'work'|'remove-work'>();
 const openWork=(id:string,dialog?:'work'|'remove-work')=>{setInitialDialog(dialog);shelfView.current.scrollTop=window.scrollY;onSelectWork(id);window.scrollTo({top:0,behavior:'instant'});};
 const [search,setSearch]=useState(shelfView.current.search),[sort,setSort]=useState(shelfView.current.sort);
 const [details,setDetails]=useState<LibraryViewModel>(),[detailError,setDetailError]=useState('');
 const selectedWork=useRef(workId),detailEpoch=useRef(0);selectedWork.current=workId;
 useEffect(()=>{let active=true;const request=++detailEpoch.current;setDetailError('');if(!workId){setDetails(undefined);return;}void loadWorkDetails(workId).then(value=>{if(active&&request===detailEpoch.current&&selectedWork.current===workId){setDetails(value);if(!value)setDetailError(msg('作品已移除。'));}}).catch(reason=>{if(active&&request===detailEpoch.current)setDetailError(reason instanceof Error?reason.message:msg('操作失败，请重试。'));});return()=>{active=false;};},[workId,library]);
 const work=details?.works.find(value=>value.id===workId);
 useEffect(()=>{if(work)setInitialDialog(undefined);},[work]);
 const matching=useMemo(()=>library.works.filter(value=>(value.title+' '+(value.aliases??[]).join(' ')).normalize('NFKC').toLocaleLowerCase().includes(search.trim().normalize('NFKC').toLocaleLowerCase())).sort((a,b)=>(sort==='title'?a.title.localeCompare(b.title,undefined,{numeric:true}):sort==='recent'?(b.lastReadAt??0)-(a.lastReadAt??0):b.updatedAt-a.updatedAt)||a.id.localeCompare(b.id)),[library.works,search,sort]);
 const changeSearch=(value:string)=>{shelfView.current.search=value;shelfView.current.scrollTop=0;setSearch(value);window.scrollTo({top:0,behavior:'instant'});};
 const changeSort=(value:string)=>{shelfView.current.sort=value;shelfView.current.scrollTop=0;setSort(value);window.scrollTo({top:0,behavior:'instant'});};
 const refreshDetail=async()=>{await onChanged();if(!workId||selectedWork.current!==workId)return;const request=++detailEpoch.current,value=await loadWorkDetails(workId);if(request===detailEpoch.current&&selectedWork.current===workId)setDetails(value);};
 if(work&&details)return <>{detailError&&<p className="error-message" role="alert">{detailError}</p>}<WorkDetails initialDialog={initialDialog} key={work.id} work={work} library={details} onBack={()=>onSelectWork(undefined)} onOpen={onOpen} onImport={onImport} onChanged={refreshDetail} notify={notify} onExport={onExport}/></>;
 if(workId)return <div className="nc-library"><button className="text-link nc-back-link" onClick={()=>onSelectWork(undefined)}>{msg('← 我的漫画')}</button>{detailError?<p role="alert">{detailError}</p>:<p role="status">{msg('正在读取作品…')}</p>}</div>;
 return <div className="nc-library">
  <div className="nc-page-heading"><div><span className="nc-eyebrow">YOUR STORIES, YOUR PACE</span><h1 className="nc-shelf-title" aria-label={msg('我的漫画')}><span>{msg('我的漫画')}</span><span className="nc-profile-avatar nc-shelf-count" aria-label={msg('{0} 部作品',{'0':library.works.length})}>{library.works.length}</span></h1><p>{msg('保存喜欢的故事，随时继续上次阅读。')}</p></div><button className="button primary" onClick={()=>onImport()}><Icon name="plus"/>{msg('导入漫画')}</button></div>
  <div className="nc-library-tools nc-shelf-tools"><label className="nc-search"><Icon name="book" size={18}/><input type="search" aria-label={msg('搜索书架作品')} placeholder={msg('搜索书架作品')} value={search} onChange={event=>changeSearch(event.target.value)}/></label><label className="nc-sort-label">{msg('排序')}<Select aria-label={msg('作品排序')} value={sort} onChange={e=>changeSort(e.target.value)}><option value="updated">{msg('最近更新')}</option><option value="recent">{msg('最近阅读')}</option><option value="title">{msg('按名称')}</option></Select></label></div>
  {!library.works.length?<section className="nc-empty nc-import-empty"><span className="nc-empty-symbol">✦</span><h2>{msg('把喜欢的故事带进来')}</h2><p>{msg('添加本地文件或连接云盘；网站漫画通过网页内的导入按钮添加。')}</p><button className="button primary" onClick={()=>onImport()}>{msg('选择漫画文件')}</button><span className="nc-muted">CBZ / ZIP · CBR / RAR · PDF · MOBI · PNG / JPG / WEBP</span></section>:!matching.length?<div className="nc-empty nc-compact-empty"><h3>{msg('没有找到这部作品')}</h3><button className="text-link" onClick={()=>changeSearch('')}>{msg('清除搜索')}</button></div>:<ShelfGrid key={search+'|'+sort} works={matching} view={shelfView}>{item=><ShelfCard key={item.id} work={item} onSelect={()=>openWork(item.id)} onOpen={id=>{shelfView.current.scrollTop=window.scrollY;onOpen(id);}} menu={contextMenu.bind(item.title,[
    {label:msg('查看内容'),onSelect:()=>openWork(item.id)},
    {label:msg('添加内容'),onSelect:()=>onImport({workId:item.id,title:item.title,kind:'unclassified'})},
    {label:msg('编辑作品'),onSelect:()=>openWork(item.id,'work')},
    {label:msg('移除作品'),danger:true,onSelect:()=>openWork(item.id,'remove-work')},
   ])}/>}</ShelfGrid>}
  {contextMenu.menu}

 </div>;
}
