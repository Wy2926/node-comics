import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {Modal} from '../components';
import {useContextMenu} from '../ContextMenu';
import {LanguageFlag} from '../LanguageFlag';
import {SearchSiteIcon} from '../comic-search/SearchSiteIcon';
import {listSupportedSites} from '../../sources';
import {Thumbnail} from '../../reader/Images';
import {coverReference} from '../../comics/application/library-service';
import {contentLanguageLabel} from '../../reader/ComicDirectory';
import {openHostAccessSettings} from '../../host-permissions';
import {clearBookDownloads,downloadLanguages,readDownloadScope,saveDownloadLanguages,startBookDownload,pauseBookDownload,cancelBookDownload,downloadLanguage,unknownDownloadLanguage,isBookDownloadActive,type BookDownloadView,type DownloadLanguages,type DownloadScope} from '../../comics/acquisition/books';
import type {BookDownloadsController} from './useBookDownloads';
import './downloads.css';
import {FileDownloadRows} from './FileDownloads';

const cacheSize=(bytes:number)=>bytes>=1024**3?`${(bytes/1024**3).toFixed(2)} GB`:`${(bytes/1024**2).toFixed(1)} MB`;
const languageName=(id:string)=>id===unknownDownloadLanguage?msg('语言未标注'):contentLanguageLabel(id);
const supportedSites=listSupportedSites();
function bookDownloadLabel(book:BookDownloadView){
  if(book.status==='complete'&&book.newChapters)return msg('有新章节未缓存');
  switch(book.status){
    case 'queued':return msg('等待缓存');
    case 'preparing':return msg('正在读取全部目录…');
    case 'running':return msg('缓存中');
    case 'paused':return book.plan.reason==='space'?msg('空间不足'):book.plan.reason==='network'?msg('等待网络'):book.plan.reason==='interrupted'?msg('缓存已中断'):msg('已暂停');
    case 'partial':return msg('部分已缓存');
    case 'complete':return msg('已缓存');
    case 'clearing':return book.plan.error?msg('需要处理'):msg('正在清理离线内容…');
  }
}
function useDownloadAction(controller:BookDownloadsController){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),running=useRef(false);
  const act=async(action:()=>Promise<unknown>)=>{if(running.current)return;running.current=true;setBusy(true);setError('');try{await action();controller.refresh();}catch(error){setError((error as Error).message);}finally{running.current=false;setBusy(false);}};
  return {busy,error,act};
}
export function BookDownloads({controller,onRead,onManageStorage}:{controller:BookDownloadsController;onRead:(comicId:string)=>void;onManageStorage:()=>void}){
  const totalBooks=controller.books.length+controller.files.length,totalBytes=controller.books.reduce((sum,book)=>sum+book.bytes,0)+controller.files.reduce((sum,file)=>sum+file.intent.bytes,0);
  return <section className="nc-download-center" aria-label={msg('离线中心')}>
    <div className="nc-page-heading"><div><h1>{msg('离线中心')}</h1><p>{msg('共 {0} 部漫画 · {1} 部缓存中 · 已保留 {2}',{'0':totalBooks,'1':controller.activeCount,'2':cacheSize(totalBytes)})}</p></div></div>
    <p className="nc-download-lifetime"><Icon name="info" size={16}/>{msg('请保持此插件页打开，可切换到其他标签页。')}</p>
    {!totalBooks?<div className="nc-empty"><Icon name="download" size={40}/><h2>{msg('暂无离线缓存')}</h2><p>{msg('从漫画的更多菜单选择“缓存整本”。')}</p></div>:<div className="nc-download-books">
      {controller.books.map(book=><BookRow key={book.comic.id} book={book} controller={controller} focused={controller.focusedComicId===book.comic.id} onRead={()=>onRead(book.comic.id)} onManageStorage={onManageStorage}/>)}
    </div>}
    <FileDownloadRows controller={controller} onRead={onRead}/>
  </section>;
}
function BookRow({book,controller,focused,onRead,onManageStorage}:{book:BookDownloadView;controller:BookDownloadsController;focused:boolean;onRead:()=>void;onManageStorage:()=>void}){
  const {busy,error,act}=useDownloadAction(controller),[confirmation,setConfirmation]=useState<{kind:'cancel'|'clear';generation:number}>(),ref=useRef<HTMLElement>(null),more=useRef<HTMLButtonElement>(null),menu=useContextMenu();
  const isActive=isBookDownloadActive(book.status),cleaning=book.status==='clearing',disabled=busy||cleaning&&!book.plan.error,comicId=book.comic.id;
  useEffect(()=>{if(focused){ref.current?.scrollIntoView({block:'nearest'});ref.current?.focus({preventScroll:true});}},[focused]);
  const languages=book.plan.languages??book.availableLanguages;
  const sites=supportedSites.filter(site=>'website:'+site.adapterId===book.comic.source.connectionId);
  const site=sites.find(site=>{try{return new URL(site.url).hostname===new URL(book.comic.sourceUrl??'').hostname;}catch{return false;}})??sites[0];
  const supplement=()=>void act(()=>startBookDownload(comicId,book.plan.languages,true,undefined,book.plan.generation));
  const resume=()=>void act(()=>startBookDownload(comicId,undefined,false,undefined,book.plan.generation));
  const clear=()=>setConfirmation({kind:'clear',generation:book.plan.generation});
  let primary:{label:string;onSelect:()=>void;secondary?:boolean}|undefined;
  if(cleaning){if(book.plan.error)primary={label:msg('清除离线内容'),onSelect:clear};}
  else if(isActive)primary={label:msg('暂停缓存'),secondary:true,onSelect:()=>void act(()=>pauseBookDownload(comicId,book.plan.generation))};
  else if(book.plan.reason==='permission')primary={label:msg('扩展权限设置'),onSelect:()=>void act(openHostAccessSettings)};
  else if(book.plan.reason==='space')primary={label:msg('管理空间'),onSelect:onManageStorage};
  else if(book.status!=='complete')primary={label:book.status==='partial'?msg('重试未完成'):msg('继续缓存'),onSelect:resume};
  else if(book.newChapters)primary={label:msg('补缓存 {0} 个新章节',{'0':book.newChapters}),onSelect:supplement};
  const actions:Parameters<typeof menu.open>[2]=[];
  if(!isActive&&!cleaning&&(book.plan.reason==='permission'||book.plan.reason==='space'))actions.push({icon:'download',label:msg('继续缓存'),disabled,onSelect:resume});
  if(book.availableLanguages.length>1)actions.push({icon:'globe',label:msg('缓存语言'),disabled:busy||cleaning,onSelect:()=>{if(more.current)controller.open(comicId,true,more.current);}});
  if(!isActive&&!cleaning&&book.status!=='complete'&&book.newChapters>0)actions.push({icon:'download',label:msg('补缓存 {0} 个新章节',{'0':book.newChapters}),disabled,onSelect:supplement});
  if(book.comic.sourceUrl)actions.push({icon:'external',label:msg('打开来源'),onSelect:()=>{window.open(book.comic.sourceUrl,'_blank','noopener,noreferrer');}});
  if(book.status!=='complete'&&!cleaning)actions.push({icon:'close',label:msg('取消缓存'),danger:true,disabled,onSelect:()=>book.bytes?setConfirmation({kind:'cancel',generation:book.plan.generation}):void act(()=>cancelBookDownload(comicId,book.plan.generation))});
  if(book.bytes>0||cleaning&&book.plan.error)actions.push({icon:'trash',label:msg('清除离线内容'),danger:true,disabled,onSelect:clear});
  const tone=isActive?'active':book.status==='complete'&&!book.newChapters?'complete':book.status==='partial'||book.newChapters||book.plan.error||book.plan.reason?'attention':'neutral';
  return <><article ref={ref} tabIndex={-1} className="nc-download-book" data-comic-id={comicId} {...menu.bind(book.comic.title,actions)}>
    <button className="nc-download-cover" onClick={onRead} aria-label={msg('打开漫画 {0}',{'0':book.comic.title})}><Thumbnail blobKey={coverReference(book.comic)} alt={msg('{0}封面',{'0':book.comic.title})}/></button>
    <div className="nc-download-info">
      <div className="nc-download-title"><h2><button onClick={onRead}>{book.comic.title}</button></h2><span className="nc-download-status" data-state={book.status} data-tone={tone}><Icon name={tone==='complete'?'check':tone==='attention'?'info':'download'} size={14}/>{bookDownloadLabel(book)}</span></div>
      <div className="nc-download-meta"><span className="nc-download-source"><SearchSiteIcon icon={site?.icon}/>{book.comic.sourceName}</span><span className="nc-download-flags" aria-label={msg('缓存语言')}>{languages.map(language=><span key={language} role="img" title={languageName(language)} aria-label={languageName(language)}><LanguageFlag language={language}/></span>)}</span></div>
      <div className="nc-download-progress"><span>{msg('已完整缓存 {0} / {1} 章',{'0':book.completed,'1':book.total})}</span>{book.total>0?<><span>{Math.floor(book.completed/book.total*100)}%</span><progress aria-label={msg('章节缓存进度')} value={book.completed} max={book.total}/></>:<progress aria-label={msg('章节缓存进度')}/>}</div>
      {(book.plan.error||book.status==='partial'||book.plan.reason==='interrupted')&&<p className="nc-download-feedback" role="status">{book.plan.error||(book.plan.reason==='interrupted'?msg('上次缓存已中断，已保存的页面会继续保留。'):msg('未完成的章节可重试，已缓存内容会保留。'))}</p>}
      {!!book.plan.missingLanguages&&<p className="nc-download-feedback">{msg('来源中有 {0} 话缺少所选语言',{'0':book.plan.missingLanguages})}</p>}
      {!!book.plan.retryAt&&book.plan.retryAt>Date.now()&&<p className="nc-download-feedback">{msg('来源暂时限制请求，请在 {0} 后继续。',{'0':new Date(book.plan.retryAt).toLocaleTimeString()})}</p>}
      {error&&<p className="nc-download-feedback" role="alert">{error}</p>}

    </div>
    <div className="nc-download-actions">
      <div className="nc-download-controls">
        {primary&&<button className={'button small '+(primary.secondary?'secondary':'primary')} disabled={disabled} onClick={primary.onSelect}>{primary.label}</button>}
        <button ref={more} className="icon-button" aria-label={msg('更多操作 · {0}',{'0':book.comic.title})} aria-haspopup="menu" onClick={event=>menu.open(event.currentTarget,book.comic.title,actions)}><Icon name="more" size={18}/></button>
      </div>
      <div className="nc-download-size"><span><Icon name="storage" size={14}/>{msg('离线占用')}</span><strong>{cacheSize(book.bytes)}</strong></div>
    </div>
  </article>{menu.menu}{confirmation&&<Modal title={confirmation.kind==='cancel'?msg('取消缓存'):msg('清除离线内容')} onClose={()=>{if(!busy)setConfirmation(undefined);}}>
    <p>{confirmation.kind==='cancel'?msg('取消《{0}》的缓存并删除已保存的离线原图？漫画和阅读记录会保留。',{'0':book.comic.title}):msg('清除《{0}》的离线原图？漫画和阅读记录会保留，之后阅读可能需要网络。',{'0':book.comic.title})}</p>
    <p className="nc-muted">{msg('已保留 {0}',{'0':cacheSize(book.bytes)})}</p>
    {error&&<p role="alert">{error}</p>}
    <div className="nc-cache-actions"><button className="button danger" disabled={busy} onClick={()=>void act(async()=>{await clearBookDownloads(comicId,confirmation.generation);setConfirmation(undefined);})}>{confirmation.kind==='cancel'?msg('取消缓存'):msg('清除离线内容')}</button><button className="button secondary" disabled={busy} onClick={()=>setConfirmation(undefined)}>{msg('取消')}</button></div>
  </Modal>}</>;
}
export function DownloadLanguagesPopover({controller}:{controller:BookDownloadsController}){
  const picker=controller.languagePicker;
  return picker?<LanguageSelection key={picker.comicId} comicId={picker.comicId} anchor={picker.anchor} controller={controller}/>:null;
}
function LanguageSelection({comicId,anchor,controller}:{comicId:string;anchor:HTMLElement;controller:BookDownloadsController}){
  const book=controller.books.find(value=>value.comic.id===comicId);
  const [scope,setScope]=useState<DownloadScope>(),[languages,setLanguages]=useState<DownloadLanguages>(null),[loadError,setLoadError]=useState('');
  const {busy,error,act}=useDownloadAction(controller);
  useEffect(()=>{let live=true;void Promise.all([readDownloadScope(comicId),downloadLanguages(comicId)]).then(([scope,languages])=>{if(live){setScope(scope);setLanguages(languages);}}).catch(error=>{if(live)setLoadError(error.message);});return()=>{live=false;};},[comicId]);
  const openedGeneration=useRef(book?.plan.generation).current;
  const stale=openedGeneration!==undefined&&(!book||book.plan.generation!==openedGeneration||book.status==='clearing');
  useEffect(()=>{if(stale)controller.close(false);},[stale,controller.close]);
  const selected=scope?.entries.filter(entry=>!languages||languages.includes(downloadLanguage(entry.contentLanguage)))??[];
  const selectedIds=new Set(selected.map(entry=>entry.id)),plannedIds=new Set(book?.plan.entryIds);
  const toggle=(id:string)=>setLanguages(previous=>{const next=new Set(previous??scope?.languages.map(language=>language.id));if(next.has(id))next.delete(id);else next.add(id);return next.size===scope?.languages.length?null:[...next];});
  const popover=useRef<HTMLDivElement>(null),close=useRef(controller.close);close.current=controller.close;
  useLayoutEffect(()=>{
    const node=popover.current!;node.showPopover();node.focus({preventScroll:true});
    const position=()=>{
      if(!anchor.isConnected){close.current(false);return;}
      const rect=anchor.getBoundingClientRect(),margin=12,gap=12,width=Math.min(360,document.documentElement.clientWidth-margin*2);
      node.style.width=width+'px';
      const height=node.getBoundingClientRect().height,left=rect.left>=width+margin+gap;
      const x=left?rect.left-width-gap:Math.max(margin,Math.min(rect.right-width,document.documentElement.clientWidth-width-margin));
      const below=window.innerHeight-rect.bottom>=height+gap+margin;
      const y=Math.max(margin,Math.min(left?rect.top:below?rect.bottom+gap:rect.top-height-gap,window.innerHeight-height-margin));
      node.style.left=x+'px';node.style.top=y+'px';node.dataset.side=left?'left':below?'below':'above';
      node.style.setProperty('--pointer-offset',(left?Math.max(18,Math.min(rect.top+rect.height/2-y,height-18)):Math.max(18,Math.min(rect.left+rect.width/2-x,width-18)))+'px');
    };
    position();const observer=new ResizeObserver(position);observer.observe(anchor);observer.observe(node);
    window.addEventListener('resize',position);document.addEventListener('scroll',position,true);
    return()=>{observer.disconnect();window.removeEventListener('resize',position);document.removeEventListener('scroll',position,true);if(node.matches(':popover-open'))node.hidePopover();};
  },[anchor]);
  useEffect(()=>{if(scope)popover.current?.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true});},[scope]);
  return <div ref={popover} id="nc-download-language-popover" tabIndex={-1} popover="auto" role="dialog" aria-label={msg('缓存语言')} className="nc-download-language-popover" onToggle={event=>{if(event.newState==='closed')controller.close(false);}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();controller.close();}}}>
    <div className="nc-download-language-content"><h3>{msg('缓存语言')}</h3><p className="nc-muted nc-download-language-title">{book?.comic.title??scope?.title}</p>
    {scope?<><section className="nc-download-languages" aria-label={msg('缓存语言')}>
      <label><input type="checkbox" disabled={busy} checked={languages===null} onChange={event=>setLanguages(event.target.checked?null:[])}/>{msg('全部语言')}</label>
      {scope.languages.map(language=><label key={language.id}><input type="checkbox" disabled={busy} checked={!languages||languages.includes(language.id)} onChange={()=>toggle(language.id)}/><LanguageFlag language={language.id}/><span>{languageName(language.id)}</span><small>{msg('{0} 话',{'0':language.count})}</small></label>)}
    </section><p className="nc-muted">{msg('所选语言的全部章节与译组')} · {selected.length}</p>
    {!selected.length&&<p role="status">{msg('至少选择一种有章节的语言。')}</p>}
    {openedGeneration!==undefined&&book&&<><p>{msg('调整后补齐新范围，已保存的其他语言仍会保留。')}</p><p className="nc-muted">{msg('当前 {0} 章 → 新范围 {1} 章；新增 {2} 章，不再请求 {3} 章。',{'0':book.total,'1':selected.length,'2':selected.filter(entry=>!plannedIds.has(entry.id)).length,'3':book.plan.entryIds.filter(id=>!selectedIds.has(id)).length})}</p></>}
    <div className="nc-cache-actions"><button className="button primary small" disabled={busy||stale||!selected.length} onClick={()=>void act(async()=>{if(openedGeneration===undefined)await saveDownloadLanguages(comicId,languages);else if(!await startBookDownload(comicId,languages,true,undefined,openedGeneration))throw Error(msg('缓存任务已变化，请重新操作。'));controller.close();})}>{openedGeneration!==undefined?msg('应用并补缓存'):msg('保存选择')}</button><button className="button secondary small" disabled={busy} onClick={()=>controller.close()}>{msg('取消')}</button></div></>:!loadError&&<p className="nc-muted">{msg('正在读取全部目录…')}</p>}
    {(loadError||error)&&<p role="alert">{loadError||error}</p>}
    </div>
  </div>;
}
