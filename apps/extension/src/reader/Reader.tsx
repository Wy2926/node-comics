import {Select,SelectOption} from '../ui/Select';
import {LanguageFlag} from '../ui/LanguageFlag';
import {msg} from '../i18n/runtime';
import {translationNotice} from '../translation/notice';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Icon} from '../icons';
import {useShortcuts} from '../shortcuts/react';
import type {Api} from '../api';
import {languageLabel,modeLabels,supportsLanguage,type Capabilities,type ReadingEntry,type Job,type Mode,type Page,type Settings} from '../types';

import {BlobPicture,type ShownImage} from './Images';
import {useProcessingSettings, useEnhancementVisible, useProcessingWindow} from '../image-processing/react';
import {activeProcessingProfile} from '../image-processing/settings';
import {processingInput} from '../comics/application/image-access';
import {canRetryPage,displayTranslationState,imagePrefetchReady,pageTranslation,readingImage,type ImageLoadState} from './presentation';
import {pageFrame} from './geometry';
import {pageWindow,nextImagePages} from './virtual-window';
import {pageSpreads,spreadAt,spreadFrames} from './pagination';
import {DECODED_PAGE_WINDOW} from '../image-resources';
import {ImageTranslationStatus} from './ImageTranslationStatus';
import type {ReadingTarget,TranslationState} from '../translation/automatic';
import {FeedbackForm} from '../ui/Feedback';
import {useChapterStream,pageKey,completeManifest} from './useChapterStream';
import {ThumbnailDirectory} from './ThumbnailDirectory';
import {ComicDirectory,contentLanguageLabel} from './ComicDirectory';
import {acknowledgeCatalogUpdates} from '../comics/application/catalog-service';
import type {ReadingDirectory} from '../comics/application/library-service';
import {PageTranslationBar} from './PageTranslationBar';
import {initialReadingView,readingViewDefaults,readStoredReadingView,saveReadingView,type ReadingView} from './view';
import {track,type AnalyticsFields} from '../analytics';
import type {ReaderAnalytics} from './analytics';
import {useReaderAnalytics} from './useReaderAnalytics';
import {ReaderShell,ReaderNavigation,ReaderTools,ReaderSettingsButton,ReaderDrawer,ReaderNumberInput,compactReaderQuery,isCompactReaderDevice} from './ReaderChrome';
import {ReaderChoice as Choice,ReaderScale,ReaderSettings,ReaderTranslationSettings} from './ReaderSettings';
import {useReaderControls} from './useReaderControls';
import {usePagedSwipe} from './usePagedSwipe';
import {usePagedNavigation} from './usePagedNavigation';
import {useSpreadZoom} from './useSpreadZoom';
import {ignoreReaderClick} from './reader-input';
import {useReaderPrefetch} from './useReaderPrefetch';
import type {ChapterLoadOptions} from './chapter-resources';
import type {ReadingProgressStatus} from '../comics/application/reading-progress';
type Props={progressStatus?:ReadingProgressStatus;backLabel?:string;backText?:string;onFind?:()=>void;searchOpen?:boolean;onOpenShortcuts:()=>void;onSourceLanguageChange?:(language:string|undefined)=>void;viewKey:string;directory?:ReadingDirectory;catalogLoading?:boolean;onContinueCatalog?:()=>void;onReload?:(entryId:string)=>void;onMarkRead:(id:string)=>Promise<void>;sequence:ReadingEntry[];onActiveEntry:(id:string)=>void;onLoadEntry:(id:string,options?:ChapterLoadOptions)=>void|Promise<void>;sourceStatus?:string;onNavigate:(id:string,pageId?:string,rememberChoice?:boolean)=>void;copy:ReadingEntry;settings:Settings;setSettings:(s:Settings|((s:Settings)=>Settings))=>void;update:(copy:ReadingEntry)=>void;onBack:()=>void;onRetry:(page:Page,mode:Mode,entryId?:string)=>void|Promise<void>;onUpgrade:()=>void;onLogin:()=>void;translationState:(entryId:string,page:Page,mode:Mode)=>TranslationState|undefined;onImport:()=>void;notify:(message:string)=>void;onReadingWindow:(targets:ReadingTarget[],visiblePages:Page[],immediate?:boolean)=>void;caps?:Capabilities;modelSelection?:import('../translation/channels/contracts').ModelSelection;fontSelection?:import('../translation/channels/contracts').FontSelection;translationScope?:string;allowsFeedback?:boolean;channelLabel?:string;api:Api;busy:boolean;};
type Panel='directory'|'translation'|'settings';
export function Reader({progressStatus,analyticsSession,analyticsSource='unknown',analyticsChannel,analyticsBlocked=false,backLabel=msg("返回我的漫画"),backText=msg("书架"),onFind,searchOpen=false,onOpenShortcuts,onSourceLanguageChange,viewKey,directory,catalogLoading,onContinueCatalog,onReload,onMarkRead,sourceStatus:reportedSourceStatus,sequence,onActiveEntry,onLoadEntry,onNavigate,copy,settings:globalSettings,setSettings,update,onBack,onRetry,onUpgrade,onLogin,translationState,onImport,notify,onReadingWindow,caps,modelSelection,fontSelection,translationScope,allowsFeedback=false,channelLabel,api,busy}:Props&{analyticsSession?:ReaderAnalytics;analyticsSource?:AnalyticsFields['source_type'];analyticsChannel?:AnalyticsFields['channel'];analyticsBlocked?:boolean}){
const motion=useRef(false),surface=useRef<HTMLDivElement>(null),spreadStack=useRef<HTMLDivElement>(null);
const [moving,setMoving]=useState(false);
const [compactAtOpen]=useState(isCompactReaderDevice);
const [savedView,setView]=useState<ReadingView|undefined>(()=>{
 const page=copy.pages.find(page=>page.id===copy.pageId)??copy.pages[0];
 return readStoredReadingView(viewKey)??initialReadingView(page?.imageSha256?page:undefined,compactAtOpen);
});
const view=savedView??readingViewDefaults();
// Resolve once so streaming, prefetching, gestures and controls use the same comic layout.
const settings={...globalSettings,layout:view.layout??globalSettings.layout,direction:view.direction??globalSettings.direction};
const {index,indexRef,viewport,cells,ends,stacks,geometry,stream,next,nextOf,preserve,persist,restore,scroll,jump:jumpImmediately,navigationReason,pageShown,settleMotion,resources,resourceVersion,readingAhead}=useChapterStream({copy,sequence,layout:settings.layout,motion,update,onActiveEntry,onLoadEntry,onMarkRead,notify});
const sourceRemoved=directory?.entries.find(entry=>entry.id===copy.id)?.sourceRemoved;
const sourceStatus=sourceRemoved?msg('源站已移除，缓存页面仍可阅读。'):reportedSourceStatus;
const page=copy.pages[Math.min(index,copy.pages.length-1)];
const [compare,setCompare]=useState(false);
const [feedback,setFeedback]=useState<{job:Job;number:number}>();const [actual,setActual]=useState<Record<string,ShownImage|undefined>>({});
const [loads,setLoads]=useState<Record<string,ImageLoadState|undefined>>({});
const {root,panel,setPanel,togglePanel,closePanel,immersive,setImmersive,hidden,reveal,toggleControls,fullscreen}=useReaderControls<Panel>({blocked:!!feedback||analyticsBlocked||searchOpen,notify});
const [viewportSize,setViewportSize]=useState({width:900,height:700});
const preservePosition=useRef(preserve);preservePosition.current=preserve;
const previousSearch=useRef(searchOpen);
useEffect(()=>{if(previousSearch.current&&!searchOpen)root.current?.querySelector<HTMLButtonElement>('[data-reader-settings-trigger]')?.focus();previousSearch.current=searchOpen;},[searchOpen]);
const {mode,preference,zoom,fit}=view;const language=caps?.languages.find(l=>l.id===settings.language)?.label??languageLabel(settings.language);
const scopeBase=`${translationScope??''}:${settings.language}`;const scope=(p:Page,c=copy)=>JSON.stringify([scopeBase,c.id,c.contentId,c.generation,p.id]);
const shown=page&&actual[pageKey(copy,page.id)]?.scope===scope(page)?actual[pageKey(copy,page.id)]:undefined;const shownJob=shown?.job;
function imageLoad(chapter:ReadingEntry,p:Page,key?:string){const load=loads[pageKey(chapter,p.id)];return load?.scope===scope(p,chapter)&&load.key===key?load:undefined;}
function recordLoad(key:string,state:ImageLoadState|undefined){setLoads(prev=>{if(prev[key]===state)return prev;const next={...prev};if(state)next[key]=state;else delete next[key];return next;});}
const currentImage=page&&readingImage(page,mode,preference!=='original',settings.language,translationScope);
const currentLoad=page&&imageLoad(copy,page,currentImage?.key);
const currentState=page&&displayTranslationState(translationState(copy.id,page,mode),currentLoad,currentImage?.job?currentImage.key:undefined);
const canRetry=!!page&&!busy&&!!caps?.modes.find(m=>m.id===mode)?.enabled&&supportsLanguage(caps,mode,settings.language)&&canRetryPage(pageTranslation(page,mode,settings.language,translationScope),currentState);
async function retryCurrentPage(){
  if(!page||!canRetry)return;
  selectView(mode);
  try{await onRetry(page,mode,copy.id);}catch(error){notify(translationNotice({kind:'error',message:error instanceof Error?error.message:msg('重试失败')}).label);}
}
const analytics=useReaderAnalytics({session:analyticsSession,viewport,cells,actual,dimensions:{source_type:analyticsSource,format:['cbz','zip','cbr','rar','pdf','mobi','website','image-sequence'].includes(copy.source)?copy.source as AnalyticsFields['format']:'unknown',layout:settings.layout,mode:compare?'compare':preference==='original'?'original':mode,target_language:settings.language as AnalyticsFields['target_language']},channel:analyticsChannel,pageCount:copy.pages.length,blocked:moving||analyticsBlocked||searchOpen||!!panel||!!feedback,quotaBlocked:!!page&&preference!=='original'&&translationState(copy.id,page,mode)?.kind==='upgrade'});
useEffect(()=>{if(!moving&&shown&&copy.comicId&&copy.catalogUpdateRevision)void acknowledgeCatalogUpdates(copy.comicId,copy.catalogUpdateRevision).catch(()=>{});},[moving,!!shown,copy.comicId,copy.catalogUpdateRevision]);
const streamPages=useMemo(()=>stream.filter(chapter=>resources.ready(chapter)).flatMap(c=>c.pages.map(p=>({page:p,key:pageKey(c,p.id),entryId:c.id}))),[stream,resourceVersion]);
useEffect(()=>{setFeedback(undefined);},[copy.id]);
useEffect(()=>{setActual({});setLoads({});setFeedback(undefined);},[scopeBase]);
useEffect(()=>{
 if(savedView)return;
 // Compact defaults wait for real image dimensions, not descriptor placeholders.
 const initialView=initialReadingView(page?.imageSha256?page:undefined,compactAtOpen);
 if(initialView){preserve();setView(previous=>previous??initialView);}
},[savedView,page?.id,page?.imageSha256,page?.width,page?.height]);
useEffect(()=>{if(savedView)saveReadingView(viewKey,savedView);},[viewKey,savedView]);
useEffect(()=>{
 if(!viewport.current)return;
 let measured=false;
 const observer=new ResizeObserver(([entry])=>{
  // The first measurement must restore the saved anchor, not preserve a rounded placeholder layout.
  if(measured)preservePosition.current();measured=true;
  setViewportSize({width:entry.contentRect.width,height:entry.contentRect.height});
 });
 observer.observe(viewport.current);return()=>observer.disconnect();
},[!!page]);
const spreads=useMemo(()=>settings.layout==='double'?pageSpreads(copy.pages):[],[copy.pages,settings.layout]);
const spread=spreadAt(spreads,index);
const spreadPages=useMemo(()=>spread?copy.pages.slice(spread.start,spread.end):[],[copy.pages,spread]);
const frames=useMemo(()=>new Map(spreadFrames(spreadPages,viewportSize,compare).map((frame,n)=>[spreadPages[n].id,frame])),[spreadPages,viewportSize,compare]);
const frame=(p:Page)=>frames.get(p.id)??pageFrame(p,viewportSize,fit,zoom,compare);
const windows=useMemo(()=>settings.layout==='continuous'
 ?pageWindow(stream,copy.id,index,p=>frame(p).height,DECODED_PAGE_WINDOW)
 :[{copy,start:spread?.start??index,end:spread?.end??Math.min(index+1,copy.pages.length),offsets:[],before:0,after:0}],
 [stream,copy,index,viewportSize,fit,zoom,compare,settings.layout,spread]);
const decodedSet=useMemo(()=>new Set(windows.filter(({copy:chapter})=>resources.ready(chapter)).flatMap(({copy:chapter,start,end})=>chapter.pages.slice(start,end).map(p=>pageKey(chapter,p.id)))),[windows,resourceVersion]);
const processingSettings=useProcessingSettings(),processingProfile=activeProcessingProfile(processingSettings),enhancementVisible=useEnhancementVisible();
const readingTargets=useMemo(()=>{
 const start=streamPages.findIndex(item=>item.key===pageKey(copy,copy.pages[spread?.start??index]?.id??''));
 return start<0?[]:streamPages.slice(start,start+readingAhead).map(item=>({...item,mode}));
},[streamPages,copy.id,spread,index,readingAhead,mode]);
const processingTargets=useMemo(()=>readingTargets.map(({key,entryId,page})=>{
 const translated=preference!=='original',image=readingImage(page,mode,translated,settings.language,translationScope);
 return {id:key,sourceKey:page.blobKey,input:image.key&&(!translated||image.job||image.originalResult)?processingInput(image.key,entryId,page.blobKey):undefined};
}),[readingTargets,preference,mode,settings.language,translationScope]);
const enhancedImages=useProcessingWindow(processingTargets,enhancementVisible?processingProfile:undefined,processingSettings.cacheRevision,navigationReason.current==='direct');
geometry.current=new Map(windows.map(window=>[window.copy.id,window]));
const contentWidth=spread?spreadPages.reduce((width,page)=>width+frame(page).width,0)
 :settings.layout==='single'?(page?frame(page).width:0)
 :stream.reduce((width,chapter)=>chapter.pages.reduce((width,page)=>Math.max(width,frame(page).width),width),0);
const swipeBlocked=!!searchOpen||!!feedback||!!analyticsBlocked||!!panel;
const spreadZoom=useSpreadZoom({viewport,stack:spreadStack,enabled:settings.layout==='double'&&!!page,blocked:swipeBlocked||moving,
 resetKey:JSON.stringify([viewKey,copy.id,copy.contentId,copy.generation,spread?.start,spread?.end,settings.layout,settings.direction,viewportSize.width,viewportSize.height,compare,spreadPages.map(p=>[p.width,p.height])]),
});
const canTurn=(offset:-1|1)=>!!page&&(offset<0?(spread?.start??indexRef.current)>0:(spread?.end??indexRef.current+1)<copy.pages.length||!!next);
const imageWindows=useMemo(()=>windows.filter(({copy:chapter,start,end})=>end>start&&resources.ready(chapter)),[windows,resourceVersion]);
// The chosen next chapter is metadata only in paged layouts, never a hidden reading/translation window.
const aheadChapter=next&&resources.ready(next)&&imageWindows.at(-1)?.copy.id===copy.id?next:undefined;
const aheadPages=useMemo(()=>nextImagePages(imageWindows,settings.layout,aheadChapter),[imageWindows,settings.layout,aheadChapter]);
const windowReady=!!imageWindows.length&&imageWindows.every(({copy:chapter,start,end})=>chapter.pages.slice(start,end).every(p=>{
 const key=pageKey(chapter,p.id),identity=scope(p,chapter),target=readingImage(p,mode,preference!=='original',settings.language,translationScope);
 const original=loads[`${key}:compare`];
 return imagePrefetchReady(identity,actual[key],imageLoad(chapter,p,target.key))&&(!compare||original?.key===p.blobKey&&imagePrefetchReady(`${identity}:compare`,undefined,original));
}));
const prefetchIdentities=new Map<string,string>();
for(const {copy:chapter,start,end} of imageWindows)for(const p of chapter.pages.slice(start,end+2))if(p.blobKey)prefetchIdentities.set(p.blobKey,scope(p,chapter));
if(aheadChapter)for(const p of aheadChapter.pages.slice(0,2))if(p.blobKey)prefetchIdentities.set(p.blobKey,scope(p,aheadChapter));
useReaderPrefetch({scope:JSON.stringify([viewKey,scopeBase]),identities:prefetchIdentities,
 current:imageWindows.flatMap(({copy:chapter,start,end})=>chapter.pages.slice(start,end).flatMap(p=>p.blobKey?[p.blobKey]:[])),
 next:aheadPages.flatMap(p=>p.blobKey?[p.blobKey]:[]),enabled:resources.ready(copy),ready:windowReady&&!moving,
});
const swipe=usePagedSwipe({viewport,surface,enabled:settings.layout!=='continuous'&&!!page,blocked:swipeBlocked||spreadZoom.zoomed,direction:settings.direction,
 identity:JSON.stringify([copy.id,copy.contentId,copy.generation,page?.id]),
 resetKey:JSON.stringify([viewKey,copy.id,copy.contentId,copy.generation,settings.layout,settings.direction,viewportSize.width,viewportSize.height,fit,zoom,compare,mode,preference,scopeBase]),
 canTurn,
 onTurn:movePage,onActivityChange:active=>{motion.current=active;setMoving(active);},onSettled:settleMotion,
});
const pagedNavigation=usePagedNavigation({viewport,enabled:settings.layout!=='continuous'&&!!page,blocked:swipeBlocked||spreadZoom.zoomed||moving,direction:settings.direction,canTurn,onTurn:swipe.turn});
useLayoutEffect(()=>{restore();},[viewportSize,fit,zoom,compare,settings.layout,!!page]);
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
 'reader.layout':()=>changeLayout(settings.layout==='continuous'?'single':settings.layout==='single'?'double':'continuous'),
 'reader.fit':()=>changeFit(fit==='window'?'width':'window'),
 'reader.immersive':()=>setImmersive(value=>!value),
 'reader.fullscreen':()=>{void fullscreen();},
 'reader.back':leaveReader,
 'reader.find':()=>{if(!onFind)return false;findComic();},
},{enabled:!searchOpen&&!feedback&&!analyticsBlocked});
useEffect(()=>{
 onReadingWindow(preference==='original'?[]:readingTargets,streamPages.filter(p=>decodedSet.has(p.key)).map(p=>p.page),navigationReason.current==='direct');
},[readingTargets,streamPages,decodedSet,preference,onReadingWindow]);
useEffect(()=>()=>onReadingWindow([],[]),[onReadingWindow]);
function navigate(offset:-1|1){if(!page)return false;if(spreadZoom.zoomed){if(swipeBlocked||!canTurn(offset))return false;swipe.cancel();spreadZoom.reset();movePage(offset);return;}return swipe.turn(offset);}
function jump(n:number){swipe.cancel();spreadZoom.reset();jumpImmediately(n);}
function movePage(offset:-1|1){
 if(!page)return false;
 const current=spreadAt(spreads,indexRef.current);
 jumpImmediately(current?(offset>0?current.end:spreadAt(spreads,current.start-1)?.start??0):indexRef.current+offset);
}
function reloadContent(chapter:ReadingEntry){if(busy||!onReload)return;swipe.cancel();preserve();persist();onReload(chapter.id);}
function leaveReader(){swipe.cancel();preserve();persist();onBack();}
function openShortcuts(){setPanel(undefined);reveal();onOpenShortcuts();}
function findComic(){swipe.cancel();preserve();persist();setPanel(undefined);onFind?.();}
function changeLayout(layout:Settings['layout']|undefined){swipe.cancel();preserve();updateView(view=>({...view,layout,...(layout==='double'&&settings.layout!=='double'?{direction:'rtl' as const}:{})}));}
function changeDirection(direction:Settings['direction']){swipe.cancel();preserve();updateView(view=>({...view,direction}));}
function updateView(change:(view:ReadingView)=>ReadingView){setView(previous=>change(previous??view));}
function changeFit(fit:Settings['fit']){if(settings.layout==='double')return false;preserve();updateView(view=>({...view,fit}));}
function changeZoom(value:number|((zoom:number)=>number)){
 if(!page)return false;if(settings.layout==='double'){spreadZoom.change(value);return;}preserve();
 updateView(view=>{const nextZoom=Math.max(40,Math.min(200,typeof value==='function'?value(view.zoom):value));return nextZoom===view.zoom?view:{...view,zoom:nextZoom};});
}
function toggleCompare(){
 if(!page||!compare&&caps&&!caps.modes.some(item=>item.id==='classic'&&item.enabled))return false;
 preserve();recordView(compare?(preference==='original'?'original':mode):'compare');
 setCompare(value=>!value);
 if(!compare)updateView(view=>({...view,preference:'translation'}));
}
function recordView(value:'original'|Mode|'compare'){
  track('translation_view_changed',{surface:'reader',mode:value,...(analyticsChannel?{channel:analyticsChannel}:{}),target_language:settings.language as AnalyticsFields['target_language']});
  if(value!=='original'&&analyticsChannel&&(preference==='original'||value!=='compare'&&value!==mode))analytics.requestTranslation(performance.now(),{channel:analyticsChannel,mode:value==='compare'?mode:value,target_language:settings.language as AnalyticsFields['target_language']});
}
function selectView(value:'original'|Mode){
  if(!page||value!=='original'&&caps&&!caps.modes.some(item=>item.id===value&&item.enabled))return false;
  if(value!==(preference==='original'?'original':mode))recordView(value);
  preserve();
  updateView(view=>({...view,mode:value==='original'?mode:value,preference:value==='original'?'original':'translation'}));
  if(value==='original')setCompare(false);
}
const contentLanguageControl=onSourceLanguageChange&&directory?.entries.some(entry=>entry.contentLanguage)&&<Select className="nc-reader-language" placement="left" menuWidth={280} aria-label={msg('内容语言偏好')} title={msg('内容语言偏好')} value={directory.sourceLanguagePreference??''} onFocus={()=>setPanel(undefined)} onChange={event=>onSourceLanguageChange(event.target.value||undefined)} trigger={<><LanguageFlag language={directory.sourceLanguagePreference??settings.language}/><span>{msg('内容语言偏好')}</span></>}>
 <SelectOption value="" icon={<LanguageFlag language={settings.language}/>}>{msg('跟随翻译目标')}</SelectOption>
 {[...new Set(['zh',...directory.entries.flatMap(entry=>entry.contentLanguage?[entry.contentLanguage]:[]),...(directory.sourceLanguagePreference?[directory.sourceLanguagePreference]:[])])].map(language=><SelectOption key={language} value={language} icon={<LanguageFlag language={language}/>}>{language==='zh'?msg('中文（不限简繁）'):contentLanguageLabel(language)}</SelectOption>)}
