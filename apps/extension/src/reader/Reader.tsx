import {Select,SelectOption} from '../ui/Select';
import {LanguageFlag} from '../ui/LanguageFlag';
import {msg} from '../i18n/runtime';
import {translationNotice} from '../translation/notice';
import {useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {Icon} from '../icons';
import {useShortcuts} from '../shortcuts/react';
import {hasShortcutOverlay} from '../shortcuts/runtime';
import type {Api} from '../api';
import {fallbackLanguages,languageLabel,modeLabels,type Capabilities,type ReadingEntry,type Job,type Mode,type Page,type Settings} from '../types';

import {BlobPicture,type ShownImage} from './Images';
import {pageTranslation,readingImage} from './presentation';
import {pageFrame} from './geometry';
import {pageWindow} from './virtual-window';
import {ImageTranslationStatus} from './ImageTranslationStatus';
import type {ReadingTarget,TranslationState} from '../translation/automatic';
import {FeedbackForm} from '../ui/Feedback';
import {useChapterStream,pageKey,completeManifest} from './useChapterStream';
import {ThumbnailDirectory} from './ThumbnailDirectory';
import {ComicDirectory,contentLanguageLabel} from './ComicDirectory';
import {acknowledgeCatalogUpdates} from '../comics/application/catalog-service';
import type {ReadingDirectory} from '../comics/application/library-service';
import {PageTranslationBar} from './PageTranslationBar';
import {readReadingView,saveReadingView,type ReadingView} from './view';
import {track,type AnalyticsFields} from '../analytics';
import type {ReaderAnalytics} from './analytics';
import {useReaderAnalytics} from './useReaderAnalytics';
import {useImageWindow} from './useImageWindow';
type Props={backLabel?:string;backText?:string;onFind?:()=>void;searchOpen?:boolean;onOpenShortcuts:()=>void;onSourceLanguageChange?:(language:string|undefined)=>void;viewKey:string;directory?:ReadingDirectory;catalogLoading?:boolean;onContinueCatalog?:()=>void;onReload?:()=>void;onMarkRead:(id:string)=>Promise<void>;sequence:ReadingEntry[];onActiveEntry:(id:string)=>void;onLoadEntry:(id:string)=>void|Promise<void>;sourceStatus?:string;sourceNeedsAction?:boolean;onNavigate:(id:string,pageId?:string,rememberChoice?:boolean)=>void;copy:ReadingEntry;settings:Settings;setSettings:(s:Settings|((s:Settings)=>Settings))=>void;update:(copy:ReadingEntry)=>void;onBack:()=>void;onRetry:(page:Page,mode:Mode,entryId?:string)=>void|Promise<void>;onUpgrade:()=>void;onLogin:()=>void;translationState:(entryId:string,page:Page,mode:Mode)=>TranslationState|undefined;onImport:()=>void;notify:(message:string)=>void;onReadingWindow:(targets:ReadingTarget[],visiblePages:Page[],immediate?:boolean)=>void;caps?:Capabilities;translationScope?:string;allowsFeedback?:boolean;channelLabel?:string;api:Api;busy:boolean;};
type Panel='directory'|'translation'|'settings';
export function Reader({analyticsSession,analyticsSource='unknown',analyticsChannel,analyticsBlocked=false,backLabel=msg("返回我的漫画"),backText=msg("书架"),onFind,searchOpen=false,onOpenShortcuts,onSourceLanguageChange,viewKey,directory,catalogLoading,onContinueCatalog,onReload,onMarkRead,sourceStatus:reportedSourceStatus,sourceNeedsAction,sequence,onActiveEntry,onLoadEntry,onNavigate,copy,settings,setSettings,update,onBack,onRetry,onUpgrade,onLogin,translationState,onImport,notify,onReadingWindow,caps,translationScope,allowsFeedback=false,channelLabel,api,busy}:Props&{analyticsSession?:ReaderAnalytics;analyticsSource?:AnalyticsFields['source_type'];analyticsChannel?:AnalyticsFields['channel'];analyticsBlocked?:boolean}){
const {index,indexRef,viewport,cells,ends,stacks,geometry,stream,next,nextOf,preserve,persist,restore,scroll,jump,navigationReason,pageShown,resources,resourceVersion}=useChapterStream({copy,sequence,layout:settings.layout,update,onActiveEntry,onLoadEntry,onMarkRead,notify});
const sourceRemoved=directory?.entries.find(entry=>entry.id===copy.id)?.sourceRemoved;
const sourceStatus=sourceRemoved?msg('源站已移除，缓存页面仍可阅读。'):reportedSourceStatus;
const [panel,setPanel]=useState<Panel>();const [savedView,setView]=useState<ReadingView>(()=>readReadingView(viewKey));const [compare,setCompare]=useState(false);
const view=savedView;
const [feedback,setFeedback]=useState<{job:Job;page:Page;number:number}>();const [actual,setActual]=useState<Record<string,ShownImage|undefined>>({});
const [immersive,setImmersive]=useState(false);const [hidden,setHidden]=useState(false);const hideTimer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
const root=useRef<HTMLDivElement>(null);const [viewportSize,setViewportSize]=useState({width:900,height:700});
const previousSearch=useRef(searchOpen);
useEffect(()=>{if(previousSearch.current&&!searchOpen)root.current?.querySelector<HTMLButtonElement>('[data-reader-settings-trigger]')?.focus();previousSearch.current=searchOpen;},[searchOpen]);
const page=copy.pages[Math.min(index,copy.pages.length-1)];const {mode,preference,zoom}=view;const language=caps?.languages.find(l=>l.id===settings.language)?.label??languageLabel(settings.language);
const scopeBase=`${translationScope??''}:${settings.language}`;const scope=(p:Page,c=copy)=>`${scopeBase}:${pageKey(c,p.id)}`;
const shown=page&&actual[pageKey(copy,page.id)]?.scope===scope(page)?actual[pageKey(copy,page.id)]:undefined;const shownJob=shown?.job;
const analytics=useReaderAnalytics({session:analyticsSession,viewport,cells,actual,dimensions:{source_type:analyticsSource,format:['cbz','zip','cbr','rar','pdf','mobi','website'].includes(copy.source)?copy.source as AnalyticsFields['format']:'unknown',layout:settings.layout,mode:compare?'compare':preference==='original'?'original':mode,target_language:settings.language as AnalyticsFields['target_language']},channel:analyticsChannel,pageCount:copy.pages.length,blocked:analyticsBlocked||searchOpen||!!panel||!!feedback,quotaBlocked:!!page&&preference!=='original'&&translationState(copy.id,page,mode)?.kind==='upgrade'});
useEffect(()=>{if(shown&&copy.comicId&&copy.catalogUpdateRevision)void acknowledgeCatalogUpdates(copy.comicId,copy.catalogUpdateRevision).catch(()=>{});},[!!shown,copy.comicId,copy.catalogUpdateRevision]);
const streamPages=useMemo(()=>stream.filter(chapter=>resources.ready(chapter)).flatMap(c=>c.pages.map(p=>({page:p,key:pageKey(c,p.id),entryId:c.id}))),[stream,resourceVersion]);
useEffect(()=>{setFeedback(undefined);},[copy.id]);
useEffect(()=>{setActual({});setFeedback(undefined);},[scopeBase]);
useEffect(()=>{saveReadingView(viewKey,savedView);},[viewKey,savedView]);
useEffect(()=>{if(!viewport.current)return;const observer=new ResizeObserver(([entry])=>{preserve();setViewportSize({width:entry.contentRect.width,height:entry.contentRect.height});});observer.observe(viewport.current);return()=>observer.disconnect();},[!!page]);
const frame=(p:Page)=>pageFrame(p,viewportSize,settings.fit,zoom,compare);
const windows=useMemo(()=>pageWindow(stream,copy.id,index,p=>frame(p).height,settings.layout==='single'?1:11),[stream,copy.id,index,viewportSize,settings.fit,zoom,compare,settings.layout]);
const mountedKeys=windows.flatMap(({copy:chapter,start,end})=>chapter.pages.slice(start,end).map(p=>pageKey(chapter,p.id)));
const decodedSet=useImageWindow({pages:streamPages,currentKey:pageKey(copy,page?.id??''),mountedKeys,layout:settings.layout,viewport,cells});
geometry.current=new Map(windows.map(window=>[window.copy.id,window]));
const contentWidth=stream.reduce((width,chapter)=>chapter.pages.reduce((width,page)=>Math.max(width,frame(page).width),width),0);
useLayoutEffect(()=>{restore();},[viewportSize,settings.fit,zoom,compare,settings.layout,!!page]);
useEffect(()=>()=>{clearTimeout(hideTimer.current);},[]);
useEffect(()=>{if(!immersive||panel||feedback||analyticsBlocked||searchOpen){setHidden(false);clearTimeout(hideTimer.current);return;}reveal();},[immersive,panel,feedback,analyticsBlocked,searchOpen]);
useEffect(()=>{
 if(panel!=='translation')return;
 const bubble=root.current?.querySelector<HTMLElement>('.nc-translation-popover');
 const trigger=root.current?.querySelector<HTMLButtonElement>('.nc-translation-trigger');
 bubble?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
 function outside(e:PointerEvent){const target=e.target as Node;if(!bubble?.contains(target)&&!trigger?.contains(target))setPanel(undefined);}
 function escape(e:KeyboardEvent){
  if(e.key!=='Escape'||e.defaultPrevented||e.isComposing||e.keyCode===229||analyticsBlocked||hasShortcutOverlay(document))return;
  e.preventDefault();e.stopPropagation();setPanel(undefined);trigger?.focus();
 }
 document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape,true);
 return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape,true);};
},[panel,analyticsBlocked]);
function reveal(){setHidden(false);clearTimeout(hideTimer.current);if(immersive&&!panel&&!feedback&&!analyticsBlocked&&!searchOpen)hideTimer.current=setTimeout(()=>{if(!root.current?.querySelector('.nc-reader-controls :focus'))setHidden(true);},2400);}
useEffect(()=>{
 function escape(event:KeyboardEvent){
  if(event.key!=='Escape'||event.defaultPrevented||event.isComposing||searchOpen||feedback||analyticsBlocked||hasShortcutOverlay(document))return;
  setPanel(undefined);reveal();
 }
 window.addEventListener('keydown',escape);
 return()=>window.removeEventListener('keydown',escape);
},[immersive,panel,feedback,searchOpen,analyticsBlocked]);
// Bindings and event arbitration belong to the shared runner; these are the same reader actions as the controls.
useShortcuts({
 'reader.previous':()=>navigate(-1),
 'reader.next':()=>navigate(1),
 'reader.left':()=>navigate(settings.direction==='rtl'?1:-1),
 'reader.right':()=>navigate(settings.direction==='rtl'?-1:1),
 'reader.first':()=>{if(!page)return false;jump(0);},
 'reader.last':()=>{if(!page)return false;jump(copy.pages.length-1);},
 'reader.original':()=>selectView('original'),
 'reader.translation':()=>selectView('classic'),
 'reader.compare':toggleCompare,
 'reader.directory':()=>togglePanel('directory'),
 'reader.settings':()=>togglePanel('settings'),
 'reader.translationSettings':()=>{if(!page)return false;togglePanel('translation');},
 'reader.zoomIn':()=>changeZoom(value=>value+10),
 'reader.zoomOut':()=>changeZoom(value=>value-10),
 'reader.zoomReset':()=>changeZoom(100),
 'reader.layout':()=>changeLayout(settings.layout==='continuous'?'single':'continuous'),
 'reader.fit':()=>changeFit(settings.fit==='window'?'width':'window'),
 'reader.immersive':()=>setImmersive(value=>!value),
 'reader.fullscreen':()=>{void fullscreen();},
 'reader.back':leaveReader,
 'reader.find':()=>{if(!onFind)return false;findComic();},
},{enabled:!searchOpen&&!feedback&&!analyticsBlocked});
useEffect(()=>{
 const start=streamPages.findIndex(p=>p.key===pageKey(copy,page?.id??''));
 const targets=preference==='original'||start<0?[]:streamPages.slice(Math.max(0,start),Math.max(0,start)+4).map(p=>({...p,mode}));
 onReadingWindow(targets,streamPages.filter(p=>decodedSet.has(p.key)).map(p=>p.page),navigationReason.current==='direct');
},[index,copy.id,streamPages,decodedSet,mode,preference,onReadingWindow]);
useEffect(()=>()=>onReadingWindow([],[]),[onReadingWindow]);
async function fullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{notify(msg("此浏览器暂时无法进入全屏。"));}}
function navigate(offset:number){if(!page)return false;jump(indexRef.current+offset);}
function leaveReader(){preserve();persist();onBack();}
function openShortcuts(){setPanel(undefined);reveal();onOpenShortcuts();}
function findComic(){preserve();persist();setPanel(undefined);onFind?.();}
function togglePanel(next:Panel){reveal();setPanel(v=>v===next?undefined:next);}
function changeLayout(layout:Settings['layout']){preserve();setSettings(s=>({...s,layout}));}
function changeFit(fit:Settings['fit']){preserve();setSettings(s=>({...s,fit}));}
function changeZoom(value:number|((zoom:number)=>number)){
 if(!page)return false;preserve();
 setView(view=>{const nextZoom=Math.max(40,Math.min(200,typeof value==='function'?value(view.zoom):value));return nextZoom===view.zoom?view:{...view,zoom:nextZoom};});
}
function toggleCompare(){
 if(!page||!compare&&caps&&!caps.modes.some(item=>item.id==='classic'&&item.enabled))return false;
 preserve();recordView(compare?(preference==='original'?'original':mode):'compare');
 setCompare(value=>!value);
 if(!compare)setView(view=>({...view,preference:'translation'}));
}
function recordView(value:'original'|Mode|'compare'){
  track('translation_view_changed',{surface:'reader',mode:value,...(analyticsChannel?{channel:analyticsChannel}:{}),target_language:settings.language as AnalyticsFields['target_language']});
  if(value!=='original'&&analyticsChannel&&(preference==='original'||value!=='compare'&&value!==mode))analytics.requestTranslation(performance.now(),{channel:analyticsChannel,mode:value==='compare'?mode:value,target_language:settings.language as AnalyticsFields['target_language']});
}
function selectView(value:'original'|Mode){
  if(!page||value!=='original'&&caps&&!caps.modes.some(item=>item.id===value&&item.enabled))return false;
  if(value!==(preference==='original'?'original':mode))recordView(value);
  preserve();
  setView(view=>({...view,mode:value==='original'?mode:value,preference:value==='original'?'original':'translation'}));
  if(value==='original')setCompare(false);
}
const contentLanguageControl=onSourceLanguageChange&&directory?.entries.some(entry=>entry.contentLanguage)&&<Select className="nc-reader-language" placement="left" menuWidth={280} aria-label={msg('内容语言偏好')} title={msg('内容语言偏好')} value={directory.sourceLanguagePreference??''} onFocus={()=>setPanel(undefined)} onChange={event=>onSourceLanguageChange(event.target.value||undefined)} trigger={<><LanguageFlag language={directory.sourceLanguagePreference??settings.language}/><span>{msg('内容语言偏好')}</span></>}>
 <SelectOption value="" icon={<LanguageFlag language={settings.language}/>}>{msg('跟随翻译目标')}</SelectOption>
 {[...new Set(['zh',...directory.entries.flatMap(entry=>entry.contentLanguage?[entry.contentLanguage]:[]),...(directory.sourceLanguagePreference?[directory.sourceLanguagePreference]:[])])].map(language=><SelectOption key={language} value={language} icon={<LanguageFlag language={language}/>}>{language==='zh'?msg('中文（不限简繁）'):contentLanguageLabel(language)}</SelectOption>)}
