import {useEffect,useRef,useState} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {Thumbnail} from '../reader/Images';
import {continueDocument,coverReference,loadWorkDetails,type Document} from '../comics/application/library-service';
import type {ImportAssignment,LibraryViewModel} from '../comics/application/types';
import {WorkDetails} from './WorkDetails';

type Props={library:LibraryViewModel;workId?:string;onSelectWork:(id?:string)=>void;onOpen:(id:string)=>void;onImport:(assignment?:ImportAssignment)=>void;onChanged:()=>void|Promise<void>;notify:(message:string)=>void;onNext:()=>void;onPrevious:()=>void;onExport:(doc:Document)=>void;offset:number};
export function Library({library,workId,onSelectWork,onOpen,onImport,onChanged,notify,onNext,onPrevious,onExport,offset}:Props){
 const [search,setSearch]=useState(''),[sort,setSort]=useState('updated');
 const [details,setDetails]=useState<LibraryViewModel>(),[detailError,setDetailError]=useState('');
 const selectedWork=useRef(workId),detailEpoch=useRef(0);selectedWork.current=workId;
 useEffect(()=>{let active=true;const request=++detailEpoch.current;setDetailError('');if(!workId){setDetails(undefined);return;}void loadWorkDetails(workId).then(value=>{if(active&&request===detailEpoch.current&&selectedWork.current===workId){setDetails(value);if(!value)setDetailError(msg('作品已移除。'));}}).catch(reason=>{if(active&&request===detailEpoch.current)setDetailError(reason instanceof Error?reason.message:msg('操作失败，请重试。'));});return()=>{active=false;};},[workId,library]);
 const work=details?.works.find(value=>value.id===workId);
 const matching=library.works.filter(value=>(value.title+' '+(value.aliases??[]).join(' ')).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a,b)=>sort==='title'?a.title.localeCompare(b.title,undefined,{numeric:true}):sort==='recent'?(b.lastReadAt??0)-(a.lastReadAt??0):b.updatedAt-a.updatedAt);
 const refreshDetail=async()=>{await onChanged();if(!workId||selectedWork.current!==workId)return;const request=++detailEpoch.current,value=await loadWorkDetails(workId);if(request===detailEpoch.current&&selectedWork.current===workId)setDetails(value);};
 if(work&&details)return <>{detailError&&<p className="error-message" role="alert">{detailError}</p>}<WorkDetails key={work.id} work={work} library={details} onBack={()=>onSelectWork(undefined)} onOpen={onOpen} onImport={onImport} onChanged={refreshDetail} notify={notify} onExport={onExport}/></>;
 if(workId)return <div className="nc-library"><button className="text-link nc-back-link" onClick={()=>onSelectWork(undefined)}>{msg('← 我的漫画')}</button>{detailError?<p role="alert">{detailError}</p>:<p role="status">{msg('正在读取作品…')}</p>}</div>;
 return <div className="nc-library">
  <div className="nc-page-heading"><div><span className="nc-eyebrow">YOUR STORIES, YOUR PACE</span><h1>{msg('我的漫画')}</h1><p>{msg('保存喜欢的故事，随时继续上次阅读。')}</p></div><button className="button primary" onClick={()=>onImport()}><Icon name="plus"/>{msg('导入漫画')}</button></div>
  <div className="nc-library-tools nc-shelf-tools"><label className="nc-search"><Icon name="book" size={18}/><input type="search" aria-label={msg('搜索当前页作品')} placeholder={msg('搜索当前页作品')} value={search} onChange={event=>setSearch(event.target.value)}/></label><label className="nc-sort-label">{msg('排序')}<select value={sort} onChange={e=>setSort(e.target.value)}><option value="updated">{msg('最近更新')}</option><option value="recent">{msg('最近阅读')}</option><option value="title">{msg('按名称')}</option></select></label><span className="nc-muted">{msg('第 {0} 页 · {1} 部作品',{'0':Math.floor(offset/48)+1,'1':library.works.length})}</span></div>
  {!library.works.length?<section className="nc-empty nc-import-empty"><span className="nc-empty-symbol">✦</span><h2>{msg('把喜欢的故事带进来')}</h2><p>{msg('添加本地文件或连接云盘；网站漫画通过网页内的导入按钮添加。')}</p><button className="button primary" onClick={()=>onImport()}>{msg('选择漫画文件')}</button><span className="nc-muted">CBZ / ZIP · CBR / RAR · PDF · MOBI · PNG / JPG / WEBP</span></section>:!matching.length?<div className="nc-empty nc-compact-empty"><h3>{msg('当前页没有找到这部作品')}</h3><button className="text-link" onClick={()=>setSearch('')}>{msg('清除搜索')}</button></div>:<div className="nc-books grid nc-shelf-grid">{matching.map(item=>{
   const units=library.units.filter(unit=>unit.workId===item.id),owned=new Set(units.map(u=>u.id)),docs=library.documents.filter(doc=>owned.has(doc.unitId));
   const doc=continueDocument(item.id,library),coverDoc=docs.find(d=>d.id===item.cover?.documentId&&d.revisionId===item.cover.revisionId)??doc;
   const readable=doc&&(doc.indexState==='ready'||doc.format==='website');
   return <article className="nc-book" key={item.id}><button className="nc-book-cover" aria-label={msg('打开作品 {0}',{'0':item.title})} onClick={()=>onSelectWork(item.id)}><Thumbnail blobKey={coverDoc&&coverReference(coverDoc)} alt={msg('{0}封面',{'0':item.title})}/><span className="nc-cover-topline"><span className="nc-cover-tag">{msg('{0} 个阅读单元',{'0':units.length})}</span></span><span className="nc-cover-details"><span className="nc-cover-tag"><Icon name="layers" size={13}/>{msg('{0} 个版本',{'0':docs.length})}</span><span className="nc-cover-reading">{item.lastReadAt?msg('最近阅读')+' '+new Date(item.lastReadAt).toLocaleDateString():msg('还没阅读')}</span></span></button><div className="nc-library-card-body"><h2 className="nc-card-title"><button onClick={()=>onSelectWork(item.id)}>{item.title}</button></h2><div className="nc-library-card-actions"><button className="button primary small" onClick={()=>readable?onOpen(doc.id):onSelectWork(item.id)}>{readable?item.lastReadAt?msg('继续阅读'):msg('开始阅读'):msg('查看内容')}</button></div></div></article>;
  })}</div>}
  <nav className="nc-card-actions" aria-label={msg('书架分页')}><button className="button secondary" disabled={offset===0} onClick={()=>{setSearch('');onPrevious();}}>{msg('上一页')}</button><button className="button secondary" disabled={library.nextOffset===undefined} onClick={()=>{setSearch('');onNext();}}>{msg('下一页')}</button></nav>
 </div>;
}
