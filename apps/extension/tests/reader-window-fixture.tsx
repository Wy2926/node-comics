import {Scrollbars} from '../src/ui/Scrollbars';
/** Development-only, synthetic data on a dedicated origin. Never calls a supplier or cloud API. */
import {useCallback,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Reader} from '../src/reader/Reader';
import {Api} from '../src/api';
import {defaults,type ReadingEntry,type Settings} from '../src/types';
import {sourcePageCache} from '../src/storage/source-pages';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if(location.hostname!=='127.0.0.1'||location.port!=='5181')throw Error('Use the isolated 127.0.0.1:5181 fixture origin.');
const api=new Api(location.origin+'/fixture-disabled');
const highResolution=new URLSearchParams(location.search).get('highres')==='1';
const width=highResolution?4000:800,height=highResolution?6000:1200,chapterCount=highResolution?1:30,pageCount=highResolution?24:120;
const originalKey=(chapter:number,index:number)=>highResolution?`inline-original:window-fixture-high-${chapter}-${index}`:'inline-original:window-fixture';
const resultKey=(pageId:string)=>highResolution?`inline-original:window-fixture-high-result-${pageId}`:'inline-original:window-fixture-result';
const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d')!;
context.scale(width/800,height/1200);
context.fillStyle='#f1e8ff';context.fillRect(0,0,800,1200);context.fillStyle='#ab87d8';context.fillRect(40,40,720,800);
context.fillStyle='#fff';context.font='bold 54px sans-serif';context.fillText('WINDOW FIXTURE',115,210);context.font='36px sans-serif';context.fillText('Synthetic local image',120,310);
const originalBlob=await canvas.convertToBlob({type:'image/png'});
context.fillStyle='#fff';context.fillText('TRANSLATED RESULT',115,420);
const translatedBlob=await canvas.convertToBlob({type:'image/png'});
if(!highResolution){await sourcePageCache.put(originalKey(0,0),originalBlob);await sourcePageCache.put(resultKey(''),translatedBlob);}
const initial:ReadingEntry[]=Array.from({length:chapterCount},(_,chapter)=>({id:`window-fixture-${chapter}`,title:`第 ${chapter+1} 章 · 窗口验收`,source:'fixture',sourceKey:`window-fixture-${chapter}`,generation:1,retention:'offline',createdAt:0,updatedAt:0,discoveryComplete:true,pageId:`window-page-${chapter}-0`,relativeOffset:0,pages:Array.from({length:pageCount},(_,index)=>({id:`window-page-${chapter}-${index}`,name:`第 ${index+1} 页`,width,height,blobKey:index===7?undefined:originalKey(chapter,index),fetchError:index===7?'隔离样本：本页读取失败，可重试。':undefined,jobs:[],outputBlobs:{}}))}));
// Reuse two encoded PNGs; independent keys expose per-page reads and resource retention.
if(highResolution)for(const chapter of initial)for(const page of chapter.pages){if(page.blobKey)await sourcePageCache.put(page.blobKey,originalBlob);await sourcePageCache.put(resultKey(page.id),translatedBlob);}
canvas.width=canvas.height=1;
function Fixture(){
 const [copies,setCopies]=useState(initial),[id,setId]=useState(initial[0].id),[config,setConfig]=useState<Settings>({...defaults,layout:'continuous',fit:'window'}),[mounted,setMounted]=useState(true),[status,setStatus]=useState(''),[translationRevision,setTranslationRevision]=useState(0);
 const copy=copies.find(value=>value.id===id)!;
 const update=useCallback((next:ReadingEntry)=>setCopies(previous=>previous.map(value=>value.id===next.id?next:value)),[]);
 const noop=useCallback(()=>{},[]),mark=useCallback(async()=>{},[]);
 const active=useCallback((value:string)=>setId(value),[]);
 const navigate=(value:string,pageId?:string)=>{if(pageId)setCopies(previous=>previous.map(item=>item.id===value?{...item,pageId,relativeOffset:0}:item));setId(value);};
 function completeTranslation(){
  setCopies(previous=>previous.map(chapter=>({...chapter,pages:chapter.pages.map(page=>page.blobKey?{...page,translationScope:'window-fixture',jobs:[{id:`result-${page.id}`,mode:'classic',target_language:config.language,status:'succeeded',phase:'done',quota_pages:0,created_at:'2026-01-01T00:00:00Z',version:1,cache_hit:true}],outputBlobs:{[`result-${page.id}`]:resultKey(page.id)}}:page)})));
 }
 return <div className="nc-app" style={{height:'100vh',display:'flex',flexDirection:'column'}}><Scrollbars/>
  <div style={{padding:8,display:'flex',gap:12,alignItems:'center',background:'#fff',zIndex:20}}><strong>隔离阅读器验收</strong><span>{copy.title}</span><button onClick={()=>setMounted(value=>!value)}>{mounted?'关闭并保存位置':'重开阅读器'}</button><button onClick={()=>{setCopies(previous=>previous.map(value=>value.id===id?{...value,pages:value.pages.map(page=>({...page,height:highResolution?8000:1600}))}:value));}}>更新真实尺寸</button><button onClick={()=>navigate(`window-fixture-${Math.min(chapterCount-1,Number(id.split('-').at(-1))+1)}`)}>切下一章</button><output aria-label="保存位置">{copy.pageId} · {copy.relativeOffset.toFixed(3)}</output><span role="status">{status}</span></div>
  <div><button onClick={()=>flushSync(()=>setTranslationRevision(value=>value+1))}>更新模拟翻译状态 {translationRevision}</button><button onClick={completeTranslation}>完成模拟翻译</button></div>
  {mounted&&<Reader key={mounted?'reader':'closed'} viewKey="isolated-window-fixture" translationScope="window-fixture" copy={copy} sequence={copies} settings={config} setSettings={setConfig} update={update} onActiveEntry={active} onLoadEntry={noop} onMarkRead={mark} onNavigate={navigate} onBack={()=>setMounted(false)} onRetry={noop} onUpgrade={noop} onLogin={noop} translationState={(_,page)=>page.jobs.length?undefined:translationRevision%2?{kind:'translating',message:'隔离样本：正在翻译'}:{kind:'error',message:'隔离样本：翻译失败，可重试'}} onImport={()=>setStatus('本地样本导入入口')} notify={setStatus} onReadingWindow={noop} api={api} busy={false}/>}
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
