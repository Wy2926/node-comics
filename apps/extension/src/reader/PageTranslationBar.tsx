import type {Job,Mode} from '../types';

export function PageTranslationBar({number,selectedView,shownJob,onView,onFeedback}:{
  number:number;selectedView:'original'|Mode;shownJob?:Job;onView:(view:'original'|Mode)=>void;onFeedback:()=>void;
}){
  return <div className="nc-reader-status"><div className="nc-page-status-main">
    <span className="nc-current-page-number">第 {number} 页</span>
    <div className="nc-page-versions" role="group" aria-label="本页查看方式" data-shown-job={shownJob?.id??'original'}>
      {(['original','classic','redraw'] as const).map(value=><button key={value} aria-pressed={selectedView===value} onClick={()=>onView(value)}>{{original:'原图',classic:'常规翻译',redraw:'AI 重绘'}[value]}</button>)}
    </div>
    {shownJob&&<button className="text-link" onClick={onFeedback}>译图有问题</button>}
  </div></div>;
}
