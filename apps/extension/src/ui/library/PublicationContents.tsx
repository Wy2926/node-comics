import {useEffect,useRef,useState} from 'react';
import {Icon} from '../../icons';
import type {Chapter,LibraryState,Publication} from '../../library/types';
import './publication-contents.css';

const relationTypes=[
 {kind:'collects',title:'合订收录',description:'这册合订了哪些卷册',icon:'layers'},
 {kind:'reprint',title:'再版来源',description:'这册由哪些卷册再版而来',icon:'refresh'},
] as const;
const chapterRole=(chapter:Chapter)=>chapter.role==='extra'?'番外':chapter.role==='main'?'正文':'章节';

function EmptyContents({icon,title,description}:{icon:string;title:string;description:string}){
 return <div className="nc-publication-empty"><span className="nc-publication-icon"><Icon name={icon}/></span><div><strong>{title}</strong><p>{description}</p></div></div>;
}

export function PublicationContents({publicationId,library:s,initiallyOpen=false,onEdit}:{publicationId:string;library:LibraryState;initiallyOpen?:boolean;onEdit:(kind:'inclusion'|'publicationRelations')=>void}){
 const [open,setOpen]=useState(initiallyOpen);
 const summary=useRef<HTMLElement>(null);
 useEffect(()=>{
  if(!initiallyOpen)return;
  const frame=requestAnimationFrame(()=>{summary.current?.focus({preventScroll:true});summary.current?.scrollIntoView({block:'start'});});
  return ()=>cancelAnimationFrame(frame);
 },[initiallyOpen]);
 const inclusions=s.inclusions.filter(i=>i.publicationId===publicationId).sort((a,b)=>a.order-b.order);
 const relations=s.publicationRelations.filter(r=>r.fromId===publicationId);
 const hasWorks=inclusions.some(i=>i.target.kind==='work');
 return <details className="nc-publication-contents" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary ref={summary}><span className="nc-publication-icon"><Icon name="layers"/></span><span className="nc-publication-summary"><strong>收录与卷册关联</strong><small>{inclusions.length||relations.length?`${inclusions.length} 项收录 · ${relations.length} 条卷册关联`:'整理这册的章节目录与出版关系'}</small></span><Icon name="chevron" className="nc-publication-chevron" size={18}/></summary>
  <div className="nc-publication-sections">
   <section className="nc-publication-section" aria-label={hasWorks?'收录内容':'收录章节'}>
    <header className="nc-publication-heading"><div><h3>{hasWorks?'收录内容':'收录章节'}<span className="nc-count-pill">{inclusions.length}</span></h3><p>按收录顺序查看这册的内容</p></div><button className="button secondary small" onClick={()=>onEdit('inclusion')}>编辑收录章节</button></header>
    {inclusions.length?<ol className="nc-inclusion-list">{inclusions.map((inclusion,index)=>{
     const chapter=inclusion.target.kind==='chapter'?s.chapters.find(c=>c.id===inclusion.target.id):undefined;
     const target=chapter??s.works.find(w=>inclusion.target.kind==='work'&&w.id===inclusion.target.id);
     return <li key={inclusion.id}><span className="nc-inclusion-number">{String(index+1).padStart(2,'0')}</span><strong>{target?.title??'收录内容已移除'}</strong><span className="nc-publication-tag">{chapter?chapterRole(chapter):'作品'}</span></li>;
    })}</ol>:<EmptyContents icon="list" title="尚未记录收录章节" description="已知这册的目录时，可通过“编辑收录章节”添加。"/>}
   </section>
   <section className="nc-publication-section" aria-label="卷册关联">
    <header className="nc-publication-heading"><div><h3>卷册关联<span className="nc-count-pill">{relations.length}</span></h3><p>记录这册与其他卷册的出版关系</p></div><button className="button secondary small" onClick={()=>onEdit('publicationRelations')}>编辑卷册关联</button></header>
    <div className="nc-publication-relation-grid">{relationTypes.map(type=>{
     const items=relations.filter(r=>r.kind===type.kind);
     return <section className="nc-publication-relation" key={type.kind} aria-label={type.title}>
      <header><Icon name={type.icon} size={17}/><h4>{type.title}</h4><span>{items.length} 册</span></header><p>{type.description}</p>
      {items.length?<ul>{items.map(relation=>{const book=s.publications.find(p=>p.id===relation.toId),series=s.series.find(item=>item.id===book?.seriesId);return <li key={relation.id}><span className="nc-publication-book-icon"><Icon name="book" size={18}/></span><div><strong>{book?.title??'关联卷册已移除'}</strong><small>{series?.title??'卷册'}</small></div></li>;})}</ul>:<div className="nc-publication-relation-empty">{type.kind==='collects'?'尚未关联合订卷册':'尚未关联再版来源'}</div>}
     </section>;
    })}</div>
   </section>
  </div>
 </details>;
}

export function PublicationChoices({kind,title,chapters,publications,checks,busy,onToggle}:{kind:'inclusion'|'publicationRelations';title:string;chapters:Chapter[];publications:Publication[];checks:Set<string>;busy:boolean;onToggle:(key:string)=>void}){
 const inclusion=kind==='inclusion',hasOptions=inclusion?chapters.length>0:publications.length>0;
 return <div className="nc-publication-editor">
  <div className="nc-publication-context"><span className="nc-publication-icon"><Icon name="book"/></span><div><small>正在整理的卷册</small><strong>{title}</strong></div></div>
  {!hasOptions?<EmptyContents icon={inclusion?'list':'layers'} title={inclusion?'暂无可选章节':'暂无可关联的卷册'} description={inclusion?'当前作品下还没有章节。请先导入章节，或在副本详情中纠正归属为本作品的章节，再回来添加收录。':'当前作品下没有其他卷册。请先导入其他卷册，或在副本详情中纠正归属为本作品的卷册，再回来关联。'}/>:inclusion?<section role="group" aria-label="可收录章节">
   <header className="nc-publication-choice-heading"><div><h3>选择收录章节</h3><p>仅选择这册实际收录的章节，可多选。</p></div><span className="nc-publication-tag">已选 {chapters.filter(c=>checks.has(c.id)).length} / {chapters.length}</span></header>
   <div className="nc-choice-grid">{chapters.map(c=><button className="nc-choice-card" aria-pressed={checks.has(c.id)} disabled={busy} onClick={()=>onToggle(c.id)} key={c.id}><span>{c.title}<small>{chapterRole(c)}</small></span><b><span className="nc-publication-check">{checks.has(c.id)&&<Icon name="check" size={13}/>}</span>{checks.has(c.id)?'已收录':'选择'}</b></button>)}</div>
  </section>:relationTypes.map(type=><section className="nc-publication-choice-section" key={type.kind} role="group" aria-label={type.title}>
   <header className="nc-publication-choice-heading"><div><h3><Icon name={type.icon} size={18}/>{type.title}</h3><p>{type.description}，可多选。</p></div><span className="nc-publication-tag">已选 {publications.filter(p=>checks.has(type.kind+':'+p.id)).length}</span></header>
   <div className="nc-choice-grid">{publications.map(p=>{const key=type.kind+':'+p.id;return <button className="nc-choice-card" key={key} aria-pressed={checks.has(key)} disabled={busy} onClick={()=>onToggle(key)}><span>{p.title}</span><b><span className="nc-publication-check">{checks.has(key)&&<Icon name="check" size={13}/>}</span>{checks.has(key)?'已关联':'选择'}</b></button>;})}</div>
  </section>)}
 </div>;
}
