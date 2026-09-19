import type {Job,Mode} from '../types';
import {Icon} from '../icons';

export function PageTranslationBar({selectedView,shownJob,onView,onFeedback,translationLabel,panel,onPanel}:{
  selectedView:'original'|Mode;shownJob?:Job;onView:(view:'original'|Mode)=>void;onFeedback:()=>void;
  translationLabel:string;panel?:string;onPanel:(panel:'translation'|'settings')=>void;
}){
  return <nav className="nc-reader-rail right nc-reader-controls" aria-label="翻译与阅读工具">
    <div className="nc-page-versions" role="group" aria-label="本页查看方式" data-shown-job={shownJob?.id??'original'}>
      {(['original','classic','redraw'] as const).map(value=><button key={value} aria-label={{original:'原图',classic:'常规翻译',redraw:'AI 重绘'}[value]} title={{original:'查看原图',classic:'查看常规译图',redraw:'查看 AI 重绘'}[value]} aria-pressed={selectedView===value} onClick={()=>onView(value)}><Icon name={{original:'image',classic:'globe',redraw:'spark'}[value]}/><span>{{original:'原图',classic:'常规',redraw:'AI'}[value]}</span></button>)}
    </div>
    <span className="nc-rail-divider"/>
    <button className="nc-translation-trigger" aria-label={translationLabel} title={translationLabel} aria-expanded={panel==='translation'} aria-controls="nc-translation-settings" aria-haspopup="dialog" onClick={()=>onPanel('translation')}><Icon name="globe"/><span>翻译设置</span></button>
    <button aria-label="阅读设置" title="阅读设置" aria-expanded={panel==='settings'} onClick={()=>onPanel('settings')}><Icon name="settings"/><span>阅读设置</span></button>
    {shownJob&&<button aria-label="译图有问题" title="译图有问题" onClick={onFeedback}><Icon name="info"/><span>反馈</span></button>}
  </nav>;
}
