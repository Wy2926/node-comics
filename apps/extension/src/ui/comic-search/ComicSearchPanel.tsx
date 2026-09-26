import {useEffect,useId,useLayoutEffect,useRef,useState,useSyncExternalStore,type KeyboardEvent} from 'react';
import type {Api} from '../../api';
import {Icon} from '../../icons';
import {formatDate,msg} from '../../i18n/runtime';
import {fallbackLanguages,languageLabel} from '../../types';
import {Thumbnail} from '../../reader/Images';
import {listSearchSites,listSupportedSites,releaseSourceSearchSession,searchSource,type SourceSearchResult} from '../../sources';
import {ComicSearchSession,comicSearchSourceKey} from '../../comics/application/search/session';
import type {SearchSeed,SearchSiteState} from '../../comics/application/search/types';
import {requestedTitleLanguage} from '../../comics/application/search/title-resolver';
import {Select,SelectOption} from '../Select';
import {SearchResultCover,searchResultCoverKey} from './SearchResultCover';
import './comic-search.css';

export interface ComicSearchPanelProps {
  open:boolean;
  seed:SearchSeed;
  api:Api;
  defaultLanguage:string;
  onClose:()=>void;
  onLogin?:()=>void;
  onImportHit:(hit:SourceSearchResult)=>Promise<void>|void;
  existingSourceKeys?:ReadonlySet<string>;
  currentIdentity?:{sourceId:string;catalogId:string};
  onLanguageChange?:(language:string)=>void;
}
const searchLanguageLabel=(language:string)=>language==='zh'?msg('中文'):languageLabel(language);
const waitSeconds=(until:number|undefined,now:number)=>until?Math.max(0,Math.ceil((until-now)/1000)):0;
function stateLabel(state:SearchSiteState){
  switch(state.status){
    case 'queued':return msg('等待搜索');
    case 'running':return msg('搜索中');
    case 'ready':return msg('{0} 个候选',{'0':state.resultCount});
    case 'empty':return msg('未找到');
    case 'error':return state.error?.kind==='rate-limit'?msg('请求受限'):state.error?.kind==='timeout'?msg('搜索超时'):msg('搜索失败');
    case 'stopped':return msg('已停止');
    default:return msg('尚未搜索');
  }
}
function resultLanguages(hit:SourceSearchResult){
  return hit.contentLanguages?.map(searchLanguageLabel).join(' / ');
}

