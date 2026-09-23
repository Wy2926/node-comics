import {useEffect,useState,type HTMLAttributes} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {Thumbnail} from '../reader/Images';
import {continueDocument,coverReference,loadShelfCards,type Work} from '../comics/application/library-service';
import type {LibraryViewModel} from '../comics/application/types';
import {SourceTag} from './SourceTag';

export function ShelfCard({work,onSelect,onOpen,menu}:{work:Work;onSelect:()=>void;onOpen:(id:string)=>void;menu:HTMLAttributes<HTMLElement>}){
 const [details,setDetails]=useState<LibraryViewModel>(),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{
  let active=true;setError('');
  // Scrolling past a card within one frame must not start loading its document tree.
  const timer=setTimeout(()=>void loadShelfCards([work]).then(value=>{if(active)setDetails(value);}).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:msg('操作失败，请重试。'));}),60);
  return()=>{active=false;clearTimeout(timer);};
 },[work,retry]);
 const units=details?.units??[],docs=details?.documents??[],doc=details&&continueDocument(work.id,details);
 const cover=docs.find(value=>value.id===work.cover?.documentId&&value.revisionId===work.cover.revisionId)??doc;
 const readable=doc&&(doc.indexState==='ready'||doc.format==='website');
 return <article className="nc-book" data-work-id={work.id} aria-busy={!details&&!error} {...menu}>
  <button className="nc-book-cover" aria-label={msg('打开作品 {0}',{'0':work.title})} onClick={onSelect}>
   <Thumbnail blobKey={cover&&coverReference(cover)} alt={msg('{0}封面',{'0':work.title})}/>
   {details?<><span className="nc-cover-topline"><span className="nc-cover-tag">{msg('{0} 个阅读单元',{'0':units.length})}</span></span><span className="nc-cover-details"><SourceTag sources={details.workSources?.[work.id]}/><span className="nc-cover-tag"><Icon name="layers" size={13}/>{msg('{0} 个版本',{'0':work.documentCount??docs.length})}</span><span className="nc-cover-reading">{work.lastReadAt?msg('最近阅读')+' '+new Date(work.lastReadAt).toLocaleDateString():msg('还没阅读')}</span></span></>:<span className="nc-cover-details"><span className="nc-cover-tag">{error?msg('操作失败，请重试。'):msg('正在读取作品…')}</span></span>}
  </button>
  <div className="nc-library-card-body"><h2 className="nc-card-title"><button onClick={onSelect}>{work.title}</button></h2><div className="nc-library-card-actions"><button className="button primary small" title={error||undefined} disabled={!details&&!error} onClick={()=>error?setRetry(value=>value+1):readable?onOpen(doc.id):onSelect()}>{error?msg('重试'):readable?work.lastReadAt?msg('继续阅读'):msg('开始阅读'):msg('查看内容')}</button></div></div>
 </article>;
}
