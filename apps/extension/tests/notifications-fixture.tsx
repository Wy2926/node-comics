/** Shared notification fixture: synthetic messages and visibility, no product data or network. */
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Notification} from '../src/ui/Notification';
import {ImageTranslationStatus} from '../src/reader/ImageTranslationStatus';
import {BlobPicture} from '../src/reader/Images';
import {sourcePageCache} from '../src/storage/source-pages';
import type {TranslationState} from '../src/translation/automatic';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/ui/theme/surfaces.css';

if(location.hostname!=='127.0.0.1'||location.port!=='5187')throw Error('Use isolated http://127.0.0.1:5187.');
const longMessage='请求暂时无法完成，请检查网络或稍后重新尝试。原图和阅读位置已保留。'.repeat(14)+' https://fixture.invalid/'+'diagnostic'.repeat(30);
const readerFixture=new URLSearchParams(location.search).get('reader')==='1';
const originalKey='inline-original:notification-fixture-original',missingKey='inline-original:notification-fixture-missing';
const canvas=new OffscreenCanvas(400,600),drawing=canvas.getContext('2d')!;
drawing.fillStyle='#f0e8fc';drawing.fillRect(0,0,400,600);drawing.fillStyle='#263348';drawing.font='bold 24px sans-serif';drawing.fillText('ORIGINAL COMIC',55,160);drawing.font='20px sans-serif';drawing.fillText('Keep reading this page.',45,260);
const original=await canvas.convertToBlob({type:'image/png'});canvas.width=canvas.height=1;
if(readerFixture)await sourcePageCache.put(originalKey,original);
const originalUrl=readerFixture?URL.createObjectURL(original):'';
if(originalUrl)window.addEventListener('pagehide',()=>URL.revokeObjectURL(originalUrl),{once:true});
let hidden=false;
Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
function Fixture(){
 const [notice,setNotice]=useState<{message:string;tone:'info'|'error'|'success';key:number}>(),[serial,setSerial]=useState(0),[closed,setClosed]=useState(0),[opened,setOpened]=useState(0),[visibility,setVisibility]=useState(false);
 const show=(tone:'info'|'error'|'success',message:string)=>{setSerial(value=>value+1);setNotice({tone,message,key:serial+1});};
 const close=()=>{setNotice(undefined);setClosed(value=>value+1);};
 return <div className="nc-app" style={{minHeight:'100vh'}}>
  <main style={{padding:32}}><h1>提示组件隔离验收</h1><p>只包含模拟信息，不连接身份服务、源站或翻译模型。</p>
   <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
    <button onClick={()=>show('info','登录已过期，请重新登录。原图和阅读位置已保留。')}>信息提示</button>
    <button onClick={()=>show('error','模拟请求失败，请稍后重试。')}>错误提示</button>
    <button onClick={()=>show('success','模拟操作已完成。')}>成功提示</button>
    <button onClick={()=>show('error',longMessage)}>长文本提示</button>
    <button onClick={()=>{hidden=!hidden;setVisibility(hidden);document.dispatchEvent(new Event('visibilitychange'));}}>切换模拟页面隐藏</button>
    <button onClick={()=>{document.documentElement.dataset.appearance=document.documentElement.dataset.appearance==='dark'?'light':'dark';}}>切换亮暗</button>
   </div><label style={{display:'block',marginTop:20}}>提示之外的焦点 <input aria-label="提示之外的焦点"/></label>
   <output data-testid="metrics">关闭 {closed} 次 · 登录入口 {opened} 次 · 页面隐藏 {String(visibility)}</output>
  </main>
  <div className="nc-notifications">{notice&&<Notification key={notice.key} message={notice.message} tone={notice.tone} onClose={close} duration={notice.tone==='success'?6000:undefined} action={notice.tone==='info'?{label:'重新登录',onClick:()=>setOpened(value=>value+1)}:undefined}/>}</div>
 </div>;
}
function ReaderFixture(){
 const [state,setState]=useState<TranslationState>({kind:'login',message:'登录已过期，请重新登录。'}),[imageKey,setImageKey]=useState<string|undefined>(originalKey),[scope,setScope]=useState('fixture-picture'),[calls,setCalls]=useState({login:0,upgrade:0,retry:0,import:0});
 const [cacheRestore,setCacheRestore]=useState<'idle'|'writing'|'complete'|'failed'>('idle');
 const action=(key:keyof typeof calls)=>setCalls(value=>({...value,[key]:value[key]+1}));
 async function restoreCache(){
  setCacheRestore('writing');
  try{setCacheRestore(await sourcePageCache.put(imageKey??missingKey,original)?'complete':'failed');}
  catch{setCacheRestore('failed');}
 }
 return <div className="nc-app" style={{minHeight:'100vh'}}><main style={{padding:24}}><h1>阅读图片提示隔离验收</h1>
  <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
   <button onClick={()=>setState({kind:'login',message:'登录已过期，请重新登录。'})}>设为登录错误</button>
   <button onClick={()=>setState({kind:'upgrade',message:'模拟额度不足'})}>设为额度错误</button>
   <button onClick={()=>setState({kind:'error',message:'模拟网络连接失败'})}>设为可重试错误</button>
   <button onClick={()=>setState({kind:'error',message:'模拟不可重试错误',retryable:false})}>设为不可重试错误</button>
   <button onClick={()=>setState(value=>({...value}))}>重发同一状态</button>
   <button onClick={()=>{setScope('fixture-picture');setImageKey(originalKey);}}>显示旧原图</button>
   <button onClick={()=>setImageKey(missingKey)}>新图片读取失败</button>
   <button onClick={()=>setImageKey(missingKey+'-second')}>新图片再次失败</button>
   <button onClick={()=>{setScope('fixture-empty');setImageKey(undefined);}}>空图片失败</button>
   <button disabled={cacheRestore==='writing'} onClick={()=>void restoreCache()}>补回缺失图片</button>
  </div><output data-testid="reader-metrics">登录 {calls.login} · 升级 {calls.upgrade} · 重试 {calls.retry} · 导入 {calls.import}</output>
  <output data-testid="cache-restore" data-state={cacheRestore} role="status">{{idle:'',writing:'正在补回图片缓存',complete:'图片缓存已补回',failed:'图片缓存补回失败'}[cacheRestore]}</output>
  <div style={{display:'grid',gridTemplateColumns:'400px 400px',gap:36,marginTop:20}}>
   <div className="nc-manga-page" data-testid="translation-picture" style={{position:'relative',height:600}}><img className="nc-page-image" src={originalUrl} alt="翻译状态原图" style={{width:400,height:600}}/><ImageTranslationStatus state={state} onLogin={()=>action('login')} onUpgrade={()=>action('upgrade')} onRetry={()=>action('retry')}/></div>
   <div className="nc-manga-page" data-testid="blob-picture" style={{position:'relative',height:600}}><BlobPicture scope={scope} blobKey={imageKey} alt="图片读取验收" error="模拟无图错误" onImport={()=>action('import')}/></div>
  </div></main></div>;
}
document.documentElement.dataset.appearance='light';
document.documentElement.dataset.accent='sky';
createRoot(document.getElementById('root')!).render(readerFixture?<ReaderFixture/>:<Fixture/>);