/** Keep mounted with open=false for page-local results; root changes key at comic/auth/API scope boundaries. */
export function ComicSearchPanel({open,seed,api,defaultLanguage,onClose,onLogin,onImportHit,existingSourceKeys,currentIdentity,onLanguageChange}:ComicSearchPanelProps){
  const [session]=useState(()=>new ComicSearchSession(seed,{translateTitle:(name,language,signal)=>api.translateComicTitle(name,language,signal),listSites:listSearchSites,search:searchSource,release:releaseSourceSearchSession},defaultLanguage));
  const snapshot=useSyncExternalStore(session.subscribe,session.getSnapshot),dialog=useRef<HTMLDialogElement>(null),closeRef=useRef<HTMLButtonElement>(null),queryRef=useRef<HTMLInputElement>(null),sourceRef=useRef<HTMLInputElement>(null);
  const coverCache=useRef(new Map<string,string>()),titleId=useId(),queryHelpId=useId();
  const [query,setQuery]=useState(snapshot.query),[manual,setManual]=useState(false),[siteFilter,setSiteFilter]=useState(''),[clock,setClock]=useState(Date.now()),[reopened,setReopened]=useState(false),[importing,setImporting]=useState<string>(),[importErrors,setImportErrors]=useState<Record<string,string>>({});
  const wasOpened=useRef(false);
  useEffect(()=>setQuery(snapshot.query),[snapshot.query]);
  useEffect(()=>{const retained=new Set(snapshot.results.map(hit=>searchResultCoverKey(hit.coverHit??hit)));for(const [key,url] of coverCache.current)if(!retained.has(key)){URL.revokeObjectURL(url);coverCache.current.delete(key);}},[snapshot.results]);
  useEffect(()=>{if(!open)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[open]);
  useEffect(()=>()=>{session.dispose();coverCache.current.forEach(url=>URL.revokeObjectURL(url));coverCache.current.clear();},[session]);
  useLayoutEffect(()=>{
    if(!open){session.stop();return;}
    const element=dialog.current,previous=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
    setReopened(wasOpened.current&&!!session.getSnapshot().searchedAt);wasOpened.current=true;
    element?.showModal();closeRef.current?.focus({preventScroll:true});
    return()=>{session.stop();element?.close();queueMicrotask(()=>{if(previous?.isConnected&&!previous.closest('[inert]'))previous.focus({preventScroll:true});});};
  },[open,session]);
  useEffect(()=>{setSiteFilter('');setImportErrors({});},[snapshot.requestedTitleLanguage,snapshot.sourceTitle]);
  if(!open)return null;

  const selected=snapshot.sites.filter(state=>state.selected);
  const unsupported=listSupportedSites().filter(site=>!snapshot.sites.some(state=>state.site.key===site.key));
  const returned=selected.filter(state=>state.status==='ready'||state.status==='empty').length,failed=selected.filter(state=>state.status==='error').length;
  const permissionError=selected.find(state=>state.error?.kind==='permission')?.error;
  const active=snapshot.phase==='searching'||snapshot.phase==='resolving-name';
  const titleWait=waitSeconds(snapshot.titleRetryAt,clock);
  const results=snapshot.results.filter(hit=>!siteFilter||snapshot.sites.find(state=>state.site.key===siteFilter)?.resultKeys.includes(hit.key));
  const queryShown=manual||snapshot.titleState!=='idle'||snapshot.phase==='needs-query'||!!snapshot.query;
  const sourceCover=seed.cover?.url&&/^(?:blob:|data:image\/|chrome-extension:|moz-extension:)/.test(seed.cover.url)?seed.cover.url:undefined;
  const close=()=>{session.stop();onClose();};
  const submitManual=()=>{setReopened(false);setSiteFilter('');session.searchManual(query);};
  const automatic=()=>{setReopened(false);setSiteFilter('');void session.searchWithTranslatedTitle();};
  const useOriginal=()=>{setManual(true);setQuery(snapshot.sourceTitle);setReopened(false);setSiteFilter('');session.searchManual(snapshot.sourceTitle);};
  const importHit=(hit:SourceSearchResult)=>{
    setImporting(hit.key);setImportErrors(errors=>({...errors,[hit.key]:''}));
    let operation:Promise<void>|void;
    try{operation=onImportHit(hit);}catch(error){operation=Promise.reject(error);}
    void Promise.resolve(operation).catch(error=>setImportErrors(errors=>({...errors,[hit.key]:error instanceof Error?error.message:msg('导入失败，请重试。')}))).finally(()=>setImporting(undefined));
  };
  const keyDown=(event:KeyboardEvent<HTMLDialogElement>)=>{
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key!=='Tab')return;
    const elements=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),summary,[tabindex="0"]')??[]).filter(element=>element.getClientRects().length>0);
    const first=elements[0],last=elements[elements.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  };
  const siteOption=(state:SearchSiteState)=><label className="nc-search-site-option" key={state.site.key}>
    <input type="checkbox" checked={state.selected} disabled={!!importing} onChange={event=>{setReopened(false);session.setSelected(state.site.key,event.target.checked);}}/>
    <span><b>{state.site.name}</b></span>
  </label>;

  return <dialog ref={dialog} className="nc-comic-search" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();event.stopPropagation();close();}} onKeyDown={keyDown} onClick={event=>{if(event.target===event.currentTarget){const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();}}}>
    <header className="nc-search-header"><div><Icon name="globe" size={24}/><h2 id={titleId}>{msg('寻找其他语言')}</h2></div><button ref={closeRef} className="icon-button" aria-label={msg('关闭查找面板')} onClick={close}><Icon name="close"/></button><p>{msg('翻译漫画名称，或直接输入名称搜索所选网站。')}</p></header>
    <div className="nc-search-body">
      <section className="nc-search-origin"><div className="nc-search-origin-cover">{seed.coverKey?<Thumbnail blobKey={seed.coverKey}/>:sourceCover?<img src={sourceCover} alt=""/>:<Icon name="book" size={25}/>}</div><label><span>{msg('原作品名称')} <small>{msg('仅用于本次查找')}</small></span><input ref={sourceRef} disabled={!!importing} value={snapshot.sourceTitle} onChange={event=>{setReopened(false);session.setSourceTitle(event.target.value);}} placeholder={msg('请输入漫画作品名称')}/><small>{seed.sourceName??msg('当前作品')}</small></label></section>
      <div className="nc-search-conditions"><label><span>{msg('名称目标语言')}</span><Select disabled={!!importing} value={snapshot.requestedTitleLanguage} onChange={event=>{setReopened(false);session.setTargetLanguage(event.target.value);onLanguageChange?.(event.target.value);}} aria-label={msg('名称目标语言')}><SelectOption value="zh">{msg('中文')}</SelectOption>{fallbackLanguages.map(language=><SelectOption key={language.id} value={language.id}>{language.label}</SelectOption>)}</Select></label><button className="button primary" disabled={!!importing||!selected.length||titleWait>0||snapshot.phase==='resolving-name'} onClick={automatic}><Icon name={active?'refresh':'globe'} size={18}/>{titleWait?msg('{0} 秒后重试',{'0':titleWait}):msg('翻译名称并搜索')}</button></div>
      <details className="nc-search-sites"><summary><span>{msg('已选 {0} 个网站',{'0':selected.length})}</span><span>{msg('调整网站')} <Icon name="chevron" size={14}/></span></summary><p>{msg('各网站仅按搜索名称查询，不按内容语言筛选。')}</p><div className="nc-search-site-options">{snapshot.sites.map(siteOption)}</div>{!!unsupported.length&&<details className="nc-search-unsupported"><summary>{msg('{0} 个网站尚未开放搜索',{'0':unsupported.length})}</summary><p>{unsupported.map(site=>site.name).join(' · ')}</p></details>}</details>
      {permissionError&&<p className="nc-search-notice" role="alert">{permissionError.message}</p>}
      {!selected.length&&<p className="nc-search-notice" role="status">{msg('请先选择至少一个可搜索的网站。')}</p>}
      {snapshot.phase==='resolving-name'&&<p className="nc-search-resolving" role="status"><span className="spinner"/>{msg('正在查找常用{0}名称…',{'0':searchLanguageLabel(snapshot.requestedTitleLanguage)})}</p>}
      {!queryShown&&<button className="nc-search-text-button" onClick={()=>{setManual(true);requestAnimationFrame(()=>queryRef.current?.focus());}}>{msg('已有名称，直接输入搜索')}</button>}
      {queryShown&&<section className="nc-search-query"><div><label htmlFor={queryHelpId+'-input'}>{msg('搜索名称')}</label><button className="nc-search-text-button" disabled={!!importing||!snapshot.sourceTitle.trim()||!selected.length} onClick={useOriginal}>{msg('使用原名搜索')}</button></div><form onSubmit={event=>{event.preventDefault();submitManual();}}><input ref={queryRef} disabled={!!importing} id={queryHelpId+'-input'} value={query} onChange={event=>setQuery(event.target.value)} placeholder={msg('输入漫画名称或别名')} aria-describedby={queryHelpId}/><button className="button secondary small" disabled={!!importing||!query.trim()||!selected.length}>{snapshot.searchedAt?msg('重新搜索'):msg('搜索网站')}</button></form><p id={queryHelpId}>{snapshot.titleState==='missing'?msg('未找到常用{0}名称，请手动输入或明确使用原名搜索。',{'0':searchLanguageLabel(snapshot.requestedTitleLanguage)}):snapshot.resolvedTitleLanguage&&snapshot.resolvedTitleLanguage!==requestedTitleLanguage(snapshot.requestedTitleLanguage)?msg('名称语言为{0}，将使用此名称搜索。',{'0':searchLanguageLabel(snapshot.resolvedTitleLanguage)}):msg('可以修改搜索名称，不会更改作品资料。')}</p>{snapshot.titleError&&<div className="nc-search-inline-error" role="status"><span>{snapshot.titleError.message}</span>{titleWait>0&&<span>{msg('{0} 秒后可重试',{'0':titleWait})}</span>}{snapshot.titleError.kind==='login'&&onLogin&&<button className="nc-search-text-button" onClick={onLogin}>{msg('登录')}</button>}</div>}</section>}
      {snapshot.searchedAt&&<section className="nc-search-results"><div className="nc-search-result-heading"><h3>{msg('搜索结果')} <span>{msg('{0} 个候选',{'0':snapshot.results.length})}</span></h3>{active&&<button className="nc-search-text-button" onClick={()=>session.stop()}>{msg('停止查找')}</button>}</div><div className="nc-search-progress" role="status">{snapshot.phase==='stopped'?msg('已停止，保留已找到的 {0} 个候选',{'0':snapshot.results.length}):msg('{0}/{1} 个网站已返回',{'0':returned,'1':selected.length})}{failed>0&&<span>{msg('{0} 个网站失败',{'0':failed})}</span>}{reopened&&<time dateTime={new Date(snapshot.searchedAt).toISOString()}>{msg('上次查找：{0}',{'0':formatDate(snapshot.searchedAt,true)})}</time>}</div>
        <div className="nc-search-status-list">{selected.map(state=>{const wait=waitSeconds(state.error?.retryAt,clock);return <details key={state.site.key} className={'nc-search-status is-'+state.status}><summary><span className="nc-search-status-dot"/><b>{state.site.name}</b><span>{stateLabel(state)}</span><Icon name="chevron" size={13}/></summary><div className="nc-search-status-detail">{state.error&&state.error.kind!=='permission'&&<p>{state.error.message}</p>}{['error','stopped'].includes(state.status)?<button className="button secondary small" disabled={wait>0} onClick={()=>session.retrySite(state.site.key)}>{wait?msg('{0} 秒后重试',{'0':wait}):msg('重试此网站')}</button>:null}{state.nextCursor&&<button className="button secondary small" disabled={state.status==='running'||state.status==='queued'||wait>0} onClick={()=>session.loadMore(state.site.key)}>{msg('加载更多')}</button>}{state.nextCursor&&<small>{msg('还有更多结果')}</small>}<button className="nc-search-text-button" onClick={()=>setSiteFilter(value=>value===state.site.key?'':state.site.key)}>{msg('查看此网站结果')}</button><a href={state.site.url} target="_blank" rel="noopener noreferrer">{msg('打开来源')} <Icon name="external" size={12}/></a></div></details>;})}</div>
        {siteFilter&&<div className="nc-search-result-filters"><button className="nc-search-text-button" onClick={()=>setSiteFilter('')}>{msg('显示全部网站')}</button></div>}
        <div className="nc-search-result-list">{results.map(hit=>{const sourceKey=comicSearchSourceKey(hit.sourceId,hit.catalogId),current=!!currentIdentity&&sourceKey===comicSearchSourceKey(currentIdentity.sourceId,currentIdentity.catalogId),existing=existingSourceKeys?.has(sourceKey),site=snapshot.sites.find(state=>state.site.adapterId===hit.sourceId&&state.site.id===hit.siteId);return <article className="nc-search-result" key={hit.key}><SearchResultCover hit={hit.coverHit??hit} cache={coverCache.current}/><div className="nc-search-result-main"><h4>{hit.title}</h4><p className="nc-search-result-author">{hit.authors?.length?msg('作者：{0}',{'0':hit.authors.join(' / ')}):msg('作者待确认')}</p><div className="nc-search-result-tags"><span>{site?.site.name??hit.sourceId}</span>{!!hit.contentLanguages?.length&&<span className="nc-search-result-languages">{resultLanguages(hit)}</span>}{current?<span>{msg('当前漫画')}</span>:existing?<span>{msg('已在书架')}</span>:null}</div><div className="nc-search-result-bottom"><small>{hit.latestLabel??msg('章节信息以来源网站为准')}</small><div><a className="button secondary small" href={hit.catalogUrl} target="_blank" rel="noopener noreferrer">{msg('打开来源')}<Icon name="external" size={12}/></a><button className="button primary small" disabled={current||!!importing} onClick={()=>importHit(hit)}>{importing===hit.key?msg('正在打开…'):current?msg('当前漫画'):existing?msg('继续阅读'):msg('导入并阅读')}</button></div></div>{importErrors[hit.key]&&<p className="nc-search-inline-error" role="alert">{importErrors[hit.key]}</p>}</div></article>;})}</div>
        {!results.length&&<div className="nc-search-empty"><Icon name={active?'clock':'globe'} size={30}/><h3>{active?msg('各网站正在独立查找'):snapshot.results.length?msg('当前筛选下没有候选'):failed?msg('尚未获得搜索结果'):snapshot.phase==='stopped'?msg('搜索已停止'):msg('本轮未找到符合条件的候选')}</h3><p>{active?msg('有结果就会显示，不必等待全部完成。'):failed?msg('可以单独重试网站，其他结果会保留。'):msg('试试原名、其他译名，或调整搜索网站。')}</p></div>}
        {!!snapshot.results.length&&<p className="nc-search-match-note"><Icon name="info" size={15}/>{msg('以下是搜索候选，请核对封面与作者。')}</p>}
      </section>}
      {!snapshot.searchedAt&&!queryShown&&snapshot.phase!=='resolving-name'&&<div className="nc-search-empty"><Icon name="globe" size={32}/><h3>{msg('按名称发现更多来源')}</h3><p>{msg('获取漫画名后，同时搜索所选网站；有结果就会立即显示。')}</p></div>}
      {snapshot.phase==='resolving-name'&&<button className="nc-search-text-button" onClick={()=>session.stop()}>{msg('停止查找')}</button>}
    </div>
  </dialog>;
}
