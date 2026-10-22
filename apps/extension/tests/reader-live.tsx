/** Test-only transport/result projection. Real Reader, controls, image decoding and chapter window.
 * Not MV3 permission/lease acquisition or remote translation acceptance. No pagehide save shim.
 */
import {useCallback,useRef,useState,type SetStateAction} from 'react';
import {createRoot} from 'react-dom/client';
import {Reader} from '../src/reader/Reader';
import type {Capabilities,Page,ReadingEntry,Settings} from '../src/types';
import type {ChapterLoadOptions} from '../src/reader/chapter-resources';
import type {ReadingDirectory} from '../src/comics/application/library-service';
import {settings as readSettings,saveSettings} from '../src/comics/application/preferences';
import {sourcePageCache} from '../src/storage/source-pages';
import {useAppearance} from '../src/ui/Appearance';
import {ShortcutPanel} from '../src/ui/shortcuts/ShortcutPanel';
import {Scrollbars} from '../src/ui/Scrollbars';
import type {LiveCatalog,LiveManifest,LivePair} from './reader-live-server';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';
import '../src/ui/phone.css';

if (location.origin!=='http://127.0.0.1:5199') throw Error('Use the isolated http://127.0.0.1:5199 origin.');
const query = new URLSearchParams(location.search), translations = query.get('sample')==='translations';
const scope = 'reader-live-saved-results', viewKey = 'reader-live:'+ (translations?`pair:${query.get('pair')==='color'?'color':'mono'}`:'asura');
const positionKey = viewKey+':positions';
type Positions = {active?:string;entries:Partial<Record<string,Pick<ReadingEntry,'pageId'|'relativeOffset'|'lastReadAt'|'updatedAt'>>>};
const positions:Positions = (()=>{try{const saved=JSON.parse(localStorage.getItem(positionKey)??'null');if(saved?.entries&&typeof saved.entries==='object')return saved;}catch{/* Fresh isolated state. */}return {entries:{}};})();
const routes = new Map<string,string>(), pendingBytes = new Map<string,Promise<Blob>>();
const cached = sourcePageCache.get.bind(sourcePageCache);
// Reader's bounded image acquisition still owns demand; only these test keys have HTTP fallback.
sourcePageCache.get = async key=>{
  const blob = await cached(key), route = routes.get(key);
  if (blob || !route) return blob;
  let pending = pendingBytes.get(key);
  if (!pending) {
    pending = (async()=>{
      const response = await fetch(route,{credentials:'omit',signal:AbortSignal.timeout(30_000)});
      if (!response.ok) throw Error('真实图片读取失败，请重试。');
      const value = await response.blob();
      await sourcePageCache.put(key,value);
      return value;
    })().finally(()=>pendingBytes.delete(key));
    pendingBytes.set(key,pending);
  }
  return pending;
};
async function json<T>(route:string,signal?:AbortSignal):Promise<T> {
  const response = await fetch('/__reader_live/'+route,{credentials:'omit',signal});
  if (!response.ok) throw Error((await response.json()).error??'验收数据读取失败。');
  return response.json();
}
const empty = (id:string,title:string):ReadingEntry=>({id,title,source:'website',sourceKey:id,generation:1,
  createdAt:0,updatedAt:0,pages:[],pageId:'',relativeOffset:0,discoveryComplete:false,...positions.entries?.[id]});
const toPages = (manifest:LiveManifest):Page[]=>manifest.pages.map(page=>{
  routes.set(page.key,page.url);
  return {id:page.id,name:page.name,width:page.width,height:page.height,blobKey:page.key,jobs:[],outputBlobs:{}};
});
const noAction = ()=>{}, noTranslation = ()=>undefined;

