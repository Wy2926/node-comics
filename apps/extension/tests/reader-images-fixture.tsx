/** Synthetic images on a dedicated local origin; no source site, supplier or cloud requests. */
import {useCallback,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BlobPicture,type ShownImage} from '../src/reader/Images';
import type {ProcessingImage,ProcessingState} from '../src/image-processing/contracts';
import {sourcePageCache} from '../src/storage/source-pages';
import type {Job} from '../src/types';
import {sourceVerificationError} from '../src/sources/runtime/http';
import '../src/styles.css';
import '../src/redesign.css';

if(location.hostname!=='127.0.0.1'||location.port!=='5181')throw Error('Use the isolated 127.0.0.1:5181 fixture origin.');
const keys={original:'inline-original:reader-images-original',translated:'inline-original:reader-images-translated',broken:'inline-original:reader-images-broken'};
const canvas=new OffscreenCanvas(320,480),context=canvas.getContext('2d')!;
let enhancedBlob:Blob;
for(const kind of ['original','translated','enhanced'] as const){
  context.fillStyle=kind==='original'?'#e5efff':kind==='translated'?'#e9f5e3':'#efe5ff';context.fillRect(0,0,320,480);
  context.fillStyle=kind==='original'?'#315fc7':kind==='translated'?'#367a36':'#713cc7';context.fillRect(24,24,272,280);
  context.fillStyle='#fff';context.font='bold 28px sans-serif';context.fillText(kind.toUpperCase(),36,100);
  const blob=await canvas.convertToBlob({type:'image/png'});
  if(kind==='enhanced')enhancedBlob=blob;else await sourcePageCache.put(keys[kind],blob);
}
await sourcePageCache.put(keys.broken,new Blob(['This is deliberately not a PNG.'],{type:'image/png'}));
canvas.width=canvas.height=1;
const translatedJob:Job={id:'reader-images-translated-job',mode:'classic',target_language:'zh-CN',status:'succeeded',phase:'done',quota_pages:0,created_at:'2026-01-01T00:00:00Z',version:1,cache_hit:true};
const identity=(image:ShownImage|undefined)=>image?{scope:image.scope,key:image.key,job:image.job?.id??'original'}:null;
function Fixture(){
  const [verification,setVerification]=useState(false),[reloading,setReloading]=useState(false),[reloads,setReloads]=useState(0);
  const [errorRevision,setErrorRevision]=useState(0);
  const reload=()=>{if(reloading)return;setReloading(true);setReloads(value=>value+1);setTimeout(()=>{setVerification(false);setKind('original');setReloading(false);},500);};
  const [kind,setKind]=useState<keyof typeof keys>('original'),[scope,setScope]=useState('scope-a'),[mounted,setMounted]=useState(true);
  const [enhancementPhase,setEnhancementPhase]=useState<'cache'|ProcessingState['phase']>();
  const enhancement:ProcessingImage|undefined=enhancementPhase?{identity:'reader-images-enhancement',state:enhancementPhase==='cache'?undefined:{phase:enhancementPhase,message:'Synthetic enhancement failure'},blob:enhancementPhase==='ready'?enhancedBlob:undefined,retry:()=>setEnhancementPhase('queued')}:undefined;
  const [shown,setShown]=useState<ReturnType<typeof identity>>(null),[history,setHistory]=useState<ReturnType<typeof identity>[]>([]),[imports,setImports]=useState(0);
  const onShown=useCallback((image:ShownImage|undefined)=>{const next=identity(image);setShown(next);setHistory(previous=>[...previous,next]);},[]);
  return <main className="nc-app" style={{padding:24,fontFamily:'sans-serif'}}>
    <h1>阅读器图片加载验收</h1>
    <p>本地合成 PNG · 320 × 480 · 无外部服务</p>
    <nav style={{display:'flex',gap:12,marginBottom:16}}>
      <button data-testid="original" onClick={()=>setKind('original')}>原图</button>
      <button data-testid="translated" onClick={()=>setKind('translated')}>译图</button>
      <button data-testid="broken" onClick={()=>setKind('broken')}>损坏文件</button>
      <button data-testid="verification" onClick={()=>{setScope('verification');setVerification(true);}}>CF 验证</button>
      <button data-testid="error-update" onClick={()=>setErrorRevision(value=>value+1)}>更新来源错误</button>
      <button data-testid="scope-a" onClick={()=>setScope('scope-a')}>范围 A</button>
      <button data-testid="scope-b" onClick={()=>setScope('scope-b')}>范围 B</button>
      <button data-testid="mount" onClick={()=>setMounted(value=>!value)}>{mounted?'关闭':'重开'}</button>
    </nav>
    <nav style={{display:'flex',gap:12,marginBottom:16}}>
      {(['cache','queued','running','error','ready'] as const).map(phase=><button key={phase} data-testid={`enhancement-${phase}`} onClick={()=>setEnhancementPhase(phase)}>{phase}</button>)}
    </nav>
    <p>请求：<output data-testid="request">{JSON.stringify({scope,key:keys[kind],mounted})}</output></p>
    <p>已显示：<output data-testid="shown">{JSON.stringify(shown)}</output></p>
    <section data-testid="picture" style={{position:'relative',width:320,minHeight:480,border:'1px solid #98a4b8'}}>
      {mounted&&<BlobPicture scope={scope} blobKey={verification?undefined:keys[kind]} error={verification?sourceVerificationError(403).message:`来源状态 ${errorRevision}`} sourceUrl={verification?'https://hachiraw.net/manga/sample-book':undefined} onReload={reload} reloadBusy={reloading} job={kind==='translated'?translatedJob:undefined} enhancement={enhancement} alt="合成页面" onShown={onShown} onImport={()=>setImports(value=>value+1)}/>}
    </section>
    <output data-testid="history" hidden>{JSON.stringify(history)}</output>
    <output data-testid="imports" hidden>{imports}</output>
    <output data-testid="reloads">{reloads}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
