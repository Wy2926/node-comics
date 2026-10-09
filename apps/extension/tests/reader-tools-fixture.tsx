/** Local toolbar geometry and interaction fixture; no comic, cloud or supplier requests. */
import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Icon} from '../src/icons';
import {PageTranslationBar} from '../src/reader/PageTranslationBar';
import {ReaderShell} from '../src/reader/ReaderChrome';
import {Scrollbars} from '../src/ui/Scrollbars';
import type {Job} from '../src/types';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/ui/theme/surfaces.css';

if(location.origin!=='http://127.0.0.1:5181')throw Error('Use the isolated http://127.0.0.1:5181 fixture origin.');
const shownJob:Job={id:'reader-tools-fixture-result',mode:'classic',target_language:'zh-Hans',status:'succeeded',phase:'done',quota_pages:0,created_at:'2026-01-01T00:00:00Z',version:1,cache_hit:true,model:{id:'model-fixture',name:'Claude Haiku 5.5'}};

function Fixture(){
  const root=useRef<HTMLDivElement>(null);
  const [language,setLanguage]=useState(false),[retry,setRetry]=useState(false),[feedback,setFeedback]=useState(false),[translation,setTranslation]=useState(true);
  const [dark,setDark]=useState(new URLSearchParams(location.search).get('theme')==='dark');
  const [view,setView]=useState<'original'|'classic'>('original'),[panel,setPanel]=useState<'translation'|'settings'>();
  const [retryClicks,setRetryClicks]=useState(0),[feedbackClicks,setFeedbackClicks]=useState(0),[languageClicks,setLanguageClicks]=useState(0);
  useEffect(()=>{document.documentElement.dataset.appearance=dark?'dark':'light';document.documentElement.dataset.accent='sky';},[dark]);
  const count=translation?4+Number(language)+Number(retry)+Number(feedback):2+Number(language)+Number(retry)+Number(feedback);
  return <div className="nc-app" style={{height:'100dvh',minHeight:0,display:'flex',flexDirection:'column'}}>
    <Scrollbars/>
    <style>{'.reader-tools-fixture-stage > .nc-reader {height:100%;}'}</style>
    <header style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:8,padding:8,flexShrink:0,background:'var(--surface)',borderBottom:'1px solid var(--line)'}}>
      <strong>隔离工具栏验收</strong>
      <button data-testid="toggle-language" aria-pressed={language} onClick={()=>setLanguage(value=>!value)}>切换内容语言</button>
      <button data-testid="toggle-retry" aria-pressed={retry} onClick={()=>setRetry(value=>!value)}>切换重新翻译</button>
      <button data-testid="toggle-feedback" aria-pressed={feedback} onClick={()=>setFeedback(value=>!value)}>切换反馈</button>
      <button data-testid="toggle-translation" aria-pressed={translation} onClick={()=>{setTranslation(value=>!value);setView('original');setPanel(undefined);}}>切换翻译能力</button>
      <button data-testid="toggle-dark" aria-pressed={dark} onClick={()=>setDark(value=>!value)}>切换亮暗</button>
      <output data-testid="fixture-state" aria-label="工具栏验收状态" style={{fontSize:11,flexBasis:'100%',overflowWrap:'anywhere'}}>{JSON.stringify({count,language,retry,feedback,translation,dark,view,panel:panel??null,retryClicks,feedbackClicks,languageClicks})}</output>
    </header>
    <section className="reader-tools-fixture-stage" style={{position:'relative',flex:1,minHeight:0}}>
      <ReaderShell ref={root} background={dark?'night':'gray'} immersive={false} hidden={false} reveal={()=>{}}>
        <PageTranslationBar selectedView={view} onView={setView} modes={translation?['classic']:[]} shownJob={feedback?shownJob:undefined}
          allowsFeedback={feedback} onFeedback={()=>setFeedbackClicks(value=>value+1)}
          onRetry={async()=>{setRetryClicks(value=>value+1);await new Promise(resolve=>setTimeout(resolve,250));}} canRetry={retry}
          contentLanguageControl={language?<button className="nc-reader-language" aria-label="内容语言偏好" title="内容语言偏好" onClick={()=>setLanguageClicks(value=>value+1)}><Icon name="translate"/><span>内容语言偏好</span></button>:undefined}
          translationLabel="翻译设置" panel={panel} onPanel={next=>setPanel(current=>current===next?undefined:next)}/>
        <main className="nc-reading-viewport" style={{display:'grid',placeItems:'center',color:'var(--reading-ink)'}}>
          <p>真实阅读器工具栏 · {count} 个按钮 · 无外部请求</p>
        </main>
      </ReaderShell>
    </section>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
