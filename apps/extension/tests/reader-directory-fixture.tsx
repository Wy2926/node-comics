/** Synthetic long directory; uses only local image bytes on the isolated fixture origin. */
import {useCallback,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Reader} from '../src/reader/Reader';
import {Api} from '../src/api';
import {defaults,type ReadingEntry,type Settings} from '../src/types';
import type {ReadingDirectory} from '../src/comics/application/library-service';
import {sourcePageCache} from '../src/storage/source-pages';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if(location.hostname!=='127.0.0.1'||location.port!=='5181')throw Error('Use the isolated 127.0.0.1:5181 fixture origin.');
const api=new Api(location.origin+'/fixture-disabled');
const canvas=new OffscreenCanvas(800,1200),ctx=canvas.getContext('2d')!;
ctx.fillStyle='#e8e4ff';ctx.fillRect(0,0,800,1200);ctx.fillStyle='#695aaa';ctx.font='48px sans-serif';ctx.fillText('Directory fixture',120,180);
await sourcePageCache.put('inline-original:directory-fixture',await canvas.convertToBlob());
const initial:ReadingEntry[]=Array.from({length:620},(_,chapter)=>({id:`chapter-${chapter+1}`,title:`第 ${chapter+1} 章`,source:'fixture',sourceKey:`chapter-${chapter+1}`,generation:1,retention:'offline',createdAt:0,updatedAt:0,discoveryComplete:true,pageId:`page-${chapter+1}-1`,relativeOffset:0,pages:Array.from({length:120},(_,index)=>({id:`page-${chapter+1}-${index+1}`,name:`第 ${index+1} 页`,width:800,height:1200,blobKey:index===7?undefined:'inline-original:directory-fixture',fetchError:index===7?'隔离样本：本页读取失败。':undefined,jobs:[],outputBlobs:{}}))}));
function Fixture(){
 const [copies,setCopies]=useState(initial),[id,setId]=useState('chapter-250'),[config,setConfig]=useState<Settings>({...defaults,layout:'continuous',fit:'window'}),[mounted,setMounted]=useState(true);
 const [grouped,setGrouped]=useState(false),[status,setStatus]=useState('可以阅读'),[empty,setEmpty]=useState(false);
 const copy=copies.find(item=>item.id===id)!;
 const directory=useMemo<ReadingDirectory>(()=>({title:'620 章 · 目录定位验收',sourceUrl:'https://fixture.invalid/comic',entries:copies.map(item=>({id:item.id,title:item.title,tags:[],current:item.id===id,read:false,total:item.pages.length,status})),groups:grouped?[{id:'root',title:'来源分类',entryIds:[]},...Array.from({length:7},(_,n)=>({id:'group-'+n,parentId:'root',title:`分组 ${n+1}`,entryIds:copies.slice(n*100,(n+1)*100).map(item=>item.id)}))]:[]}),[copies,id,grouped,status]);
 const update=useCallback((next:ReadingEntry)=>setCopies(previous=>previous.map(item=>item.id===next.id?next:item)),[]);
 const noop=useCallback(()=>{},[]),mark=useCallback(async()=>{},[]);
 const navigate=useCallback((value:string)=>setId(value),[]);
 return <div className="nc-app" style={{height:'100vh',display:'flex',flexDirection:'column'}}>
  <div style={{padding:8,display:'flex',gap:12,background:'white',zIndex:20}}>
   <button onClick={()=>setMounted(value=>!value)}>{mounted?'关闭阅读器':'重开阅读器'}</button>
   <button onClick={()=>setGrouped(value=>!value)}>切换分组</button>
   <button onClick={()=>setStatus(value=>value==='可以阅读'?'状态已刷新':'可以阅读')}>刷新目录状态</button>
   <button onClick={()=>setEmpty(value=>!value)}>切换页面就绪</button>
   <label>章节<input aria-label="验收章节" type="number" min={1} max={620} value={Number(id.slice(8))} onChange={e=>navigate('chapter-'+e.target.value)}/></label>
   <output aria-label="保存位置">{copy.pageId} · {copy.relativeOffset.toFixed(3)}</output>
  </div>
  {mounted&&<Reader viewKey="isolated-directory-fixture" directory={directory} copy={empty?{...copy,pages:[]}:copy} sequence={copies} settings={config} setSettings={setConfig} update={update} onActiveEntry={navigate} onLoadEntry={noop} onMarkRead={mark} onNavigate={navigate} onBack={()=>setMounted(false)} onRetry={noop} onUpgrade={noop} onLogin={noop} translationState={()=>undefined} onImport={noop} notify={noop} onReadingWindow={noop} apiOrigin={location.origin} api={api} busy={false} onAcquire={noop} onPauseAcquire={noop}/>}
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
