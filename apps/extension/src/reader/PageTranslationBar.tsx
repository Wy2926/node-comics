import {msg} from '../i18n/runtime';
import type {Mode} from '../types';
import {Icon} from '../icons';
import {useRef,useState,type ReactNode} from 'react';
import {ReaderTools,ReaderSettingsButton} from './ReaderChrome';

export function PageTranslationBar({selectedView,onView,onRetry,canRetry=false,translationLabel,panel,onPanel,modes,contentLanguageControl,bookmarks}:{
  selectedView:'original'|Mode;onView:(view:'original'|Mode)=>void;
  translationLabel:string;modes?:Mode[];panel?:string;onPanel:(panel:'translation'|'settings')=>void;
  bookmarks?:ReactNode;contentLanguageControl?:ReactNode;onRetry?:()=>Promise<void>;canRetry?:boolean;
}){
  const [retrying,setRetrying]=useState(false),retryLock=useRef(false);
  async function retry(){
    if(!canRetry||!onRetry||retryLock.current)return;
    retryLock.current=true;setRetrying(true);
    try{await onRetry();}finally{retryLock.current=false;setRetrying(false);}
  }
  const views:('original'|'classic')[]=['original',...(modes===undefined||modes.includes('classic')?['classic' as const]:[])];
  const showRetry=!!onRetry&&canRetry,showTranslation=modes===undefined||modes.length>0;
  return <ReaderTools label={msg("翻译与阅读工具")} above={views.length+Number(!!contentLanguageControl)+Number(showRetry)} below={1+Number(showTranslation)}>
    {bookmarks}
    <div className="nc-reader-tool-group" data-scrollbar-mode="overlay">
    {contentLanguageControl}
    {showRetry&&<button data-reader-retry-trigger="true" aria-label={msg('重新翻译此页')} title={msg('重新翻译此页')} disabled={retrying} aria-busy={retrying||undefined} onClick={()=>void retry()}><Icon name="refresh"/><span>{retrying?msg('重试中…'):msg('重新翻译')}</span></button>}
    <div className="nc-page-versions" role="group" aria-label={msg("漫画查看方式")}>
      {views.map(value=><button key={value} aria-label={{original:msg("原图"),classic:msg("翻译")}[value]} title={{original:msg("查看原图"),classic:msg("查看译图")}[value]} aria-pressed={selectedView===value} onClick={()=>onView(value)}><Icon name={{original:'image',classic:'translate'}[value]}/><span>{{original:msg("原图"),classic:msg("翻译")}[value]}</span></button>)}
    </div>
    </div>
    <span className="nc-rail-divider" aria-hidden="true"/>
    <div className="nc-reader-tool-group" data-scrollbar-mode="overlay">
    {showTranslation&&<button className="nc-translation-trigger" aria-label={translationLabel} title={translationLabel} aria-expanded={panel==='translation'} aria-controls="nc-translation-settings" aria-haspopup="dialog" onClick={()=>onPanel('translation')}><Icon name="translate"/><span>{msg("翻译设置")}</span></button>}
    <ReaderSettingsButton open={panel==='settings'} onClick={()=>onPanel('settings')}/>
    </div>
  </ReaderTools>;
}