</Select>;
const readerPanel=panel&&<>{panel!=='translation'&&<button className="nc-drawer-scrim" aria-label={msg("关闭阅读面板")} onClick={()=>setPanel(undefined)}/>}<aside id={panel==='translation'?'nc-translation-settings':undefined} role={panel==='translation'?'dialog':undefined} className={panel==='translation'?'nc-translation-popover nc-reader-controls':`nc-reader-drawer ${panel==='directory'?'left':'right'}`} aria-label={{directory:msg("漫画目录"),translation:msg("翻译选项"),settings:msg("阅读设置")}[panel]}><div className="nc-drawer-title"><h2>{{directory:msg("目录"),translation:msg("翻译设置"),settings:msg("阅读设置")}[panel]}</h2><button className="icon-button" aria-label={msg("关闭面板")} onClick={()=>{setPanel(undefined);if(panel==='translation')root.current?.querySelector<HTMLButtonElement>('.nc-translation-trigger')?.focus();}}><Icon name="close"/></button></div>
{panel==='directory'&&sourceStatus&&<div className="nc-source-status" role="status"><span>{sourceStatus}</span><button disabled={busy} onClick={onReload}>{msg("重新载入")}</button></div>}
{panel==='directory'?<ComicDirectory catalogLoading={catalogLoading} onContinueCatalog={onContinueCatalog} directory={directory??{title:copy.title,entries:[],groups:[],chapters:[]}} index={index} pageCount={copy.pages.length} onNavigate={(id,pageId,rememberChoice)=>{preserve();persist();onNavigate(id,pageId,rememberChoice);}}><ThumbnailDirectory pages={resources.ready(copy)?copy.pages:[]} index={index} mode='classic' language={settings.language} translationScope={translationScope} onJump={n=>{jump(n);if(window.innerWidth<760)setPanel(undefined);}}/></ComicDirectory>:<div className="nc-drawer-content">
{panel==='translation'?<>{channelLabel&&<p className="nc-muted">{channelLabel}</p>}{(caps?.languages.length??fallbackLanguages.length)<=4?<Choice label={msg("目标语言")} value={settings.language} options={(caps?.languages??fallbackLanguages).map(language=>({...language,icon:<LanguageFlag language={language.id}/>}))} onChange={language=>setSettings(s=>({...s,language}))}/>:<label className="field">{msg("目标语言")}<Select aria-label={msg("翻译目标语言")} value={settings.language} onChange={e=>setSettings(s=>({...s,language:e.target.value}))}>{(caps?.languages??fallbackLanguages).map(l=><SelectOption key={l.id} value={l.id} icon={<LanguageFlag language={l.id}/>}>{l.label}</SelectOption>)}</Select></label>}
<p className="nc-muted nc-default-mode-note">{msg("选择译图后，随读翻译当前页与后三页；查看方式仅对此漫画生效。")}</p></>:<><Choice label={msg("阅读布局")} value={settings.layout} options={[{id:'continuous',label:msg("连续阅读"),icon:<Icon name="list" size={16}/>},{id:'single',label:msg("单页阅读"),icon:<Icon name="page-unread" size={16}/>}]} onChange={changeLayout}/><Choice label={msg("阅读方向")} value={settings.direction} options={[{id:'rtl',label:msg("从右向左"),icon:<Icon name="arrow" size={16} style={{transform:'rotate(180deg)'}}/>},{id:'ltr',label:msg("从左向右"),icon:<Icon name="arrow" size={16}/>}]} onChange={direction=>setSettings(s=>({...s,direction}))}/><Choice label={msg("图片适应方式")} value={settings.fit} options={[{id:'window',label:msg("适应窗口"),icon:<Icon name="expand" size={16}/>},{id:'width',label:msg("铺满宽度"),icon:<Icon name="split" size={16}/>}]} onChange={changeFit}/><div className="nc-reader-option"><b>{msg("缩放")}</b><div className="nc-inline"><button className="icon-button" aria-label={msg("缩小")} disabled={zoom<=40} onClick={()=>changeZoom(zoom-10)}><Icon name="minus"/></button><span>{zoom}%</span><button className="icon-button" aria-label={msg("放大")} disabled={zoom>=200} onClick={()=>changeZoom(zoom+10)}><Icon name="plus"/></button></div></div><Choice label={msg("阅读背景")} value={settings.readerBackground} options={[{id:'gray',label:msg("浅灰")},{id:'paper',label:msg("纸白")},{id:'night',label:msg("夜色")}]} onChange={readerBackground=>setSettings(s=>({...s,readerBackground}))}/><div className="nc-reader-option"><div><b>{msg("并排对照")}</b><p>{msg("原图与当前模式最新译图")}</p></div><button className={`switch ${compare?'on':''}`} role="switch" aria-label={msg("并排对照")} aria-checked={compare} onClick={toggleCompare}><i/></button></div><div className="nc-reader-option"><div><b>{msg("沉浸阅读")}</b><p>{msg("空闲时收起工具，轻点空白处唤回。")}</p></div><button className={`switch ${immersive?'on':''}`} role="switch" aria-label={msg("沉浸阅读")} aria-checked={immersive} onClick={()=>setImmersive(v=>!v)}><i/></button></div><div className="nc-stack-actions">{onFind&&<button className="button secondary" onClick={findComic}><Icon name="translate"/>{msg("寻找其他语言")}</button>}<button className="button secondary" onClick={()=>void fullscreen()}><Icon name="expand"/>{msg("全屏阅读")}</button>{onReload&&<button className="button secondary" disabled={busy} onClick={onReload}><Icon name="refresh"/>{msg('重新载入')}</button>}{copy.sourceUrl&&<a className="button secondary" href={copy.sourceUrl} target="_blank" rel="noreferrer">{msg('打开来源')}</a>}<button className="button secondary" onClick={openShortcuts}><Icon name="keyboard"/>{msg("键盘快捷键")}</button></div></>}
</div>}</aside></>;
if(!page)return <div ref={root} className="nc-reader"><nav className="nc-reader-rail left nc-reader-controls" aria-label={msg("阅读导航")}><button className="icon-button" aria-label={backLabel} onClick={leaveReader}><Icon name="arrow" style={{transform:'rotate(180deg)'}}/></button><button className="icon-button" data-reader-directory-trigger="true" aria-label={msg("打开目录")} aria-expanded={panel==='directory'} onClick={()=>togglePanel('directory')}><Icon name="list"/></button></nav><nav className="nc-reader-rail right nc-reader-controls" aria-label={msg("翻译与阅读工具")}>{contentLanguageControl}<button data-reader-settings-trigger="true" aria-label={msg("阅读设置")} title={msg("阅读设置")} aria-expanded={panel==='settings'} onClick={()=>togglePanel('settings')}><Icon name="settings"/><span>{msg("阅读设置")}</span></button></nav><div className="nc-empty"><h1>{copy.title}</h1><h2>{sourceStatus??msg("页面尚未就绪")}</h2><button className="button primary" disabled={busy} onClick={onReload}><Icon name="refresh"/>{msg('重新载入')}</button><button className="button secondary" onClick={()=>setPanel('directory')}>{msg("查看作品目录")}</button></div>{readerPanel}</div>;
return <div ref={root} className={`nc-reader ${immersive?'is-immersive':''} ${hidden?'controls-hidden':''}`} data-background={settings.readerBackground} onPointerMove={e=>{
  const target=e.target as HTMLElement;
  const bounds=e.currentTarget.getBoundingClientRect();
  if(target.closest('.nc-reader-controls')||e.clientX-bounds.left<8||bounds.right-e.clientX<8)reveal();
}} onFocusCapture={e=>{if((e.target as HTMLElement).closest('.nc-reader-controls'))reveal();}}>
<nav className="nc-reader-rail left nc-reader-controls" aria-label={msg("阅读导航")}>
<button aria-label={backLabel} title={backLabel} onClick={leaveReader}><Icon name="arrow" style={{transform:'rotate(180deg)'}}/><span>{backText}</span></button>
<button data-reader-directory-trigger="true" aria-label={msg("打开目录")} title={sourceStatus?`${copy.title} · ${sourceStatus}`:copy.title} aria-expanded={panel==='directory'} onClick={()=>togglePanel('directory')}><Icon name="list"/><span>{msg("目录")}</span>{sourceStatus&&<i className="nc-rail-notice" aria-hidden="true"/>}</button>
<span className="nc-rail-divider"/>
<div className="nc-reader-navigation"><button aria-label={msg("上一页")} title={msg("上一页")} disabled={index===0} onClick={()=>jump(index-1)}><Icon name="chevron" style={{transform:'rotate(-90deg)'}}/></button><label><input aria-label={msg("跳转页码")} type="number" min={1} max={copy.pages.length} value={index+1} onChange={e=>jump(Number(e.target.value)-1)}/><span>/ {copy.pages.length}</span></label><input className="nc-reader-progress" type="range" aria-label={msg("阅读进度")} aria-valuetext={msg("第 {0} 页，共 {1} 页", {"0": index+1, "1": copy.pages.length})} min={1} max={copy.pages.length} step={1} value={index+1} disabled={copy.pages.length===1} onChange={e=>jump(Number(e.target.value)-1)}/><button aria-label={msg("下一页")} title={msg("下一页")} disabled={index>=copy.pages.length-1&&!next} onClick={()=>jump(index+1)}><Icon name="chevron" style={{transform:'rotate(90deg)'}}/></button></div>
</nav>
<PageTranslationBar contentLanguageControl={contentLanguageControl} modes={caps?.modes.filter(m=>m.enabled).map(m=>m.id)} allowsFeedback={allowsFeedback} selectedView={preference==='original'?'original':mode} shownJob={allowsFeedback?shownJob:undefined} onView={selectView} onFeedback={()=>shownJob&&setFeedback({job:{...shownJob},page,number:index+1})} translationLabel={msg("默认翻译 · {0} · {1}", {"0": modeLabels.classic, "1": language})} panel={panel} onPanel={togglePanel}/>
{(sourceNeedsAction||sourceRemoved)&&sourceStatus&&panel!=='directory'&&<div className="nc-source-status nc-source-action nc-reader-controls" role="status"><span>{sourceStatus}</span>{sourceNeedsAction&&!sourceRemoved&&<button onClick={onReload}>{msg("重试")}</button>}</div>}
<div className="nc-reading-viewport" data-scrollbar-mode="hidden" ref={viewport} onScroll={scroll} data-decoded-pages={decodedSet.size} data-page-count={copy.pages.length} onClick={e=>{if(e.target===e.currentTarget||(e.target as HTMLElement).classList.contains('nc-reading-surface')){if(panel)setPanel(undefined);else reveal();}}}>
<div className="nc-reading-surface" style={{minWidth:contentWidth+24}}>{windows.map(({copy:chapter,start,end,before,after},chapterIndex)=><div className="nc-stream-chapter" key={chapter.id} data-copy-id={chapter.id}>{chapterIndex>0&&<div className="nc-chapter-heading"><span>{msg("接着阅读")}</span><h2>{chapter.title}</h2></div>}<div className="nc-page-stack" ref={node=>{if(node)stacks.current.set(chapter.id,node);else stacks.current.delete(chapter.id);}}>{settings.layout==='continuous'&&<div aria-hidden="true" style={{height:before}}/>}{chapter.pages.slice(start,end).map((p,localIndex)=>{const n=start+localIndex;const pageView=view;const identity=scope(p,chapter);const cellKey=pageKey(chapter,p.id);const wantTranslation=pageView.preference!=='original';const {key:targetKey,job:targetJob}=readingImage(p,pageView.mode,wantTranslation,settings.language,translationScope);
const {width,height}=frame(p);return <div className="nc-manga-page" key={cellKey} ref={node=>{if(node)cells.current.set(cellKey,node);else cells.current.delete(cellKey);}} data-page-id={p.id} data-page-index={n} style={{width}}><div className={`nc-page-picture ${compare?'comparison':''}`} style={{height}}>{decodedSet.has(cellKey)?<>{compare&&<div className="nc-comparison-pane"><BlobPicture scope={`${cellKey}:compare`} blobKey={p.blobKey} alt={msg("第 {0} 页", {"0": n+1})} onImport={onImport} error={p.fetchError}/></div>}<div className="nc-comparison-pane"><BlobPicture scope={identity} blobKey={targetKey} job={targetJob} alt={msg("第 {0} 页", {"0": n+1})} error={p.fetchError} sourceUrl={chapter.sourceUrl} onImport={onImport} onShown={image=>{if(image)pageShown(chapter,p.id);setActual(prev=>{if(prev[cellKey]?.key===image?.key&&prev[cellKey]?.scope===image?.scope)return prev;const next={...prev};if(image)next[cellKey]=image;else delete next[cellKey];return next;});}}/></div></>:<div className="nc-image-placeholder"><Icon name="image"/><span>{resources.ready(chapter)?msg("第 {0} 页 · 滚动到此处时加载", {"0": n+1}):msg("正在准备页面…")}</span></div>}{decodedSet.has(cellKey)&&pageView.preference!=='original'&&<ImageTranslationStatus state={translationState(chapter.id,p,pageView.mode)} onUpgrade={onUpgrade} onLogin={onLogin} onRetry={()=>onRetry(p,pageView.mode,chapter.id)}/>}</div></div>;})}{settings.layout==='continuous'&&<div aria-hidden="true" style={{height:after}}/>}</div><div className="nc-reader-end" ref={node=>{if(node)ends.current.set(chapter.id,node);else ends.current.delete(chapter.id);}}>
<Icon name="spark" size={32}/>
{!chapter.pages.length?<><p>{directory?.entries.find(e=>e.id===chapter.id)?.error??directory?.entries.find(e=>e.id===chapter.id)?.status??msg("正在准备页面…")}</p><button className="button secondary" onClick={()=>{preserve();persist();onNavigate(chapter.id);}}>{msg("重试")}</button></>:!completeManifest(chapter)?<><p>{msg("当前已发现 {0} 页", {"0": chapter.pages.length})}</p><small>{msg("完整载入后可继续阅读")}</small></>:settings.layout==='single'&&index<copy.pages.length-1?<p>{msg("第 {0} 页", {"0": index+1})}</p>:<p>{chapterIndex<stream.length-1?msg("继续下滑阅读"):nextOf(chapter)?msg("接着阅读"):msg("已到当前内容末尾")}</p>}

</div></div>)}</div></div>
{readerPanel}

