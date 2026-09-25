import {msg} from '../i18n/runtime';
import {useEffect,useId,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import type {ReadingDirectory,DirectoryEntry,DirectoryChapter,DirectoryGroup} from '../comics/application/library-service';
import {Icon} from '../icons';
import {LanguageFlag} from '../ui/LanguageFlag';
import './directory.css';

export function contentLanguageLabel(language:string){try{return new Intl.DisplayNames([language],{type:'language'}).of(language)??language;}catch{return language;}}
const releaseLabel=(entry:DirectoryEntry)=>[entry.contentLanguage&&contentLanguageLabel(entry.contentLanguage),...entry.tags].filter(Boolean).join(' · ');
export function matchesDirectoryChapter(chapter:DirectoryChapter,entries:Map<string,DirectoryEntry>,query:string){
 const value=query.trim().toLocaleLowerCase();
 return !value||chapter.title.toLocaleLowerCase().includes(value)||chapter.entryIds.some(id=>{const entry=entries.get(id);return entry&&(entry.title+' '+releaseLabel(entry)).toLocaleLowerCase().includes(value);});
}

/** A source reading position is one row; its publications remain explicit, secondary choices. */
export function ComicDirectory({directory,index,pageCount,onNavigate,children}:{directory:ReadingDirectory;index:number;pageCount:number;onNavigate:(id:string,pageId?:string,rememberChoice?:boolean)=>void;children?:ReactNode}){
 const directoryId=useId();
 const [tab,setTab]=useState<'contents'|'pages'>(directory.entries.length===1&&pageCount?'pages':'contents'),[search,setSearch]=useState(''),[descending,setDescending]=useState(false),[limit,setLimit]=useState(200);
 const [expanded,setExpanded]=useState(()=>new Set(directory.chapters.filter(chapter=>chapter.current).map(chapter=>chapter.id))),[searchCollapsed,setSearchCollapsed]=useState(new Set<string>());
 const singleFile=!directory.sourceUrl&&directory.entries.length===1;
 const list=useRef<HTMLDivElement>(null),query=search.trim().toLocaleLowerCase();
 const entries=useMemo(()=>new Map(directory.entries.map(entry=>[entry.id,entry])),[directory.entries]);
 const visible=useMemo(()=>{const chapters=directory.chapters.filter(chapter=>matchesDirectoryChapter(chapter,entries,query));return descending?chapters.reverse():chapters;},[directory.chapters,entries,query,descending]);
 const currentIndex=visible.findIndex(chapter=>chapter.current),currentId=visible[currentIndex]?.id,currentEntryId=directory.entries.find(entry=>entry.current)?.id;
 const shownLimit=Math.max(limit,Math.ceil((currentIndex+1)/200)*200),shown=visible.slice(0,shownLimit);
 useEffect(()=>{if(currentId)setExpanded(previous=>previous.has(currentId)?previous:new Set([...previous,currentId]));},[currentId,currentEntryId]);
 const state=(entry:DirectoryEntry,current=entry.current)=><span className={'nc-chapter-state '+(current?'current':entry.read?'read':'unread')}>
  <Icon name={current?'bookmark':entry.read?'page-read':'page-unread'} size={16}/>
  <span>{current?msg('阅读中'):entry.read?msg('已读'):msg('未读')}</span>
 </span>;
 const problem=(entry:DirectoryEntry)=>entry.sourceRemoved?msg('源站已移除，缓存页面仍可阅读。'):entry.error||(!entry.readable?entry.status:undefined);
 const row=(chapter:DirectoryChapter)=>{
  const selected=entries.get(chapter.selectedEntryId);if(!selected)return null;
  const candidates=chapter.entryIds.flatMap(id=>{const entry=entries.get(id);return entry?[entry]:[];}),multiple=candidates.length>1,open=multiple&&(expanded.has(chapter.id)||!!query&&!searchCollapsed.has(chapter.id));
  const releasesId=`${directoryId}-${encodeURIComponent(chapter.id)}`;
  return <div key={chapter.id} className="nc-directory-chapter" data-reading-slot={chapter.id} data-current={chapter.current||undefined}>
   <div className="nc-directory-chapter-main">
    <button className="nc-chapter-entry" data-chapter-main="true" data-entry-id={selected.id} disabled={!chapter.readable} aria-current={chapter.current?'true':undefined} title={selected.error} onClick={()=>{if(chapter.current&&pageCount)setTab('pages');else onNavigate(selected.id,undefined,false);}}>
     <span className="nc-chapter-info"><b>{chapter.title}</b>
      <span className="nc-chapter-meta">
       {selected.contentLanguage&&<span className="nc-chapter-language"><LanguageFlag language={selected.contentLanguage}/><span>{contentLanguageLabel(selected.contentLanguage)}</span></span>}
       {state(selected,chapter.current)}
      </span>
      {problem(selected)&&<small className="nc-chapter-error">{problem(selected)}</small>}
     </span>
    </button>
    {multiple&&<button className="nc-chapter-expand" aria-label={open?msg('收起章节选项'):msg('展开章节选项')} title={open?msg('收起章节选项'):msg('展开章节选项')} aria-expanded={open} aria-controls={open?releasesId:undefined} onClick={()=>{setExpanded(previous=>{const next=new Set(previous);if(open)next.delete(chapter.id);else next.add(chapter.id);return next;});if(query)setSearchCollapsed(previous=>{const next=new Set(previous);if(open)next.add(chapter.id);else next.delete(chapter.id);return next;});}}><span aria-hidden="true">{candidates.length}</span><Icon name="chevron" size={14}/></button>}
   </div>
   {open&&<div className="nc-chapter-releases" id={releasesId}>{candidates.map(entry=><button key={entry.id} className="nc-chapter-entry" data-entry-id={entry.id} data-release-choice="true" disabled={!entry.readable} aria-pressed={entry.id===chapter.selectedEntryId} title={entry.title} onClick={()=>onNavigate(entry.id,undefined,true)}>
    {entry.contentLanguage&&<span className="nc-release-flag"><LanguageFlag language={entry.contentLanguage}/></span>}
    <span className="nc-chapter-info"><span className="nc-release-heading"><b>{entry.contentLanguage?contentLanguageLabel(entry.contentLanguage):entry.tags.join(' · ')||entry.title}</b>
     {!problem(entry)&&entry.total!=null&&<span className="nc-release-pages">{msg('{0} 页',{'0':entry.total})}</span>}
    </span>
     {entry.contentLanguage&&!!entry.tags.length&&<small className="nc-release-tags">{entry.tags.join(' · ')}</small>}
     {problem(entry)&&<small className="nc-chapter-error">{problem(entry)}</small>}
    </span>
   </button>)}</div>}
  </div>;
 };
 const group=(item:DirectoryGroup,depth=0):ReactNode=>{if(depth>8)return null;const children=directory.groups.filter(group=>group.parentId===item.id).map(child=>group(child,depth+1)).filter(Boolean),chapters=shown.filter(chapter=>chapter.groupIds.includes(item.id));if(!chapters.length&&!children.length)return null;return <details key={item.id} className="nc-source-group"><summary><Icon name="chevron" size={15}/><span className="nc-source-group-title">{item.title}</span><span className="nc-source-group-count">{directory.chapters.filter(chapter=>chapter.groupIds.includes(item.id)).length}</span></summary>{chapters.map(row)}{children}</details>;};
 const groupLayout=JSON.stringify(directory.groups),currentExpanded=!!currentId&&expanded.has(currentId);
 useLayoutEffect(()=>{
  const container=list.current,active=container?.querySelector<HTMLElement>('[aria-current="true"]');if(!container||!active||tab!=='contents')return;
  let parent=active.parentElement;while(parent&&parent!==container){if(parent.tagName==='DETAILS')(parent as HTMLDetailsElement).open=true;parent=parent.parentElement;}
  const bounds=container.getBoundingClientRect(),row=active.getBoundingClientRect();container.scrollTop+=row.top-bounds.top-container.clientTop-(container.clientHeight-row.height)/2;
 },[tab,currentId,currentEntryId,currentIndex,query,descending,groupLayout,currentExpanded]);
 return <><div className="nc-comic-directory-heading"><h3>{directory.title}</h3>{directory.sourceUrl&&<a className="text-link nc-directory-source" href={directory.sourceUrl} target="_blank" rel="noreferrer">{msg('打开来源')}</a>}</div>
  {!!pageCount&&!singleFile&&<div className="nc-directory-tabs" role="tablist" aria-label={msg('目录')}><button role="tab" aria-selected={tab==='contents'} onClick={()=>setTab('contents')}>{msg('目录')}<span>{directory.chapters.length}</span></button><button role="tab" aria-selected={tab==='pages'} onClick={()=>setTab('pages')}>{msg('页面')}<span>{pageCount}</span></button></div>}
  {(singleFile||tab==='pages')&&pageCount?<><p className="nc-directory-intro">{msg('第 {0} / {1} 页',{'0':index+1,'1':pageCount})}</p>{children}</>:<><div className="nc-directory-search"><input type="search" aria-label={msg('搜索目录')} placeholder={msg('搜索目录')} value={search} onChange={event=>{setSearch(event.target.value);setSearchCollapsed(new Set());setLimit(200);}}/><button className="text-link" onClick={()=>setDescending(value=>!value)}>{descending?msg('倒序 ↓'):msg('正序 ↑')}</button></div><div className="nc-chapter-list" ref={list} role="tabpanel" aria-label={msg('目录')}>{query?shown.map(row):<>{directory.groups.filter(group=>!group.parentId).map(item=>group(item))}{shown.filter(chapter=>!chapter.groupIds.length).map(row)}</>}{!visible.length&&<p className="nc-directory-empty">{msg('没有匹配的内容')}</p>}{visible.length>shownLimit&&<button className="button secondary" onClick={()=>setLimit(shownLimit+200)}>{msg('显示更多')}</button>}</div></>}
  {!!directory.related?.length&&<div className="nc-directory-footer">{directory.related.map(item=><p key={item.id}><a href={item.url} target="_blank" rel="noreferrer">{item.title} ↗</a></p>)}</div>}
 </>;
}