</Select>;
const sourceActions=!sourceRemoved&&<>
 {onReload&&<button className="button secondary" disabled={busy} onClick={()=>reloadContent(copy)}><Icon name="refresh" size={16}/>{msg('重新载入')}</button>}
 {copy.sourceUrl&&<a className="button secondary" href={copy.sourceUrl} target="_blank" rel="noopener noreferrer">{msg('返回来源网页')}</a>}
</>;
const readerPanel=panel&&<ReaderDrawer kind={panel} title={{directory:msg('目录'),translation:msg('翻译设置'),settings:msg('阅读设置')}[panel]} label={{directory:msg('漫画目录'),translation:msg('翻译选项'),settings:msg('阅读设置')}[panel]} onClose={closePanel}>
{panel==='directory'&&sourceStatus&&<div className="nc-source-status" role="status"><span>{sourceStatus}</span>{sourceActions}</div>}
{panel==='directory'?<ComicDirectory catalogLoading={catalogLoading} onContinueCatalog={onContinueCatalog} directory={directory??{title:copy.title,entries:[],groups:[],chapters:[]}} index={index} pageCount={copy.pages.length} onNavigate={(id,pageId,rememberChoice)=>{swipe.cancel();preserve();persist();onNavigate(id,pageId,rememberChoice);if(window.matchMedia(compactReaderQuery).matches)closePanel();}}><ThumbnailDirectory pages={resources.ready(copy)?copy.pages:[]} index={index} mode='classic' language={settings.language} translationScope={translationScope} onJump={n=>{jump(n);if(window.matchMedia(compactReaderQuery).matches)closePanel();}}/></ComicDirectory>:<div className="nc-drawer-content">
{panel==='translation'?<ReaderTranslationSettings settings={globalSettings} setSettings={setSettings} caps={caps} channelLabel={channelLabel} modelSelection={modelSelection} fontSelection={fontSelection} note={msg('选择译图后，随读预翻译后续页面；查看方式仅对此漫画生效。')}/>:<ReaderSettings allowDouble settings={globalSettings} setSettings={setSettings} layout={view.layout} direction={settings.direction} onLayout={changeLayout} onDirection={changeDirection}
 sizing={<>{settings.layout!=='double'&&<Choice label={msg('图片适应方式')} value={fit} options={[{id:'window',label:msg('适应窗口'),icon:<Icon name="expand" size={16}/>},{id:'width',label:msg('铺满宽度'),icon:<Icon name="split" size={16}/>}]} onChange={changeFit}/>}<ReaderScale label={msg('缩放')} value={settings.layout==='double'?Math.round(spreadZoom.zoom):zoom} min={settings.layout==='double'?100:40} max={settings.layout==='double'?400:200} onChange={changeZoom}/></>}
 immersive={immersive} onImmersive={()=>setImmersive(v=>!v)} onFullscreen={()=>void fullscreen()} onShortcuts={openShortcuts} onReload={onReload?()=>reloadContent(copy):undefined} busy={busy}
 extraActions={onFind&&<button className="button secondary" onClick={findComic}><Icon name="translate"/><span>{msg('寻找其他语言')}</span></button>}>
 <div className="nc-reader-option"><div><b>{msg('并排对照')}</b><p>{msg('原图与当前模式最新译图')}</p></div><button className={`switch ${compare?'on':''}`} role="switch" aria-label={msg('并排对照')} aria-checked={compare} onClick={toggleCompare}><i/></button></div>
</ReaderSettings>}
</div>}
</ReaderDrawer>;
if(!page)return <ReaderShell ref={root} background={settings.readerBackground} immersive={immersive} hidden={hidden} reveal={reveal}>
 <ReaderNavigation backLabel={backLabel} backText={backText} title={copy.title} onBack={leaveReader} progressStatus={progressStatus} directoryOpen={panel==='directory'} onDirectory={()=>togglePanel('directory')}/>
 <ReaderTools label={msg("翻译与阅读工具")} above={Number(!!contentLanguageControl)} below={1}><div className="nc-reader-tool-group">{contentLanguageControl}</div><span className="nc-rail-divider" aria-hidden="true"/><div className="nc-reader-tool-group"><ReaderSettingsButton open={panel==='settings'} onClick={()=>togglePanel('settings')}/></div></ReaderTools>
 <div className="nc-empty"><h1>{copy.title}</h1><h2>{sourceStatus??msg("页面尚未就绪")}</h2>{sourceActions}<button className="button secondary" onClick={()=>setPanel('directory')}>{msg("查看作品目录")}</button></div>{readerPanel}
