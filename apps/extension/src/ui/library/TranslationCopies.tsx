import {useState} from 'react';
import {languageLabel,modeLabels,type ReadingCopy} from '../../types';
import {translationSummaries,type TranslationEdition} from '../../library/translations';
import {Thumbnail} from '../../reader/Images';
import {copyCover} from './shared';

export function TranslationCopies({copies,userId,origin,onOpen}:{copies:ReadingCopy[];userId?:string;origin?:string;onOpen:(id:string,edition:TranslationEdition)=>void}){
 const [filter,setFilter]=useState('all');
 const items=copies.flatMap(copy=>translationSummaries(copy,userId,origin).map(summary=>({copy,summary})));
 const visible=items.filter(({summary:s})=>filter==='all'||s.mode===filter);
 return <section className="nc-translation-copies" aria-label="插件译本">
  <div className="nc-section-heading"><div><h2>插件译本 <span className="nc-count-pill">{items.length}</span></h2><p className="nc-muted">按原始副本、翻译方式和语言整理。逐页采用最新结果，未译页显示原图。</p></div></div>
  <div className="nc-filter-chips" aria-label="插件译本筛选">{[['all','全部'],['classic','常规翻译'],['redraw','AI 重绘']].map(([id,label])=><button key={id} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}</button>)}</div>
  <div className="nc-translation-grid">{visible.map(({copy,summary:s})=>{
   const readable=s.local+s.remote;
   return <article className="nc-translation-card" key={s.id}>
    <Thumbnail blobKey={copyCover(copy)?.blobKey} alt={copy.title+'原始副本封面'}/>
    <div><span className="nc-card-kicker">{modeLabels[s.mode]} · {languageLabel(s.language)}</span><h3>{copy.title}</h3><p>{copy.source} · 原始副本修订 {copy.manifestRevision}</p><strong>{readable} / {s.total??'?'} 页已有译图</strong><p>{s.local} 页在本机{s.remote>0&&` · ${s.remote} 页待恢复`}{s.noText>0&&` · ${s.noText} 页无文字`}</p><p className="nc-translation-attention">{[s.pending&&`${s.pending} 页处理中或待核实`,s.failed&&`${s.failed} 页失败`,s.expired&&`${s.expired} 页译图失效`].filter(Boolean).join(' · ')}</p><button className={'button small '+(readable||s.noText?'primary':'secondary')} onClick={()=>onOpen(copy.id,{mode:s.mode,language:s.language})}>{readable||s.noText?'阅读此译本':'查看进度与原图'}</button></div>
   </article>;
  })}</div>
  {!visible.length&&<p className="nc-translation-empty">{!userId?'登录后显示当前账户在此服务上的插件译本。':'还没有对应的翻译结果。阅读时完成翻译后会自动归入这里。'}</p>}
  {!!visible.length&&<p className="nc-translation-footnote">译本与原始副本共用阅读位置。打开已有结果不启动自动翻译；本地图片清理后，保留期内可恢复服务器译图。</p>}
 </section>;
}
