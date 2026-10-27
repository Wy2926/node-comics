import {catalog} from '../src/comics/repositories';
import {applyBookmark} from '../src/comics/application/bookmarks';
import {pageReference,RENDER_PROFILE} from '../src/comics/pages/identity';
import {Scrollbars} from '../src/ui/Scrollbars';
/** Development-only, synthetic data on a dedicated origin. Never calls a supplier or cloud API. */
import {useCallback,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Reader} from '../src/reader/Reader';
import type {ChapterLoadOptions} from '../src/reader/chapter-resources';
import {ShortcutPanel} from '../src/ui/shortcuts/ShortcutPanel';
import {Preferences} from '../src/ui/Preferences';
import {useUiLocale} from '../src/i18n/react';
import {useShortcuts} from '../src/shortcuts/react';
import {defaults,type Page,type ReadingEntry,type Settings} from '../src/types';
import type {ReadingTarget} from '../src/translation/automatic';
import {sourcePageCache} from '../src/storage/source-pages';
import {thumbnailCache} from '../src/storage/thumbnails';
import {readerLoadingMetrics} from './reader-loading-metrics';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if(location.hostname!=='127.0.0.1'||location.port!=='5181')throw Error('Use the isolated 127.0.0.1:5181 fixture origin.');
const query=new URLSearchParams(location.search),pagination=query.get('pagination')==='1',highResolution=!pagination&&query.get('highres')==='1',lazyChapters=pagination&&query.get('lazyChapters')==='1',layoutSettings=pagination&&query.get('layoutSettings')==='1';
document.documentElement.dataset.appearance=query.get('theme')==='dark'?'dark':'light';
document.documentElement.dataset.accent=query.get('accent')??'sky';
document.documentElement.style.setProperty('--text-scale',query.has('largeText')?'1.25':'1');
const performanceFixture=!pagination&&!highResolution&&query.get('performance')==='1';
const scrubFixture=query.get('scrub')==='1';
let scrubPointer:{y:number;moves:string[]}|undefined;
const turnFixture=query.get('turns')==='1';
const FlipMetrics=query.has('curl')?(await import('./reader-flip-metrics')).ReaderFlipMetrics:undefined;
const priorityFixture=pagination&&query.get('priority')==='1';
const thumbnailFixture=query.get('thumbnails')==='1';
const readOrder:string[]=[];
let bookmarkImageReads=0;
if(query.has('bookmarks')){const get=sourcePageCache.get.bind(sourcePageCache);sourcePageCache.get=async key=>{bookmarkImageReads++;return get(key);};}
// Leave a synthetic held-key preview open so native Escape/blur and the label can be checked.
function previewProgress(report:(message:string)=>void){
 const input=document.querySelector<HTMLInputElement>('.nc-reader-progress');if(!input)return;
 const reads=bookmarkImageReads,position=document.querySelector<HTMLElement>('.nc-reader-position')?.dataset.value;
 input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
 const target=query.get('preview')==='end'?Number(input.max):query.get('preview')==='start'?Number(input.min):Math.min(12,Number(input.max));
 for(let step=1;step<=12;step++){
  const value=Math.round(Number(input.min)+(target-Number(input.min))*step/12);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,String(value));
  input.dispatchEvent(new Event('input',{bubbles:true}));
 }
 requestAnimationFrame(()=>{
  const lens=document.querySelector<HTMLElement>('.nc-reader-progress-preview'),bounds=lens?.getBoundingClientRect();
  const count=document.querySelector<HTMLElement>('.nc-reader-position');
  report(`预览 ${input.value}；正文 ${count?.dataset.value}（原 ${position}）；额外读图 ${bookmarkImageReads-reads}；浮窗 ${bounds?`${Math.round(bounds.width)}×${Math.round(bounds.height)}`:'无'}；越界 ${!!bounds&&(bounds.left<0||bounds.right>innerWidth||bounds.top<0||bounds.bottom>innerHeight)}；页码溢出 ${!!count&&count.scrollWidth>count.clientWidth}`);
 });
}
const fractionalDimensions=performanceFixture&&query.get('fractional')==='1';
const width=highResolution?4000:fractionalDimensions?817:800,height=highResolution?6000:fractionalDimensions?1203:1200,chapterCount=pagination?(query.get('chapters')==='3'?3:query.get('chapters')==='2'?2:1):highResolution?1:performanceFixture?3:30,pageCount=pagination?(query.get('pages')==='32'?32:query.get('pages')==='16'?16:query.get('long')==='1'?9:8):highResolution?24:performanceFixture&&query.get('pages')==='1000'?1000:120;
// Opt-in geometry-read counts belong to this fixture, not the production reader.
let dimensionReads=0;
if(performanceFixture)Object.assign(window,{__readerFixturePerformance:{
 reset:()=>{dimensionReads=0;},
 snapshot:()=>({dimensionReads}),
}});
const failedIndex=pagination?(query.get('failure')==='1'?5:-1):7;
// Long-page samples must not reuse a portrait thumbnail from an earlier fixture visit.
const paginationSample=query.get('long')==='1'?'pagination-fixture-long':'pagination-fixture';
const originalKey=(chapter:number,index:number)=>pagination?`inline-original:${paginationSample}-${chapter}-${index}`:highResolution?`inline-original:window-fixture-high-${chapter}-${index}`:'inline-original:window-fixture';
const resultKey=(pageId:string)=>pagination?`inline-original:${paginationSample}-result-${pageId}`:highResolution?`inline-original:window-fixture-high-result-${pageId}`:'inline-original:window-fixture-result';
const dimensions=(index:number)=>pagination&&query.has('unequal')&&index===1?{width:600,height:1200}:pagination&&index===3?{width:1600,height:1000}:pagination&&index===8&&query.get('long')==='1'?{width:800,height:4000}:{width,height};
const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d')!;
context.scale(width/800,height/1200);
context.fillStyle='#f1e8ff';context.fillRect(0,0,800,1200);context.fillStyle='#ab87d8';context.fillRect(40,40,720,800);
context.fillStyle='#fff';context.font='bold 54px sans-serif';context.fillText('WINDOW FIXTURE',115,210);context.font='36px sans-serif';context.fillText('Synthetic local image',120,310);
const originalBlob=await canvas.convertToBlob({type:'image/png'});
context.fillStyle='#fff';context.fillText('TRANSLATED RESULT',115,420);
const translatedBlob=await canvas.convertToBlob({type:'image/png'});
if(!highResolution&&!pagination){await sourcePageCache.put(originalKey(0,0),originalBlob);await sourcePageCache.put(resultKey(''),translatedBlob);}
const samples:ReadingEntry[]=Array.from({length:chapterCount},(_,chapter)=>({id:`window-fixture-${chapter}`,title:`第 ${chapter+1} 章 · 窗口验收`,source:'fixture',sourceKey:`window-fixture-${chapter}`,generation:1,retention:'offline',createdAt:0,updatedAt:0,discoveryComplete:true,pageId:`window-page-${chapter}-0`,relativeOffset:0,pages:Array.from({length:pageCount},(_,index)=>({id:`window-page-${chapter}-${index}`,name:`第 ${index+1} 页`,...dimensions(index),blobKey:index===failedIndex?undefined:originalKey(chapter,index),fetchError:index===failedIndex?'隔离样本：本页读取失败，可重试。':undefined,jobs:[],outputBlobs:{}}))}));
if(query.has('bookmarks')){
 const comicId='bookmark-ui-fixture';
 await catalog.put('connections',{id:'local',provider:'local',displayName:'Local fixture',status:'connected',generation:1,createdAt:1,updatedAt:1});
 await catalog.put('comics',{id:comicId,title:'书签验收',sourceKey:comicId,source:{connectionId:'local',providerItemId:comicId,locator:{},status:'active',generation:1},sourceName:'Fixture',createdAt:1,updatedAt:1});
 for(const [order,chapter] of samples.entries()){
  chapter.comicId=comicId;chapter.contentId=chapter.id+':content';
  await catalog.put('entries',{id:chapter.id,comicId,contentId:chapter.contentId,title:chapter.title,order,format:'cbz',generation:1,indexState:'ready',createdAt:1,updatedAt:1});
  await catalog.putPages(chapter.id,chapter.contentId,chapter.pages.map((page,ordinal)=>({pageId:page.id,contentId:chapter.contentId!,ordinal,name:page.name,formatLocator:String(ordinal),locator:{}})),1);
  for(const page of chapter.pages)if(page.blobKey)page.blobKey=pageReference({entryId:chapter.id,contentId:chapter.contentId,pageId:page.id,renderProfileId:RENDER_PROFILE});
 }
}
if(performanceFixture)for(const chapter of samples)for(const page of chapter.pages)for(const dimension of ['width','height'] as const){
 const value=page[dimension];Object.defineProperty(page,dimension,{enumerable:true,configurable:true,get:()=>{dimensionReads++;return value;}});
}
// Reuse two encoded PNGs; independent keys expose per-page reads and resource retention.
if(highResolution)for(const chapter of samples)for(const page of chapter.pages){if(page.blobKey)await sourcePageCache.put(page.blobKey,originalBlob);await sourcePageCache.put(resultKey(page.id),translatedBlob);}
// Distinctly labelled pages: cover, portrait pair, landscape, then portrait pairs.
// Each key owns real local image bytes so eviction and independent failures are observable.
if(pagination)for(const chapter of samples)for(const page of chapter.pages){
 const sample=new OffscreenCanvas(page.width,page.height),paint=sample.getContext('2d')!;
 const sampleNumber=Number(page.id.split('-').at(-1));
 paint.fillStyle=query.has('curl')?['#e3f2fc','#fff0ce','#e1f5e8','#f4e8ff'][sampleNumber%4]:'#f1e8ff';paint.fillRect(0,0,page.width,page.height);
 paint.strokeStyle='#ab87d8';paint.lineWidth=16;paint.strokeRect(16,16,page.width-32,page.height-32);
 paint.fillStyle='#382155';paint.font='bold 100px sans-serif';paint.fillText(page.name.replace('第 ','PAGE ').replace(' 页',''),60,150);
 if(query.has('curl')){paint.font='bold 50px sans-serif';for(let y=400;y<page.height-60;y+=300)paint.fillText(`PAGE ${sampleNumber+1} / CHAPTER ${Number(chapter.id.split('-').at(-1))+1}`,60,y);}
 if(lazyChapters){paint.font='bold 40px sans-serif';paint.fillText(`CHAPTER ${Number(chapter.id.split('-').at(-1))+1}`,60,210);}
 if(page.blobKey)await sourcePageCache.put(page.blobKey,await sample.convertToBlob({type:'image/png'}));
 paint.fillStyle='#246d51';paint.font='bold 52px sans-serif';paint.fillText('TRANSLATED',60,250);
 await sourcePageCache.put(resultKey(page.id),await sample.convertToBlob({type:'image/png'}));
 sample.width=sample.height=1;
}
canvas.width=canvas.height=1;
const startingChapter=query.get('startChapter')==='2'&&chapterCount>1?1:query.get('startChapter')==='3'&&chapterCount>2?2:0;
const loadingMetrics=highResolution&&query.has('loading')?readerLoadingMetrics(originalBlob):undefined;
const initial=samples.map((chapter,index)=>lazyChapters&&index!==startingChapter?{...chapter,pages:[],discoveryComplete:false}:index===startingChapter&&query.get('incompleteCurrent')==='1'?{...chapter,discoveryComplete:false}:chapter);
if(priorityFixture){
 initial[0].pageId=initial[0].pages[7].id;
 const read=sourcePageCache.get.bind(sourcePageCache);
 sourcePageCache.get=async key=>{if(readOrder.length<64&&key.startsWith('inline-original:pagination-fixture-'))readOrder.push(key);return read(key);};
}
// Optional, origin-guarded byte-read gates for carousel/prefetch acceptance tests.
// They delay only synthetic fixture keys and never replace image decoding or DOM load events.
let releaseDelayedImages:(()=>void)|undefined;
if(pagination&&query.get('controlledReads')==='1'){
 const read=sourcePageCache.get.bind(sourcePageCache),gates=new Map<string,{wait:Promise<void>;release:()=>void}>(),failures=new Set<string>();
 const events:{key:string;phase:'start'|'ready'|'error';time:number}[]=[];
 const keyFor=(number:number,result=false,chapter=0)=>result?resultKey(`window-page-${chapter}-${number-1}`):originalKey(chapter,number-1);
 const hold=(number:number,result=false,chapter=0)=>{const key=keyFor(number,result,chapter);if(!gates.has(key)){let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});gates.set(key,{wait,release});}};
 const release=(number:number,result=false,chapter=0)=>{const key=keyFor(number,result,chapter),gate=gates.get(key);gates.delete(key);gate?.release();};
 const failNext=(number:number,result=false,chapter=0)=>failures.add(keyFor(number,result,chapter));
 for(const [name,result] of [['holdPages',false],['holdResults',true]] as const)for(const value of (query.get(name)??'').split(',')){
  const number=Number(value);if(Number.isInteger(number)&&number>=1&&number<=pageCount)hold(number,result);
 }
 for(const value of (query.get('failResults')??'').split(',')){const number=Number(value);if(Number.isInteger(number)&&number>=1&&number<=pageCount)failNext(number,true);}
 sourcePageCache.get=async key=>{
  if(!key.startsWith('inline-original:pagination-fixture-'))return read(key);
  events.push({key,phase:'start',time:performance.now()});await gates.get(key)?.wait;
  if(failures.delete(key)){events.push({key,phase:'error',time:performance.now()});throw Error('隔离样本：译图读取暂时失败。');}
  const blob=await read(key);events.push({key,phase:'ready',time:performance.now()});return blob;
 };
 Object.assign(window,{__readerFixtureReads:{events,hold,release,failNext,keyFor}});
 releaseDelayedImages=()=>{for(const gate of gates.values())gate.release();gates.clear();};
}
// Metadata discovery stays separate from image-byte reads, like a source adapter.
// Gates deliberately may resolve after cancellation; the fixture loader obeys the
// signal before publishing descriptors and records every lifecycle edge.
const manifestGates=new Map<string,{wait:Promise<void>;release:()=>void}>(),manifestFailures=new Set<string>();
const manifestEvents:{id:string;phase:'start'|'abort'|'ready'|'error'|'discarded';speculative:boolean;hasSignal:boolean;time:number}[]=[];
const manifestId=(chapter:number)=>`window-fixture-${chapter-1}`;
const holdManifest=(chapter:number)=>{const id=manifestId(chapter);if(!manifestGates.has(id)){let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});manifestGates.set(id,{wait,release});}};
const releaseManifest=(chapter:number)=>{const id=manifestId(chapter),gate=manifestGates.get(id);manifestGates.delete(id);gate?.release();};
const failManifest=(chapter:number)=>manifestFailures.add(manifestId(chapter));
if(lazyChapters){
 for(const value of (query.get('holdManifests')??'').split(',')){const chapter=Number(value);if(chapter>=1&&chapter<=chapterCount)holdManifest(chapter);}
 for(const value of (query.get('failManifests')??'').split(',')){const chapter=Number(value);if(chapter>=1&&chapter<=chapterCount)failManifest(chapter);}
 Object.assign(window,{__readerFixtureManifests:{events:manifestEvents,hold:holdManifest,release:releaseManifest,failNext:failManifest}});
}
function Fixture(){
 useUiLocale();
 const [shortcutsOpen,setShortcutsOpen]=useState(false);
 const [preferencesOpen,setPreferencesOpen]=useState(false),[comic,setComic]=useState<'A'|'B'>('A');
 useShortcuts({'app.shortcuts':()=>setShortcutsOpen(true)});
 const requestedLayout=query.get('initialLayout'),initialLayout=requestedLayout==='continuous'||requestedLayout==='double'?requestedLayout:pagination?'single':'continuous';
 const [copies,setCopies]=useState(initial),[id,setId]=useState(initial[startingChapter].id),[config,setConfig]=useState<Settings>({...defaults,layout:initialLayout,direction:initialLayout==='double'?'rtl':defaults.direction,fit:'window'}),[mounted,setMounted]=useState(true),[status,setStatus]=useState(''),[translationRevision,setTranslationRevision]=useState(0);
 const [saves,setSaves]=useState(0);
 const [turnCheck,setTurnCheck]=useState(''),[checkingTurns,setCheckingTurns]=useState(false);
 const [checkingGeometry,setCheckingGeometry]=useState(false);
 const [readingWindow,setReadingWindow]=useState('{}'),[markedRead,setMarkedRead]=useState<string[]>([]);
 const viewKey=loadingMetrics?'isolated-image-loading-fixture':priorityFixture?'isolated-priority-fixture':layoutSettings?`isolated-layout-comic-${comic}`:pagination?'isolated-pagination-fixture':'isolated-window-fixture';
 const copy=copies.find(value=>value.id===id)!;
 const update=useCallback((next:ReadingEntry)=>{if(scrubFixture||turnFixture)setSaves(value=>value+1);setCopies(previous=>previous.map(value=>value.id===next.id?next:value));},[]);
 const noop=useCallback(()=>{},[]),mark=useCallback(async(entryId:string)=>setMarkedRead(previous=>[...previous,entryId]),[]);
 const loadEntry=useCallback(async(entryId:string,options?:ChapterLoadOptions)=>{
  if(!lazyChapters)return;
  const event=(phase:typeof manifestEvents[number]['phase'])=>manifestEvents.push({id:entryId,phase,speculative:options?.speculative===true,hasSignal:!!options?.signal,time:performance.now()});
  const abort=()=>{event('abort');};
  event('start');options?.signal?.addEventListener('abort',abort,{once:true});
  try{
   await manifestGates.get(entryId)?.wait;
   if(options?.signal?.aborted){event('discarded');throw new DOMException('Fixture discovery canceled','AbortError');}
   if(manifestFailures.delete(entryId)){event('error');throw Error('隔离样本：下一话清单暂时不可用。');}
   const loaded=samples.find(chapter=>chapter.id===entryId);
   if(loaded)setCopies(previous=>previous.map(chapter=>chapter.id===entryId?{...chapter,pages:loaded.pages,discoveryComplete:true}:chapter));
   event('ready');
  }finally{options?.signal?.removeEventListener('abort',abort);}
 },[]);
 const observeWindow=useCallback((targets:ReadingTarget[],visiblePages:Page[],immediate?:boolean)=>{
  const snapshot=JSON.stringify({targets:targets.map(target=>target.page.id),visible:visiblePages.map(page=>page.id),immediate:!!immediate});
  setReadingWindow(previous=>previous===snapshot?previous:snapshot);
 },[]);
 const active=useCallback((value:string)=>setId(value),[]);
 const navigate=(value:string,pageId?:string)=>{if(pageId)setCopies(previous=>previous.map(item=>item.id===value?{...item,pageId,relativeOffset:0}:item));setId(value);};
 function completeTranslation(){
  setCopies(previous=>previous.map(chapter=>({...chapter,pages:chapter.pages.map(page=>page.blobKey?{...page,translationScope:'window-fixture',jobs:[{id:`result-${page.id}`,mode:'classic',target_language:config.language,status:'succeeded',phase:'done',quota_pages:0,created_at:'2026-01-01T00:00:00Z',version:1,cache_hit:true}],outputBlobs:{[`result-${page.id}`]:resultKey(page.id)}}:page)})));
 }
 async function checkTurns(){
  setCheckingTurns(true);const pages:string[]=[];let peak=0,created=0;
  const viewport=document.querySelector('.nc-reading-viewport'),observer=new MutationObserver(records=>{
   for(const record of records)for(const node of record.addedNodes)if(node instanceof Element)created+=Number(node.matches('[data-swipe-snapshot]'))+node.querySelectorAll('[data-swipe-snapshot]').length;
  });
  if(viewport)observer.observe(viewport,{childList:true});
  for(let step=0;step<6;step++){
   document.querySelector<HTMLButtonElement>('.nc-reader-navigation button:last-child')?.click();
   await new Promise(resolve=>setTimeout(resolve,80));
   pages.push(document.querySelector<HTMLElement>('.nc-reader-position')?.dataset.value??'?');
   peak=Math.max(peak,document.querySelectorAll('[data-swipe-snapshot]').length);
  }
  observer.disconnect();
  setTurnCheck(`6 次点击 / 80ms：${pages.join(' → ')}；共创建 ${created} 个旧页快照，最多同时 ${peak} 个；减少动态效果：${matchMedia('(prefers-reduced-motion: reduce)').matches?'开启':'关闭'}`);setCheckingTurns(false);
 }
 async function checkBookmarkCost(cold=false){
  if(cold)for(const chapter of samples)await thumbnailCache.deleteOwner(chapter.id);
  const before=bookmarkImageReads,viewport=document.querySelector<HTMLElement>('[data-decoded-pages]'),decodedBefore=viewport?.dataset.decodedPages;
  const trigger=[...document.querySelectorAll<HTMLButtonElement>('[data-reader-bookmarks-trigger]')].find(button=>button.getClientRects().length);
  if(!trigger)return;
  const start=performance.now();trigger.click();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
  const elapsed=performance.now()-start;
  while(performance.now()-start<2500){
   const visible=[...document.querySelectorAll('.nc-bookmarks [data-thumbnail-visible]')];
   if(visible.length&&visible.every(item=>item.querySelector<HTMLImageElement>('img')?.complete))break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  const decodedAfter=viewport?.dataset.decodedPages,thumbnails=document.querySelectorAll('.nc-bookmarks img').length,ready=performance.now()-start;
  const panel=document.querySelector<HTMLElement>('.nc-bookmarks'),overflow=!!panel&&panel.scrollWidth>panel.clientWidth;
  document.querySelector<HTMLButtonElement>('[data-bookmarks=true] .nc-drawer-title button')?.click();
  setStatus(`书签面板：正文解码 ${decodedBefore} → ${decodedAfter} 页；新增原图读取 ${bookmarkImageReads-before}；缩略图 ${thumbnails}；文字 ${elapsed.toFixed(1)}ms / 图片 ${ready.toFixed(1)}ms；横向溢出 ${overflow}`);
 }
 async function checkGeometry(){
  flushSync(()=>setCheckingGeometry(true));
  dimensionReads=0;let elapsed=0;
  for(let n=0;n<50;n++){
   const start=performance.now();
   flushSync(()=>setCopies(previous=>previous.map(chapter=>chapter.id===id?{...chapter,updatedAt:chapter.updatedAt+1}:chapter)));
   elapsed+=performance.now()-start;
   await new Promise(requestAnimationFrame);
  }
  setStatus(`50 次进度更新：尺寸读取 ${dimensionReads} 次；同步更新 ${elapsed.toFixed(1)}ms`);setCheckingGeometry(false);
 }
 return <div className="nc-app" style={{height:'100vh',display:'flex',flexDirection:'column'}}
  onPointerDownCapture={event=>{if(scrubFixture&&(event.target as Element).matches('.nc-reader-progress'))scrubPointer={y:event.clientY,moves:[]};}}
  onPointerMoveCapture={event=>{if(scrubPointer){scrubPointer.moves.push(`${Math.round(event.clientY)}[${event.buttons}]`);if(scrubPointer.moves.length>6)scrubPointer.moves.shift();}}}
  onPointerCancelCapture={()=>{scrubPointer=undefined;}}
  onPointerUpCapture={event=>{if(scrubPointer){setStatus(`原生拖动：${scrubPointer.y.toFixed(0)} → ${event.clientY.toFixed(0)}；最近移动 ${scrubPointer.moves.join(' → ')}；控件值 ${document.querySelector<HTMLInputElement>('.nc-reader-progress')?.value}`);scrubPointer=undefined;}}}><Scrollbars/>
  <div style={{padding:pagination?4:8,display:'flex',gap:pagination?4:12,alignItems:'center',background:'var(--surface)',zIndex:20,flexWrap:pagination||thumbnailFixture||scrubFixture?'wrap':undefined}}><strong>隔离阅读器验收</strong>{!pagination&&<span>{copy.title}</span>}<button onClick={()=>setMounted(value=>!value)}>{mounted?'关闭并保存位置':'重开阅读器'}</button>{!pagination&&<><button onClick={()=>{setCopies(previous=>previous.map(value=>value.id===id?{...value,pages:value.pages.map(page=>({...page,height:highResolution?8000:1600}))}:value));}}>更新真实尺寸</button><button onClick={()=>navigate(`window-fixture-${Math.min(chapterCount-1,Number(id.split('-').at(-1))+1)}`)}>切下一章</button></>}<output aria-label="保存位置" hidden={pagination&&!query.has('bookmarks')}>{copy.pageId} · {copy.relativeOffset.toFixed(3)}</output>{!thumbnailFixture&&!performanceFixture&&!loadingMetrics&&<span role="status" style={scrubFixture?{flexBasis:"100%",height:60,overflow:"auto",fontSize:12}:undefined}>{status}</span>}</div>
  {query.has('bookmarks')&&<div><button onClick={()=>navigate(samples[(Number(id.split('-').at(-1))+1)%samples.length].id)}>切换测试章节</button><button onClick={()=>setCopies(previous=>previous.map(chapter=>chapter.id===id?{...chapter,contentId:chapter.contentId+':changed'}:chapter))}>模拟内容更新</button><button onClick={()=>void checkBookmarkCost()}>检查书签开销</button><button onClick={()=>void checkBookmarkCost(true)}>检查首次缩略图</button></div>}
  {FlipMetrics&&<FlipMetrics/>}
  {releaseDelayedImages&&<button onClick={releaseDelayedImages}>继续模拟图片加载</button>}
  {(scrubFixture||turnFixture)&&<div><output aria-label="进度条验证">保存 {saves} 次 · {copy.pageId}</output>{scrubFixture&&<button onClick={()=>previewProgress(setStatus)}>模拟长按预览</button>}{turnFixture&&<><button disabled={checkingTurns} onClick={()=>void checkTurns()}>快速翻页验证</button><output aria-label="连续翻页验证">{turnCheck}</output></>}</div>}
  {priorityFixture&&<button onClick={()=>setStatus(`读取顺序：${readOrder.slice(0,16).map(key=>Number(key.split('-').at(-1))+1).join(' → ')}；解码窗口 ${document.querySelector<HTMLElement>('[data-decoded-pages]')?.dataset.decodedPages}`)}>检查读取顺序</button>}
  {performanceFixture&&<div><button disabled={checkingGeometry} onClick={()=>void checkGeometry()}>测量 50 次进度更新</button><output role="status" style={{display:'block',height:36,fontSize:12,lineHeight:'18px'}}>{status}</output></div>}
  {thumbnailFixture&&<div><button onClick={()=>{const list=document.querySelector<HTMLElement>('.nc-thumb-list');if(!list){setStatus('请先打开页面目录');return;}const bounds=list.getBoundingClientRect(),rows=[...list.querySelectorAll('.nc-thumb-row')],full=rows.filter(row=>{const rect=row.getBoundingClientRect();return rect.top>=bounds.top&&rect.bottom<=bounds.bottom;}).length;setStatus(`缩略图：挂载 ${rows.length} 行，完整可见 ${full} 行；正文解码 ${document.querySelector<HTMLElement>('[data-decoded-pages]')?.dataset.decodedPages} 页`);}}>检查缩略图窗口</button><output role="status" style={{display:'block',height:36,fontSize:12,lineHeight:'18px'}}>{status}</output></div>}
  <div><button onClick={()=>flushSync(()=>setTranslationRevision(value=>value+1))}>更新模拟翻译状态 {translationRevision}</button><button onClick={completeTranslation}>完成模拟翻译</button></div>
  {loadingMetrics&&<div><button onClick={()=>setStatus(loadingMetrics.snapshot())}>读取大图加载指标</button><button onClick={()=>{setMounted(false);void loadingMetrics.prepare().then(setStatus);}}>测量来源准备</button><output role="status" style={{display:"block",height:80,fontSize:12,lineHeight:"16px",overflow:"auto",overflowWrap:"anywhere"}}>{status}</output></div>}
  {lazyChapters&&<div><span>{copy.title}</span>{query.has('holdManifests')&&<button onClick={()=>{for(const gate of manifestGates.values())gate.release();manifestGates.clear();}}>继续模拟章节加载</button>}</div>}
  {layoutSettings&&<div style={{display:'flex',flexWrap:'wrap',gap:4}}>
   <button onClick={()=>setPreferencesOpen(value=>!value)}>{preferencesOpen?'返回阅读器':'全局阅读偏好'}</button>
   {(['A','B'] as const).map(value=><button key={value} aria-pressed={comic===value} onClick={()=>{setComic(value);setPreferencesOpen(false);setMounted(true);}}>漫画 {value}</button>)}
   {chapterCount>1&&<button disabled={id===copies.at(-1)?.id} onClick={()=>navigate(`window-fixture-${Math.min(chapterCount-1,Number(id.split('-').at(-1))+1)}`)}>切下一章</button>}
   <output hidden data-testid="global-reading-settings">{JSON.stringify({layout:config.layout,direction:config.direction,comic,viewKey})}</output>
  </div>}
  <output hidden data-testid="reading-window">{readingWindow}</output><output hidden data-testid="marked-read">{JSON.stringify(markedRead)}</output>
  {lazyChapters&&<output hidden data-testid="chapter-state">{JSON.stringify({active:id,chapters:copies.map(chapter=>({id:chapter.id,pages:chapter.pages.length,complete:chapter.discoveryComplete,pageId:chapter.pageId}))})}</output>}
  {layoutSettings&&preferencesOpen?<div style={{overflow:'auto',minHeight:0}}><Preferences settings={config} setSettings={setConfig}/></div>:mounted&&<Reader onBookmarkNavigate={async target=>{const chapter=copies.find(item=>item.id===target.entryId),next=chapter&&applyBookmark(chapter,target);if(!next)return false;setCopies(previous=>previous.map(item=>item.id===next.id?next:item));setId(next.id);return true;}} key={viewKey} viewKey={viewKey} translationScope="window-fixture" copy={copy} sequence={copies} settings={config} setSettings={setConfig} update={update} onActiveEntry={active} onLoadEntry={loadEntry} onMarkRead={mark} onNavigate={navigate} onBack={()=>setMounted(false)} onOpenShortcuts={()=>setShortcutsOpen(true)} analyticsBlocked={shortcutsOpen} onRetry={noop} onUpgrade={noop} onLogin={noop} translationState={(_,page)=>page.jobs.length?undefined:translationRevision%2?{kind:'translating',message:'隔离样本：正在翻译'}:{kind:'error',message:'隔离样本：翻译失败，可重试'}} onImport={()=>setStatus('本地样本导入入口')} onFind={layoutSettings?()=>setStatus('已触发寻找其他语言'):undefined} onReload={layoutSettings?()=>setStatus('已触发重新载入'):undefined} notify={setStatus} onReadingWindow={observeWindow} busy={false}/>}
  {shortcutsOpen&&<ShortcutPanel initialScope="reader" onClose={()=>setShortcutsOpen(false)}/>}
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