{hidden&&<button className="nc-reveal" aria-label={msg("显示阅读工具")} onClick={reveal}><Icon name="settings" size={20}/></button>}
{allowsFeedback&&feedback&&<FeedbackForm key={feedback.job.id} api={api} job={feedback.job} pageNumber={feedback.number} onClose={()=>setFeedback(undefined)} canRerun={!pageTranslation(copy.pages.find(p=>p.id===feedback.page.id)??feedback.page,feedback.job.mode,feedback.job.target_language,translationScope).pending&&!!caps?.modes.find(m=>m.id===feedback.job.mode)?.enabled&&!busy} onRerun={()=>{const p=copy.pages.find(p=>p.id===feedback.page.id);setFeedback(undefined);if(p){setView(view=>({...view,mode:feedback.job.mode,preference:'translation'}));void Promise.resolve(onRetry(p,feedback.job.mode)).catch(error=>notify(translationNotice({kind:'error',message:error.message}).label));}}}/>}

</div>;
}
function Choice<T extends string>({label,value,options,onChange}:{label:string;value:T;options:readonly {id:T;label:string;icon?:ReactNode}[];onChange:(value:T)=>void}){
  return <div className="field"><span>{label}</span><div className="segmented nc-reader-choices" role="group" aria-label={label}>{options.map(option=><button key={option.id} className={value===option.id?'active':''} aria-pressed={value===option.id} onClick={()=>onChange(option.id)}>{option.icon}{option.label}</button>)}</div></div>;
}