async function start() {
  let catalog:LiveCatalog|undefined, pair:LivePair|undefined, initial:ReadingEntry[];
  if (translations) {
    pair = (await json<LivePair[]>('pairs')).find(pair=>pair.id===(query.get('pair')==='color'?'color':'mono'))!;
    const key = `inline-original:reader-live:pair:${pair.id}`, resultKey = key+':translated', jobId = `saved-${pair.id}`;
    routes.set(key,pair.original);routes.set(resultKey,pair.translated);
    const page:Page = {id:pair.id,name:pair.title,width:pair.width,height:pair.height,blobKey:key,translationScope:scope,
      jobs:[{id:jobId,mode:'classic',target_language:pair.language,status:'succeeded',phase:'done',quota_pages:0,
        created_at:'2026-01-01T00:00:00Z',version:1,cache_hit:true}],outputBlobs:{[jobId]:resultKey}};
    initial = [{...empty(pair.id,pair.title),pages:[page],discoveryComplete:true}];
  } else {
    catalog = await json<LiveCatalog>('catalog');
    initial = catalog.entries.map(entry=>empty(entry.id,entry.title));
  }
  const selected = initial.find(entry=>entry.id===positions.active)??initial[0];
  if (catalog) {
    const chapter = catalog.entries.find(entry=>entry.id===selected.id)!.chapter;
    const manifest = await json<LiveManifest>('pages/'+chapter);
    Object.assign(selected,{title:manifest.title,pages:toPages(manifest),discoveryComplete:true});
  }
  const caps:Capabilities = {modes:pair?[{id:'classic',label:'已有实测译图',enabled:true,languages:[pair.language]}]:[],
    languages:pair?[{id:pair.language,label:pair.language==='en'?'English':'简体中文'}]:[],
    limits:{max_bytes:32*1024**2,max_pixels:100_000_000,max_dimension:100_000,max_translation_ids:1},entitlements:null};
  function LiveReader() {
    const [copies,setCopies] = useState(initial), [id,setId] = useState(selected.id), [open,setOpen] = useState(true);
    const [status,setStatus] = useState(''), [shortcuts,setShortcuts] = useState(false);
    const [config,setConfig] = useState<Settings>(()=>({...readSettings(),...(pair?{language:pair.language}:{})}));
    const configRef = useRef(config);configRef.current=config;
    useAppearance(config);
    const changeSettings = useCallback((value:SetStateAction<Settings>)=>{
      const next = typeof value==='function'?value(configRef.current):value;
      configRef.current=next;setConfig(next);
      void saveSettings(next).catch(()=>setStatus('偏好保存失败。'));
    },[]);
    const update = useCallback((next:ReadingEntry)=>{
      // Deliberately only real Reader.update saves anchors: immediate reload exposes its own timing.
      positions.active=next.id;
      positions.entries[next.id]={pageId:next.pageId,relativeOffset:next.relativeOffset,lastReadAt:next.lastReadAt,updatedAt:next.updatedAt};
      try {localStorage.setItem(positionKey,JSON.stringify(positions));} catch {setStatus('阅读位置保存失败。');}
      setCopies(previous=>previous.map(entry=>entry.id===next.id?next:entry));
    },[]);
    const load = useCallback(async(entryId:string,options?:ChapterLoadOptions)=>{
      const chapter = catalog?.entries.find(entry=>entry.id===entryId)?.chapter;
      if (!chapter) {if (pair?.id===entryId) return;throw Error('不在所选三章中。');}
      try {
        const manifest = await json<LiveManifest>('pages/'+chapter,options?.signal);
        options?.signal?.throwIfAborted();
        const pages = toPages(manifest);
        setCopies(previous=>previous.map(entry=>entry.id===entryId?{...entry,title:manifest.title,pages,discoveryComplete:true}:entry));
      } catch(error) {if (!options?.signal?.aborted) setStatus((error as Error).message);throw error;}
    },[]);
    const navigate = (entryId:string,pageId?:string)=>{
      if (!initial.some(entry=>entry.id===entryId)) return;
      if (pageId) setCopies(previous=>previous.map(entry=>entry.id===entryId?{...entry,pageId,relativeOffset:0}:entry));
      setId(entryId);
    };
    const copy = copies.find(entry=>entry.id===id)!;
    const directory:ReadingDirectory = {title:catalog?catalog.title+' · 仅前三章':pair!.title,sourceUrl:catalog?.url,groups:[],
      entries:copies.map(entry=>({id:entry.id,title:entry.title,tags:[],current:entry.id===id,read:false,readable:true,total:entry.pages.length||undefined,status:''})),
      chapters:copies.map(entry=>({id:entry.id,title:entry.title,entryIds:[entry.id],selectedEntryId:entry.id,groupIds:[],current:entry.id===id,readable:true}))};
    return <div className="nc-app reader-live">
      <style>{'.reader-live{height:100dvh;display:flex;flex-direction:column}.reader-live>.nc-reader{height:auto;min-height:0;flex:1}.reader-live-notice{flex:none;padding:6px 12px;font-size:12px;display:flex;gap:12px;flex-wrap:wrap;align-items:center}.reader-live-lobby{padding:24px;overflow:auto}'}</style>
      <Scrollbars/>
      <div className="reader-live-notice"><strong>{pair?'已有实测原译图 · '+pair.title:'真实 Asura 取图 · Return of Mount Hua Sect · 第 1–3 章 · 仅原图'}</strong><span>隔离HTTP验收，不含MV3权限／翻译服务</span><span role="status">{status}</span></div>
      {open?<Reader key={viewKey} viewKey={viewKey} copy={copy} sequence={copies} directory={directory} settings={config} setSettings={changeSettings}
        update={update} onActiveEntry={setId} onLoadEntry={load} onMarkRead={async()=>{}} onNavigate={navigate}
        onBack={()=>setOpen(false)} backLabel="关闭阅读器并保存位置" backText="关闭" onOpenShortcuts={()=>setShortcuts(true)}
        onRetry={noAction} onUpgrade={noAction} onLogin={noAction} translationState={noTranslation} onImport={noAction}
        notify={setStatus} onReadingWindow={noAction} caps={caps} translationScope={scope} busy={false} analyticsBlocked={shortcuts}/>:
        <main className="reader-live-lobby"><h1>真实内容阅读体验验收</h1><p>设置使用现有保存逻辑；位置只由 Reader 的 update 回调写入本地隔离 origin。未补充 pagehide 保存。</p>
          <button className="button primary" onClick={()=>setOpen(true)}>重开阅读器</button>
          <p>最近保存：{copy.title} · {copy.pageId||'起点'} · {copy.relativeOffset.toFixed(4)}</p>
          <p><a href="/tests/reader-live.html">Asura 真实长图前三章</a> · <a href="?sample=translations&amp;pair=mono">黑白原图／中文实测译图</a> · <a href="?sample=translations&amp;pair=color">彩色原图／英文实测译图</a></p>
          <p>已有实测译图仅对应各自网站展示样本，不是 Asura 译图，不触发翻译请求。</p>
        </main>}
      {shortcuts&&<ShortcutPanel initialScope="reader" onClose={()=>setShortcuts(false)}/>}
    </div>;
  }
  createRoot(document.getElementById('root')!).render(<LiveReader/>);
}
void start().catch(error=>{
  createRoot(document.getElementById('root')!).render(<main style={{padding:24}}><h1>隔离真实内容验收未就绪</h1><p role="alert">{(error as Error).message}</p><button onClick={()=>location.reload()}>重试</button><p>仅公开 Asura 三章或已有实测译图；不执行登录、挑战绕过或翻译请求。</p></main>);
});
