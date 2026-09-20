import {msg} from '../i18n/runtime';
import {useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import type {ReadingDirectory} from '../library/directory';
import './directory.css';

export function ComicDirectory({directory,index,pageCount,onNavigate,onCatalog,children}:{directory:ReadingDirectory;index:number;pageCount:number;onNavigate:(id:string,pageId?:string)=>void;onCatalog?:()=>void;children:ReactNode}){
 const [tab,setTab]=useState<'contents'|'pages'>('contents'),[search,setSearch]=useState(''),[descending,setDescending]=useState(false);
 const current=directory.entries.find(e=>e.current);
 const list=useRef<HTMLDivElement>(null);
 const visible=useMemo(()=>{
  const entries=directory.entries.filter(e=>(e.title+' '+(e.number??'')).toLowerCase().includes(search.trim().toLowerCase()));
  return descending?entries.reverse():entries;
 },[directory.entries,search,descending]);
 const groups=[...new Set(visible.map(e=>e.group))];
 useLayoutEffect(()=>{const active=list.current?.querySelector<HTMLElement>('[aria-current="true"]');if(active&&list.current)list.current.scrollTop=Math.max(0,active.offsetTop-list.current.offsetTop-32);},[tab,descending]);
 return <>
  <div className="nc-comic-directory-heading"><span className="nc-eyebrow">{msg("正在阅读")}</span><h3>{directory.title}</h3><p>{current?.title}</p><div><span>{pageCount?msg("第 {0} / {1} 页", {"0": index+1, "1": pageCount}):msg("等待页面就绪")}</span><button className="text-link" disabled={!pageCount} onClick={()=>setTab('pages')}>{msg("定位本页")}</button></div></div>
  <div className="nc-directory-tabs" role="tablist" aria-label={msg("目录层级")}><button role="tab" aria-selected={tab==='contents'} onClick={()=>setTab('contents')}>{msg("作品目录")}<span>{directory.entries.length}</span></button><button role="tab" disabled={!pageCount} aria-selected={tab==='pages'} onClick={()=>setTab('pages')}>{msg("本话页面")}<span>{pageCount}</span></button></div>
  {tab==='pages'?children:<>
   <div className="nc-directory-search"><input type="search" aria-label={msg("搜索作品目录")} placeholder={msg("搜索章节、番外或卷册")} value={search} onChange={e=>setSearch(e.target.value)}/><button className="text-link" onClick={()=>setDescending(v=>!v)}>{descending?msg("倒序 ↓"):msg("正序 ↑")}</button></div>
   <div className="nc-chapter-list" ref={list} role="tabpanel" aria-label={msg("作品目录")}>
    {groups.map(group=><section key={group}><h4>{group}<span>{visible.filter(e=>e.group===group).length}</span></h4>{visible.filter(e=>e.group===group).map(entry=><button key={entry.id} className="nc-chapter-entry" aria-current={entry.current?'true':undefined} disabled={!entry.copyId} title={entry.error} onClick={()=>{if(entry.current){if(pageCount)setTab('pages');}else if(entry.copyId)onNavigate(entry.copyId,entry.pageId);}}><span className="nc-chapter-number">{entry.number??(entry.current?'●':'—')}</span><span className="nc-chapter-info"><b>{entry.title}</b><small>{msg("{0} / {1} 页可读", {"0": entry.available, "1": entry.total??'?'})}<span>·</span>{entry.status}</small>{entry.error&&<small className="nc-chapter-error">{entry.error}</small>}</span><span className={'nc-chapter-state '+(entry.current?'current':'')}>{entry.current?msg("阅读中"):entry.read?msg("已读"):entry.copyId?msg("未读"):msg("未添加")}</span></button>)}</section>)}
    {!visible.length&&<p className="nc-directory-empty">{msg("没有匹配的章节，试试其他名称或编号。")}</p>}
   </div>
   <div className="nc-directory-footer nc-catalog-hint"><p>{directory.entries.length===1?msg("目前仅添加了这一份内容。"):msg("展示已添加的内容，未采集的章节也可打开继续采集。")}{directory.catalogCount>0&&msg(" 来源目录已发现 {0} 个条目。", {"0": directory.catalogCount})}</p>{onCatalog&&<button className="button secondary full" onClick={onCatalog}>{msg("查看来源目录 · 添加章节")}</button>}</div>
  </>}
 </>;
}