</ReaderShell>;
return <ReaderShell ref={root} background={settings.readerBackground} immersive={immersive} hidden={hidden} reveal={reveal}>
<ReaderNavigation backLabel={backLabel} backText={backText} title={copy.title} notice={sourceStatus} onBack={leaveReader} progressStatus={progressStatus} directoryOpen={panel==='directory'} onDirectory={()=>togglePanel('directory')}>
<div className="nc-reader-navigation"><button aria-label={msg("上一页")} title={msg("上一页")} disabled={(spread?.start??index)===0} onClick={()=>navigate(-1)}><Icon name="chevron" style={{transform:'rotate(-90deg)'}}/></button><label><ReaderNumberInput label={msg("跳转页码")} value={index+1} max={copy.pages.length} onCommit={value=>jump(value-1)}/><span>/ {copy.pages.length}</span></label><input className="nc-reader-progress" type="range" aria-label={msg("阅读进度")} aria-valuetext={msg("第 {0} 页，共 {1} 页", {"0": index+1, "1": copy.pages.length})} min={1} max={copy.pages.length} step={1} value={index+1} disabled={copy.pages.length===1} onChange={e=>jump(Number(e.target.value)-1)}/><button aria-label={msg("下一页")} title={msg("下一页")} disabled={(spread?.end??index+1)>=copy.pages.length&&!next} onClick={()=>navigate(1)}><Icon name="chevron" style={{transform:'rotate(90deg)'}}/></button></div>
</ReaderNavigation>
<PageTranslationBar contentLanguageControl={contentLanguageControl} modes={caps?.modes.filter(m=>m.enabled).map(m=>m.id)} allowsFeedback={allowsFeedback} selectedView={preference==='original'?'original':mode} shownJob={allowsFeedback?shownJob:undefined} onView={selectView} onFeedback={()=>shownJob&&setFeedback({job:{...shownJob},number:index+1})} onRetry={retryCurrentPage} canRetry={canRetry} translationLabel={msg("默认翻译 · {0} · {1}", {"0": modeLabels.classic, "1": language})} panel={panel} onPanel={togglePanel}/>
{sourceStatus&&panel!=='directory'&&<div className="nc-source-status nc-source-action nc-reader-controls" role="status"><span>{sourceStatus}</span>{sourceActions}</div>}
<div className="nc-reading-viewport" data-layout={settings.layout} data-swipe-enabled={settings.layout!=='continuous'&&!swipeBlocked&&!spreadZoom.zoomed&&contentWidth<=viewportSize.width+1} data-scrollbar-mode="hidden" ref={viewport} onScroll={scroll} data-decoded-pages={decodedSet.size} data-page-count={copy.pages.length} onPointerDown={pagedNavigation.onPointerDown} onPointerMove={pagedNavigation.onPointerMove} onPointerLeave={pagedNavigation.onPointerLeave} onClickCapture={e=>{swipe.clickCapture(e);spreadZoom.clickCapture(e);}} onClick={e=>{if(ignoreReaderClick(e)||pagedNavigation.click(e))return;toggleControls();}}>
<div className="nc-reading-clip" style={{minWidth:contentWidth}}><div className="nc-reading-surface" ref={surface} style={{minWidth:contentWidth}}>{windows.map(({copy:chapter,start,end,before,after},chapterIndex)=>{const continuation=completeManifest(chapter)&&!!nextOf(chapter);return <div className="nc-stream-chapter" key={chapter.id} data-copy-id={chapter.id}>{chapterIndex>0&&<div className="nc-chapter-heading"><h2 title={chapter.title}>{chapter.title}</h2></div>}<div className="nc-page-stack" data-direction={settings.direction} ref={node=>{if(node)stacks.current.set(chapter.id,node);else stacks.current.delete(chapter.id);if(chapter.id===copy.id)spreadStack.current=node;}}>{settings.layout==='continuous'&&<div aria-hidden="true" style={{height:before}}/>}{chapter.pages.slice(start,end).map((p,localIndex)=>{const n=start+localIndex;const pageView=view;const identity=scope(p,chapter);const cellKey=pageKey(chapter,p.id);const wantTranslation=pageView.preference!=='original';const {key:targetKey,job:targetJob}=readingImage(p,pageView.mode,wantTranslation,settings.language,translationScope);
const load=imageLoad(chapter,p,targetKey),state=displayTranslationState(translationState(chapter.id,p,pageView.mode),load,targetJob?targetKey:undefined);
const {width,height}=frame(p);return <div className="nc-manga-page" key={cellKey} ref={node=>{if(node)cells.current.set(cellKey,node);else cells.current.delete(cellKey);}} data-page-id={p.id} data-page-index={n} style={{width}}>
<div className={`nc-page-picture ${compare?'comparison':''}`} style={{height}}>{decodedSet.has(cellKey)?<>{compare&&<div className="nc-comparison-pane"><BlobPicture scope={`${identity}:compare`} blobKey={p.blobKey} alt={msg("第 {0} 页", {"0": n+1})} onImport={onImport} error={p.fetchError} sourceUrl={chapter.sourceUrl} reloadBusy={busy} onReload={onReload?()=>reloadContent(chapter):undefined} onLoadState={state=>recordLoad(`${cellKey}:compare`,state)}/></div>}<div className="nc-comparison-pane"><BlobPicture scope={identity} originalKey={p.blobKey} blobKey={targetKey} job={targetJob} alt={msg("第 {0} 页", {"0": n+1})} error={p.fetchError} sourceUrl={chapter.sourceUrl} onImport={onImport} reloadBusy={busy} onReload={onReload?()=>reloadContent(chapter):undefined}
enhancement={enhancedImages.get(cellKey)}
onLoadState={state=>recordLoad(cellKey,state)}
onShown={image=>{if(image)pageShown(chapter,p.id);setActual(prev=>{if(prev[cellKey]?.key===image?.key&&prev[cellKey]?.scope===image?.scope)return prev;const next={...prev};if(image)next[cellKey]=image;else delete next[cellKey];return next;});}}/></div></>:<div className="nc-image-placeholder"><Icon name="image"/><span>{msg("正在准备页面…")}</span></div>}</div>
{decodedSet.has(cellKey)&&wantTranslation&&<div className="nc-image-status-layer"><ImageTranslationStatus state={state} onUpgrade={onUpgrade} onLogin={onLogin} onRetry={()=>load?.phase==='error'?load.retry():onRetry(p,pageView.mode,chapter.id)}/></div>}
</div>;})}{settings.layout==='continuous'&&<div aria-hidden="true" style={{height:after}}/>}</div><div className={`nc-reader-end${continuation?' nc-chapter-seam':''}`} data-paged={settings.layout!=='continuous'} ref={node=>{if(node)ends.current.set(chapter.id,node);else ends.current.delete(chapter.id);}}>
{settings.layout==='continuous'?<>{!continuation&&<Icon name="spark" size={32}/>}
{!chapter.pages.length?<><p>{directory?.entries.find(e=>e.id===chapter.id)?.error??directory?.entries.find(e=>e.id===chapter.id)?.status??msg("正在准备页面…")}</p><button className="button secondary" onClick={()=>{preserve();persist();onNavigate(chapter.id);}}>{msg("重试")}</button></>:!completeManifest(chapter)?<><p>{msg("当前已发现 {0} 页", {"0": chapter.pages.length})}</p><small>{msg("完整载入后可继续阅读")}</small></>:!continuation&&<p>{msg("已到当前内容末尾")}</p>}</>
 :!completeManifest(chapter)&&end===chapter.pages.length&&<div className="nc-paged-notice" role="status"><p>{msg("当前已发现 {0} 页", {"0": chapter.pages.length})}</p><small>{msg("完整载入后可继续阅读")}</small></div>}
</div></div>;})}</div></div></div>
{readerPanel}

{allowsFeedback&&feedback&&<FeedbackForm key={feedback.job.id} api={api} job={feedback.job} pageNumber={feedback.number} onClose={()=>setFeedback(undefined)}/>}

</ReaderShell>;
}
