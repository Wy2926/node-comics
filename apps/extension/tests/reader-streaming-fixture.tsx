/** Real fetch/stream/normalization/reader, with synthetic catalog and extension authorization only. */
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Reader} from '../src/reader/Reader';
import {defaults,type ReadingEntry,type Settings} from '../src/types';
import {catalog} from '../src/comics/repositories';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {pageReference,RENDER_PROFILE} from '../src/comics/pages/identity';
import {PagePreview} from '../src/comics/pages/preview';
import {readingViewDefaults,saveReadingView} from '../src/reader/view';
import {sourcePageCache} from '../src/storage/source-pages';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if(location.hostname!=='127.0.0.1'||location.port!=='5181')throw Error('Use the isolated 127.0.0.1:5181 fixture origin.');
const query=new URLSearchParams(location.search),streaming=query.get('preview')!=='0';
const formats=['progressive.jpg','baseline.jpg','plain.png','plain.webp'];
const format=formats.includes(query.get('format')!)?query.get('format')!:'progressive.jpg';
const count=query.get('pages')==='1'?1:4,kib=Number(query.get('kib')??128);
const records=new Map<string,unknown>(),urls=new Map<string,string>();
// Fixture authority accepts exactly the local images registered below. No real source permissions or APIs.
Object.assign(window.chrome??(window.chrome={} as typeof chrome),{
 runtime:{id:'reader-stream-fixture',getURL:()=> 'chrome-extension://reader-stream-fixture/',sendMessage:async(message:{type:string;pageId?:string})=>{
  if(message.type==='NC_SOURCE_IMAGE'&&urls.has(message.pageId!))return {ok:true,data:{url:urls.get(message.pageId!),pageUrl:'http://127.0.0.1:5211/book',sourceId:'reader-stream-fixture'}};
  throw Error('Fixture message is not allowed');
 }},
 extension:{inIncognitoContext:true},permissions:{contains:async({origins}:{origins:string[]})=>origins.every(origin=>origin==='http://127.0.0.1/*')},
 declarativeNetRequest:{getSessionRules:async()=>[],updateSessionRules:async()=>{}},
});
catalog.get=async(table,id)=>records.get(JSON.stringify([table,id])) as never;
catalog.putMaterialization=async identity=>{records.set(JSON.stringify(['materializations',identity.id]),identity);return true;};
registerSourceDriver({id:'reader-stream-fixture',label:'Synthetic loopback',cachePages:false,cacheRanges:false});
if(!streaming)PagePreview.prototype.add=()=>()=>{};
const viewKey='reader-streaming-fixture';
saveReadingView(viewKey,{...readingViewDefaults(),layout:query.get('layout')==='single'?'single':'continuous',fit:'width',zoom:100});
type Timing={requests:number;bytes:number;downloadMs?:number;previewMs?:number;shownMs?:number;paints:number};
let run='',started=0,timings:Record<string,Timing>={},decoderCount=0,decoders=0,peakDecoders=0,paintMs=0,longTasks:number[]=[];
const elapsed=()=>Math.round(performance.now()-started);
const timing=(page:string)=>timings[page]??={requests:0,bytes:0,paints:0};
const fetchOriginal=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=new URL(input instanceof Request?input.url:String(input),location.href);
 const response=await fetchOriginal(input,init);
 if(url.origin!=='http://127.0.0.1:5211'||!formats.includes(url.pathname.slice(1))||!response.body)return response;
 const currentRun=run,item=timing(url.searchParams.get('page')!);item.requests++;
 const body=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
  transform(chunk,controller){if(run===currentRun)item.bytes+=chunk.length;controller.enqueue(chunk);},
  flush(){if(run===currentRun)item.downloadMs=elapsed();},
 }));
 return new Response(body,{status:response.status,headers:response.headers});
};
if(typeof ImageDecoder!=='undefined')window.ImageDecoder=new Proxy(ImageDecoder,{construct(Target,args){
 const decoder=Reflect.construct(Target,args) as ImageDecoder;decoderCount++;decoders++;peakDecoders=Math.max(peakDecoders,decoders);
 const close=decoder.close.bind(decoder);let closed=false;decoder.close=()=>{if(!closed){closed=true;decoders--;}close();};return decoder;
}});
const draw=CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage=function(...args:unknown[]){
 const start=performance.now();Reflect.apply(draw,this,args);
 if(this.canvas.classList.contains('nc-page-preview')){const page=this.canvas.closest<HTMLElement>('[data-page-id]')?.dataset.pageId;
  if(page){const item=timing(page);item.previewMs??=elapsed();item.paints++;paintMs+=performance.now()-start;}}
};
new MutationObserver(()=>{if(!started)return;for(const img of document.querySelectorAll('.nc-page-image')){const page=img.closest<HTMLElement>('[data-page-id]')?.dataset.pageId;if(page)timing(page).shownMs??=elapsed();}}).observe(document.getElementById('root')!,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{if(started)longTasks.push(...list.getEntries().map(entry=>Math.round(entry.duration)));}).observe({entryTypes:['longtask']});
const noop=()=>{};
const resultCanvas=new OffscreenCanvas(800,1200),resultPaint=resultCanvas.getContext('2d')!;
resultPaint.fillStyle='#e0f0df';resultPaint.fillRect(0,0,800,1200);resultPaint.fillStyle='#204e36';resultPaint.font='bold 60px sans-serif';resultPaint.fillText('TRANSLATED',80,240);
const resultKey='inline-original:reader-stream-fixture-result';await sourcePageCache.put(resultKey,await resultCanvas.convertToBlob({type:'image/png'}));resultCanvas.width=resultCanvas.height=1;
function Fixture(){
 const [copy,setCopy]=useState<ReadingEntry>(),[mounted,setMounted]=useState(false),[settings,setSettings]=useState<Settings>({...defaults,layout:'continuous'}),[report,setReport]=useState<string[]>([]),[status,setStatus]=useState(''),[marked,setMarked]=useState(0),[checking,setChecking]=useState(false);
 async function begin(){
  flushSync(()=>setMounted(false));records.clear();urls.clear();run=crypto.randomUUID();timings={};decoderCount=decoders=peakDecoders=paintMs=0;longTasks=[];setMarked(0);setReport([]);setStatus('');
  const put=(table:string,id:unknown,value:unknown)=>records.set(JSON.stringify([table,id]),value);
  put('entries',run,{id:run,comicId:run,contentId:run,generation:1,format:'website'});
  put('comics',run,{id:run,source:{generation:1,connectionId:run,status:'active'}});
  put('connections',run,{id:run,generation:1,provider:'reader-stream-fixture',status:'connected'});
  const pages=Array.from({length:count},(_,index)=>{
   const pageId=String(index+1),name=count===1?format:formats[index];
   const url=`http://127.0.0.1:5211/${name}?run=${run}&page=${pageId}&kib=${kib}${query.has('fault')&&index===0?'&fault=1':''}`;
   urls.set(pageId,url);put('pageDescriptors',[run,pageId],{name:pageId,pageId,contentId:run,ordinal:index,locator:{url,manifestId:run,sourceId:pageId}});
   return {id:pageId,name:`第 ${pageId} 页`,width:2400,height:3600,jobs:[],outputBlobs:{},blobKey:pageReference({entryId:run,contentId:run,pageId,renderProfileId:RENDER_PROFILE})};
  });
  started=performance.now();setCopy({id:run,contentId:run,title:'慢网流式阅读验收',source:'website',sourceKey:run,generation:1,createdAt:0,updatedAt:0,pages,pageId:'1',relativeOffset:0,discoveryComplete:true});setMounted(true);
 }
 async function metrics(){
  const server=await fetchOriginal(`http://127.0.0.1:5211/metrics?run=${run}`).then(response=>response.json());
  setReport([`渐进预览 ${streaming?'开启':'关闭'}；解码器创建 ${decoderCount}，峰值 ${peakDecoders}，活动 ${decoders}；预览绘制累计 ${paintMs.toFixed(1)}ms；长任务 ${longTasks.join(',')||'无'}ms`,...Object.entries(timings).map(([page,value])=>`页 ${page}：${JSON.stringify(value)}`),...server.map((value:unknown)=>`服务端：${JSON.stringify(value)}`)]);
 }
 async function series(){
  setChecking(true);const results:string[]=[];
  try{for(let n=0;n<3;n++){
   await begin();
   await new Promise<void>((resolve,reject)=>{const poll=setInterval(()=>{if(timings['1']?.shownMs){clearInterval(poll);resolve();}else if(elapsed()>30000){clearInterval(poll);reject(Error('Fixture timed out'));}},50);});
   results.push(`第 ${n+1} 轮：${JSON.stringify({...timings['1'],decoderCount,peakDecoders,activeDecoders:decoders,paintMs:Number(paintMs.toFixed(1)),longTasks})}`);
  }setReport(results);}catch(error){setStatus(String(error));}finally{setChecking(false);}
 }
 function checkTurn(){
  document.querySelector<HTMLButtonElement>('.nc-reader-navigation button:last-child')?.click();
  requestAnimationFrame(()=>{
   const canvases=[...document.querySelectorAll<HTMLCanvasElement>('[data-swipe-snapshot] .nc-page-preview')].filter(canvas=>canvas.style.display!=='none');
   setStatus(`翻页预览快照 ${canvases.length}；像素 Alpha ${canvases.map(canvas=>canvas.getContext('2d')?.getImageData(20,20,1,1).data[3]).join(',')||'无'}；当前位置 ${document.querySelector<HTMLInputElement>('.nc-reader-navigation input[type=number]')?.value}`);
  });
 }
 function translated(){setCopy(previous=>previous&&({...previous,pages:previous.pages.map(page=>({...page,translationScope:'stream-fixture',jobs:[{id:`result-${page.id}`,mode:'classic',target_language:settings.language,status:'succeeded',phase:'done',quota_pages:0,created_at:'2026-01-01T00:00:00Z',version:1,cache_hit:true}],outputBlobs:{[`result-${page.id}`]:resultKey}}))}));}
 return <div className="nc-app" style={{height:'100vh',display:'flex',flexDirection:'column'}}>
  <div style={{padding:6,display:'flex',gap:6,flexWrap:'wrap',background:'white',zIndex:20}}><strong>{streaming?'流式':'完整下载'} · {kib||'不限速'} KiB/s</strong><button onClick={()=>void begin()} disabled={checking}>开始慢网加载</button>{count===1&&<button onClick={()=>void series()} disabled={checking}>{checking?'三轮测量中':'运行三轮对照'}</button>}<button onClick={()=>setMounted(value=>!value)} disabled={!copy||checking}>{mounted?'关闭并保存位置':'重开阅读器'}</button><button onClick={()=>void metrics()} disabled={!copy||checking}>读取指标</button><button onClick={translated} disabled={!copy||checking}>提供模拟译图</button>{count>1&&<button onClick={checkTurn} disabled={!copy}>检查慢加载翻页</button>}<output>已读 {marked} · 位置 {copy?.pageId??'-'} / {copy?.relativeOffset.toFixed(3)??'0'}</output></div>
  <div style={{flexShrink:0,maxHeight:180,overflow:'auto',fontSize:12}}>{report.map((line,index)=><p key={index} style={{margin:3}}>{line}</p>)}{status}</div>
  {mounted&&copy&&<Reader key={copy.id} viewKey={viewKey} translationScope="stream-fixture" copy={copy} sequence={[copy]} settings={settings} setSettings={setSettings} update={setCopy} onActiveEntry={noop} onLoadEntry={noop} onMarkRead={async()=>{setMarked(value=>value+1);}} onNavigate={noop} onBack={()=>setMounted(false)} onOpenShortcuts={noop} onRetry={noop} onUpgrade={noop} onLogin={noop} translationState={()=>undefined} onImport={noop} notify={setStatus} onReadingWindow={noop} busy={false}/>}
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
