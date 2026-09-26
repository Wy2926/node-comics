import {useEffect,useId,useLayoutEffect,useRef,useState,useSyncExternalStore,type KeyboardEvent} from 'react';
import type {Api} from '../../api';
import {Icon} from '../../icons';
import {formatDate,msg} from '../../i18n/runtime';
import {fallbackLanguages,languageLabel} from '../../types';
import {Thumbnail} from '../../reader/Images';
import {listSearchSites,releaseSourceSearchSession,searchSource,type SourceSearchResult} from '../../sources';
import {ComicSearchSession,comicSearchSourceKey} from '../../comics/application/search/session';
import {readSearchSiteSelection,saveSearchSiteSelection} from '../../comics/application/preferences';
import type {SearchSeed,SearchSiteState} from '../../comics/application/search/types';
import {Select,SelectOption} from '../Select';
import {LanguageFlag} from '../LanguageFlag';
import {searchResultCoverKey} from './SearchResultCover';
import {SearchResultCard} from './SearchResultCard';
import {SearchSiteIcon} from './SearchSiteIcon';
import './comic-search.css';

export interface ComicSearchPanelProps {
  open:boolean;
  presentation?:'page'|'sheet';
  seed:SearchSeed;
  api:Api;
  defaultLanguage:string;
  onClose?:()=>void;
  onLogin?:()=>void;
  onImportHit:(hit:SourceSearchResult)=>Promise<void>|void;
  existingSourceKeys?:ReadonlySet<string>;
  currentIdentity?:{sourceId:string;catalogId:string};
  onLanguageChange?:(language:string)=>void;
}
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

