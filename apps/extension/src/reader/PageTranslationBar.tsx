import {Icon} from '../icons';
import {type Capabilities,type Job,type Mode,type Page} from '../types';
import {pageTranslation,taskText} from './presentation';
import {TaskActivity} from './TaskActivity';

export function PageTranslationBar({page,number,mode,selectedView,shownJob,languageId,ownerId,origin,note,preparing,busy,caps,onView,onTranslate,onProgress,onFeedback}:{
  page:Page;number:number;mode:Mode;selectedView:'original'|Mode;shownJob?:Job;languageId:string;ownerId?:string;origin:string;note:string;preparing:boolean;busy:boolean;caps?:Capabilities;
  onView:(view:'original'|Mode)=>void;onTranslate:(mode:Mode)=>void;onProgress:()=>void;onFeedback:()=>void;
}){
  const classic=pageTranslation(page,'classic',languageId,ownerId,origin);
  const redraw=pageTranslation(page,'redraw',languageId,ownerId,origin);
  const labels={classic:'常规翻译',redraw:'AI 重绘'};
  const shownView=shownJob?.mode??'original';
  const selected=selectedView==='original'?undefined:selectedView==='classic'?classic:redraw;
  const shownLabel=shownJob?.mode==='classic'?'常规译图':shownJob?'AI 重绘译图':'原图';
  const viewNote=selectedView!==shownView
    ? `${note||(selectedView==='original'?'正在切换原图':selected?.ready?`正在读取${labels[selectedView]}`:`${labels[selectedView]}尚未生成`)} · 当前显示${shownLabel}`
    : note;
  // Viewing a result never submits a task. Generation has its own direct action.
  const action=(value:Mode)=>{
    const t=value==='classic'?classic:redraw;
    if(t.ready)return null;
    const restoring=!!t.result?.output_asset_id&&!t.expired;
    const pending=!!t.pending;
    const benefit=caps?.entitlements?.modes[value];
    const accessHint=value==='redraw'&&benefit&&!benefit.allowed?'需要 PLUS 或有效重绘赠送额度':value==='classic'&&benefit?.unlimited?'PLUS 常规不限量':benefit?.quota?`可用 ${benefit.quota.available} 页`:'';
    return <button key={value} className="nc-translate-page" disabled={!pending&&!restoring&&(busy||preparing||!caps?.modes.find(m=>m.id===value)?.enabled)} onClick={()=>pending||restoring?onView(value):onTranslate(value)} title={pending?taskText(t.pending):restoring?'正在读取已有译图':`仅${labels[value]}当前第 ${number} 页${accessHint?` · ${accessHint}`:""}`}>
      {pending&&t.pending?.status!=='outcome_unknown'?<TaskActivity waiting={t.pending?.status==='queued'}/>:<Icon name={value==='redraw'?'spark':'globe'} size={15}/>}
      {pending?`${labels[value]}${t.pending?.status==='outcome_unknown'?'待核实':t.pending?.status==='queued'?'排队中':'中'}`:restoring?`${labels[value]}读取中`:value==='redraw'?`AI 重绘本页${benefit&&!benefit.allowed?' · PLUS':''}`:'翻译本页'}
    </button>;
  };
  return <div className="nc-reader-status">
    <div className="nc-page-status-main">
    <span className="nc-current-page-number">第 {number} 页</span>
    <div className="nc-page-versions" role="group" aria-label="本页查看方式" data-shown-job={shownJob?.id??'original'}>
      <button aria-pressed={selectedView==='original'} onClick={()=>onView('original')}>原图</button>
      {(['classic','redraw'] as const).map(value=>{
        const t=value==='classic'?classic:redraw;
        return <button key={value} aria-pressed={selectedView===value} title={`${labels[value]} · ${t.pending?taskText(t.pending):t.ready?'已就绪':t.expired?'已过期':'尚未生成'}`} onClick={()=>onView(value)}>{labels[value]}</button>;
      })}
    </div>
    <div className="nc-page-status-side">
    {mode==='classic'&&action('classic')}
    {action('redraw')}
    {shownJob&&<button className="text-link" onClick={onFeedback}>译图有问题</button>}
    <span className="nc-page-status-note" role="status" aria-live="polite">{viewNote&&<button className="nc-task-note" title={viewNote} onClick={onProgress}>{preparing&&<TaskActivity/>}<span>{viewNote}</span></button>}</span>
    </div>
    </div>
  </div>;
}
