import {msg} from '../i18n/runtime';
import type {Job,Mode} from '../types';
import {Icon} from '../icons';
import type {ReactNode} from 'react';

export function PageTranslationBar({selectedView,shownJob,onView,onFeedback,translationLabel,panel,onPanel,modes,allowsFeedback=true,contentLanguageControl}:{
  selectedView:'original'|Mode;shownJob?:Job;onView:(view:'original'|Mode)=>void;onFeedback:()=>void;
  translationLabel:string;modes?:Mode[];allowsFeedback?:boolean;panel?:string;onPanel:(panel:'translation'|'settings')=>void;
  contentLanguageControl?:ReactNode;
}){
  return <nav className="nc-reader-rail right nc-reader-controls" aria-label={msg("翻译与阅读工具")}>
    <div className="nc-page-versions" role="group" aria-label={msg("漫画查看方式")} data-shown-job={shownJob?.id??'original'}>
      {(['original',...(modes===undefined||modes.includes('classic')?['classic']:[])] as ('original'|'classic')[]).map(value=><button key={value} aria-label={{original:msg("原图"),classic:msg("常规翻译")}[value]} title={{original:msg("查看原图"),classic:msg("查看常规译图")}[value]} aria-pressed={selectedView===value} onClick={()=>onView(value)}><Icon name={{original:'image',classic:'translate'}[value]}/><span>{{original:msg("原图"),classic:msg("常规")}[value]}</span></button>)}
    </div>
    <span className="nc-rail-divider"/>
    {contentLanguageControl}
    <button className="nc-translation-trigger" aria-label={translationLabel} title={translationLabel} aria-expanded={panel==='translation'} aria-controls="nc-translation-settings" aria-haspopup="dialog" onClick={()=>onPanel('translation')}><Icon name="translate"/><span>{msg("翻译设置")}</span></button>
    <button data-reader-settings-trigger="true" aria-label={msg("阅读设置")} title={msg("阅读设置")} aria-expanded={panel==='settings'} onClick={()=>onPanel('settings')}><Icon name="settings"/><span>{msg("阅读设置")}</span></button>
    {allowsFeedback&&shownJob&&<button aria-label={msg("译图有问题")} title={msg("译图有问题")} onClick={onFeedback}><Icon name="info"/><span>{msg("反馈")}</span></button>}
  </nav>;
}