/** Two presentations share one search workflow. Keep mounted while hidden to retain local results. */
export function ComicSearchPanel({open,presentation='sheet',seed,api,defaultLanguage,onClose,onLogin,onImportHit,existingSourceKeys,currentIdentity,onLanguageChange}:ComicSearchPanelProps){
  const [session]=useState(()=>new ComicSearchSession(seed,{translateTitle:(name,language,signal)=>api.translateComicTitle(name,language,signal),listSites:listSearchSites,search:searchSource,release:releaseSourceSearchSession},defaultLanguage,readSearchSiteSelection()));
  const snapshot=useSyncExternalStore(session.subscribe,session.getSnapshot);
  const dialog=useRef<HTMLDialogElement>(null),closeRef=useRef<HTMLButtonElement>(null),queryRef=useRef<HTMLInputElement>(null),sourceRef=useRef<HTMLInputElement>(null),scrollRef=useRef<HTMLDivElement>(null);
  const coverCache=useRef(new Map<string,string>()),titleId=useId(),queryId=useId(),sourceId=useId();
  const [query,setQuery]=useState(snapshot.query),[mode,setMode]=useState<'direct'|'translate'>(presentation==='page'?'direct':'translate');
  const [siteFilter,setSiteFilter]=useState(''),[clock,setClock]=useState(Date.now()),[reopened,setReopened]=useState(false),[importing,setImporting]=useState<string>(),[importErrors,setImportErrors]=useState<Record<string,string>>({});
  const wasOpened=useRef(false),scrollPosition=useRef(0),sheet=presentation==='sheet';
  useEffect(()=>setQuery(snapshot.query),[snapshot.query]);
  useEffect(()=>{
    if(!open)return;
    const restore=()=>{const saved=readSearchSiteSelection();for(const state of session.getSnapshot().sites)session.setSelected(state.site.key,saved[state.site.key]??true);};
    const storageChanged=(event:StorageEvent)=>{if(event.key===null||event.key==='nc-search-sites')restore();};
    restore();window.addEventListener('storage',storageChanged);
    return()=>window.removeEventListener('storage',storageChanged);
  },[open,session]);
  useEffect(()=>{const retained=new Set(snapshot.results.map(hit=>searchResultCoverKey(hit.coverHit??hit)));for(const [key,url] of coverCache.current)if(!retained.has(key)){URL.revokeObjectURL(url);coverCache.current.delete(key);}},[snapshot.results]);
  useEffect(()=>{if(!open)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[open]);
  useEffect(()=>()=>{session.dispose();coverCache.current.forEach(url=>URL.revokeObjectURL(url));coverCache.current.clear();},[session]);
  useLayoutEffect(()=>{
    if(!open){session.stop();return;}
    const element=dialog.current,scroller=scrollRef.current,previous=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
    setReopened(wasOpened.current&&!!session.getSnapshot().searchedAt);
    if(sheet){element?.showModal();closeRef.current?.focus({preventScroll:true});if(scroller)scroller.scrollTop=scrollPosition.current;}
    else if(!wasOpened.current)queryRef.current?.focus({preventScroll:true});
    wasOpened.current=true;
    return()=>{
      session.stop();
      if(sheet){scrollPosition.current=scroller?.scrollTop??0;element?.close();queueMicrotask(()=>{if(previous?.isConnected&&!previous.closest('[inert]'))previous.focus({preventScroll:true});});}
    };
  },[open,session,sheet]);
  useEffect(()=>{setSiteFilter('');setImportErrors({});},[snapshot.requestedTitleLanguage,snapshot.sourceTitle]);
  if(!open)return null;

  const selected=snapshot.sites.filter(state=>state.selected),resultSites=snapshot.sites.filter(state=>state.status!=='idle'),filteredSite=resultSites.find(state=>state.site.key===siteFilter);
  const siteWait=waitSeconds(filteredSite?.error?.retryAt,clock),titleWait=waitSeconds(snapshot.titleRetryAt,clock);
  const siteBusy=filteredSite?.status==='running'||filteredSite?.status==='queued',siteRetry=filteredSite?.status==='error'||filteredSite?.status==='stopped';
  const returned=resultSites.filter(state=>state.status==='ready'||state.status==='empty').length,failed=resultSites.filter(state=>state.status==='error').length;
  const permissionError=resultSites.find(state=>state.error?.kind==='permission')?.error;
  const active=snapshot.phase==='searching'||snapshot.phase==='resolving-name',translating=mode==='translate';
  const results=snapshot.results.filter(hit=>!filteredSite||filteredSite.resultKeys.includes(hit.key));
  const showResolved=translating&&(snapshot.titleState==='resolved'||snapshot.titleState==='missing'||snapshot.titleState==='error'||snapshot.titleState==='manual');
  const sourceCover=seed.cover?.url&&/^(?:blob:|data:image\/|chrome-extension:|moz-extension:)/.test(seed.cover.url)?seed.cover.url:undefined;
  const close=()=>{session.stop();onClose?.();};
  const submitManual=(value=query)=>{setReopened(false);setSiteFilter('');session.searchManual(value);};
  const automatic=()=>{setReopened(false);setSiteFilter('');void session.searchWithTranslatedTitle();};
  const useOriginal=()=>{setQuery(snapshot.sourceTitle);submitManual(snapshot.sourceTitle);};
  const changeMode=(next:'direct'|'translate')=>{if(next===mode)return;session.stop();if(next==='translate'&&!snapshot.sourceTitle&&query)session.setSourceTitle(query);if(next==='direct'&&!query)setQuery(snapshot.sourceTitle);setMode(next);};
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
  const content=<>
    <header className="nc-search-header nc-page-heading">
      <div><span className="nc-search-heading-icon"><Icon name={sheet?'globe':'book'} size={26}/></span><div><h1 id={titleId}>{sheet?msg('寻找其他语言'):msg('搜索漫画')}</h1><p>{msg('输入名字，发现更多漫画。')}</p></div></div>
      <div className="nc-search-header-context">{seed.title&&<div className="nc-search-origin"><div className="nc-search-origin-cover">{seed.coverKey?<Thumbnail blobKey={seed.coverKey}/>:sourceCover?<img src={sourceCover} alt=""/>:<Icon name="book" size={20}/>}</div><div><small>{seed.sourceName??msg('当前作品')}</small><b title={seed.title}>{seed.title}</b></div></div>}{sheet&&<button ref={closeRef} className="icon-button" aria-label={msg('关闭查找面板')} onClick={close}><Icon name="close"/></button>}</div>
    </header>
    <div ref={scrollRef} className="nc-search-body" data-search-scroll={sheet?'true':undefined}>
      <section className="nc-search-workbench">
        <div className="nc-search-composer">
          <div className="nc-search-mode segmented" role="group" aria-label={msg('搜索方式')}>
            <button type="button" className={!translating?'active':undefined} aria-pressed={!translating} disabled={!!importing} onClick={()=>changeMode('direct')}><Icon name="book" size={17}/>{msg('直接搜索')}</button>
            <button type="button" className={translating?'active':undefined} aria-pressed={translating} disabled={!!importing} onClick={()=>changeMode('translate')}><Icon name="globe" size={17}/>{msg('翻译名称搜索')}</button>
          </div>
          <form className="nc-search-form" onSubmit={event=>{event.preventDefault();if(translating)automatic();else submitManual();}}>
            <div className="nc-search-fields">
              <label className="nc-search-name" htmlFor={translating?sourceId:queryId}><span>{translating?msg('原作品名称'):msg('搜索名称')}</span>
                {translating?<input ref={sourceRef} id={sourceId} disabled={!!importing} value={snapshot.sourceTitle} onChange={event=>{setReopened(false);session.setSourceTitle(event.target.value);}} placeholder={msg('请输入漫画作品名称')}/>:<input ref={queryRef} id={queryId} disabled={!!importing} value={query} onChange={event=>setQuery(event.target.value)} placeholder={msg('输入漫画名称或别名')}/>}
              </label>
              {translating&&<label className="nc-search-language"><span>{msg('名称目标语言')}</span><Select disabled={!!importing} value={snapshot.requestedTitleLanguage} onChange={event=>{setReopened(false);session.setTargetLanguage(event.target.value);onLanguageChange?.(event.target.value);}} aria-label={msg('名称目标语言')}>{fallbackLanguages.map(language=><SelectOption key={language.id} value={language.id} icon={<LanguageFlag language={language.id}/>}>{language.label}</SelectOption>)}</Select></label>}
            </div>
            <div className="nc-search-submit-row"><div className="nc-search-submit-hint"><p>{translating?msg('先找到目标语言的常用名称，再搜索网站。'):msg('输入漫画名称，搜索已选择的网站。')}</p>{translating&&<button type="button" className="nc-search-text-button" disabled={!!importing||!snapshot.sourceTitle.trim()||!selected.length} onClick={useOriginal}>{msg('使用原名搜索')}</button>}</div><button className="button primary" disabled={!!importing||!selected.length||!(translating?snapshot.sourceTitle:query).trim()||(translating&&(titleWait>0||snapshot.phase==='resolving-name'))}><Icon name={translating?'globe':'book'} size={18}/>{translating?(titleWait?msg('{0} 秒后重试',{'0':titleWait}):msg('翻译名称并搜索')):snapshot.searchedAt?msg('重新搜索'):msg('搜索网站')}</button></div>
          </form>
          {snapshot.phase==='resolving-name'&&<p className="nc-search-resolving" role="status"><span className="spinner"/>{msg('正在查找常用{0}名称…',{'0':languageLabel(snapshot.requestedTitleLanguage)})}<button className="nc-search-text-button" onClick={()=>session.stop()}>{msg('停止查找')}</button></p>}
          {showResolved&&<section className="nc-search-query"><div><label htmlFor={queryId}>{msg('搜索名称')}</label></div><form onSubmit={event=>{event.preventDefault();submitManual();}}><input ref={queryRef} id={queryId} disabled={!!importing} value={query} onChange={event=>setQuery(event.target.value)} placeholder={msg('输入漫画名称或别名')}/><button className="button secondary small" disabled={!!importing||!query.trim()||!selected.length}>{snapshot.searchedAt?msg('重新搜索'):msg('搜索网站')}</button></form><p>{snapshot.titleState==='missing'?msg('未找到常用{0}名称，请手动输入或明确使用原名搜索。',{'0':languageLabel(snapshot.requestedTitleLanguage)}):snapshot.resolvedTitleLanguage&&snapshot.resolvedTitleLanguage!==snapshot.requestedTitleLanguage?msg('名称语言为{0}，将使用此名称搜索。',{'0':languageLabel(snapshot.resolvedTitleLanguage)}):msg('可以修改搜索名称，不会更改作品资料。')}</p></section>}
          {snapshot.titleError&&<div className="nc-search-inline-error" role="status"><Icon name="info" size={16}/><span>{snapshot.titleError.message}</span>{titleWait>0&&<span>{msg('{0} 秒后可重试',{'0':titleWait})}</span>}{snapshot.titleError.kind==='login'&&onLogin&&<button className="nc-search-text-button" onClick={onLogin}>{msg('登录')}</button>}</div>}
        </div>
        <aside className="nc-search-sites" aria-label={msg('搜索范围')}>
          <div className="nc-search-sites-heading"><h2>{msg('搜索范围')}</h2><span>{msg('已选 {0} 个网站',{'0':selected.length})}</span></div>
          <div className="nc-search-site-options">{snapshot.sites.map(state=><label className="nc-search-site-option" key={state.site.key}><input type="checkbox" checked={state.selected} disabled={!!importing} onChange={event=>{session.setSelected(state.site.key,event.target.checked);saveSearchSiteSelection(state.site.key,event.target.checked);}}/><SearchSiteIcon icon={state.site.icon}/><b title={state.site.name}>{state.site.name}</b></label>)}</div>
          <p>{msg('各网站仅按搜索名称查询，不按内容语言筛选。')}</p>
          {!selected.length&&<p className="nc-search-notice" role="status">{msg('请先选择至少一个可搜索的网站。')}</p>}
          {permissionError&&<p className="nc-search-notice" role="alert">{permissionError.message}</p>}
        </aside>
      </section>
      {snapshot.searchedAt?<section className="nc-search-results">
        <div className="nc-search-result-heading"><h2>{msg('搜索结果')}</h2><div className="nc-search-progress" role="status"><span title={reopened?msg('上次查找：{0}',{'0':formatDate(snapshot.searchedAt,true)}):undefined}>{snapshot.phase==='stopped'?msg('已停止'):msg('{0}/{1} 个网站已返回',{'0':returned,'1':resultSites.length})}</span>{failed>0&&<span className="nc-search-failed-count">{msg('{0} 个网站失败',{'0':failed})}</span>}<span className="nc-search-candidate-count">{msg('{0} 个候选',{'0':results.length})}</span>{active&&<button className="nc-search-text-button" onClick={()=>session.stop()}>{msg('停止查找')}</button>}</div></div>
        <div className="nc-search-status-list">{resultSites.map(state=><button type="button" key={state.site.key} className={'nc-search-status is-'+state.status} aria-pressed={filteredSite?.site.key===state.site.key} title={state.site.name+' · '+msg('查看此网站结果')} onClick={()=>setSiteFilter(value=>value===state.site.key?'':state.site.key)}><SearchSiteIcon icon={state.site.icon}/><b>{state.site.name}</b><span className="nc-search-site-state"><i className="nc-search-status-dot"/>{stateLabel(state)}</span></button>)}</div>
        {filteredSite&&<section className={'nc-search-status-detail is-'+filteredSite.status} aria-label={filteredSite.site.name}>
          <div className="nc-search-detail-summary"><SearchSiteIcon icon={filteredSite.site.icon}/><div className="nc-search-detail-copy" aria-live="polite">
            <div className="nc-search-detail-title"><h3>{filteredSite.site.name}</h3><span className="nc-search-detail-state">{stateLabel(filteredSite)}</span></div>
            {filteredSite.error?<p>{filteredSite.error.message}</p>:siteBusy?<p>{msg('有结果就会显示，不必等待全部完成。')}</p>:filteredSite.status==='empty'?<p>{msg('试试原名、其他译名，或调整搜索网站。')}</p>:null}
          </div></div>
          <div className="nc-search-detail-actions">
            {(siteRetry||siteBusy||filteredSite.nextCursor)&&<button className="button primary small nc-search-site-action" disabled={siteBusy||siteWait>0} onClick={()=>siteRetry?session.retrySite(filteredSite.site.key):session.loadMore(filteredSite.site.key)}>{siteBusy?<span className="spinner"/>:<Icon name={siteRetry?'refresh':'plus'} size={16}/>}<span>{siteBusy?stateLabel(filteredSite):siteWait?msg('{0} 秒后重试',{'0':siteWait}):siteRetry?msg('重试此网站'):msg('加载更多')}</span></button>}
            <a className="button secondary small" href={filteredSite.site.url} target="_blank" rel="noopener noreferrer">{msg('打开来源')}<Icon name="external" size={15}/></a>
          </div>
        </section>}
        <div className="nc-search-result-list">{results.map(hit=>{const sourceKey=comicSearchSourceKey(hit.sourceId,hit.catalogId),site=snapshot.sites.find(state=>state.site.adapterId===hit.sourceId&&state.site.id===hit.siteId);return <SearchResultCard key={hit.key} hit={hit} site={site?.site} cache={coverCache.current} current={!!currentIdentity&&sourceKey===comicSearchSourceKey(currentIdentity.sourceId,currentIdentity.catalogId)} existing={existingSourceKeys?.has(sourceKey)} importing={importing} error={importErrors[hit.key]} onImport={()=>importHit(hit)}/>;})}</div>
        {!results.length&&!filteredSite&&<div className="nc-search-empty"><Icon name={active?'clock':'book'} size={36}/><h2>{active?msg('各网站正在独立查找'):failed?msg('尚未获得搜索结果'):snapshot.phase==='stopped'?msg('搜索已停止'):msg('本轮未找到符合条件的候选')}</h2><p>{active?msg('有结果就会显示，不必等待全部完成。'):failed?msg('可以单独重试网站，其他结果会保留。'):msg('试试原名、其他译名，或调整搜索网站。')}</p></div>}
        {!!results.length&&<p className="nc-search-match-note"><Icon name="info" size={15}/>{msg('以下是搜索候选，请核对封面与作者。')}</p>}
      </section>:<div className="nc-search-empty nc-search-intro"><span className="nc-search-intro-icon"><Icon name="book" size={32}/></span><h2>{msg('按名称发现更多来源')}</h2><p>{msg('获取漫画名后，同时搜索所选网站；有结果就会立即显示。')}</p></div>}
    </div>
  </>;
  return sheet?<dialog ref={dialog} className="nc-comic-search nc-search-sheet" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();event.stopPropagation();close();}} onKeyDown={keyDown} onClick={event=>{if(event.target===event.currentTarget){const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();}}}>{content}</dialog>:<section className="nc-comic-search nc-search-page" aria-labelledby={titleId}>{content}</section>;
}
