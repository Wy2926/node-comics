import {msg} from '../../i18n/runtime';
import {useState} from 'react';
import {languageLabel,modeLabels,type ReadingCopy} from '../../types';
import {translationSummaries,type TranslationEdition} from '../../library/translations';
import {Thumbnail} from '../../reader/Images';
import {copyCover} from './shared';
import {CardBody} from './CardBody';

export function TranslationCopies({copies,userId,origin,onOpen}:{copies:ReadingCopy[];userId?:string;origin?:string;onOpen:(id:string,edition:TranslationEdition)=>void}){
 const [filter,setFilter]=useState('all');
 const items=copies.flatMap(copy=>translationSummaries(copy,userId,origin).map(summary=>({copy,summary})));
 const visible=items.filter(({summary:s})=>filter==='all'||s.mode===filter);
 return <section className="nc-translation-copies" aria-label={msg("插件译本")}>
  <div className="nc-section-heading"><div><h2>{msg("插件译本")}<span className="nc-count-pill">{items.length}</span></h2><p className="nc-muted">{msg("按原始副本、翻译方式和语言整理。逐页采用最新结果，未译页显示原图。")}</p></div></div>
  <div className="nc-filter-chips" aria-label={msg("插件译本筛选")}>{[['all',msg("全部")],['classic',msg("常规翻译")],['redraw',msg("AI 重绘")]].map(([id,label])=><button key={id} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}</button>)}</div>
  <div className="nc-translation-grid">{visible.map(({copy,summary:s})=>{
   const readable=s.local+s.remote;
   return <article className="nc-translation-card" key={s.id}>
    <Thumbnail blobKey={copyCover(copy)?.blobKey} alt={msg("{0}原始副本封面", {"0": copy.title})}/>
    <CardBody eyebrow={modeLabels[s.mode]+' · '+languageLabel(s.language)} title={copy.title} metadata={[msg("{0} · 原始副本修订 {1}", {"0": copy.source, "1": copy.manifestRevision}),msg("{0} / {1} 页已有译图", {"0": readable, "1": s.total??'?'}),[msg("{0} 页在本机", {"0": s.local}),s.remote>0&&msg("{0} 页待恢复", {"0": s.remote}),s.noText>0&&msg("{0} 页无文字", {"0": s.noText})].filter(Boolean).join(' · '),[s.pending&&msg("{0} 页处理中或待核实", {"0": s.pending}),s.failed&&msg("{0} 页失败", {"0": s.failed}),s.expired&&msg("{0} 页译图失效", {"0": s.expired})].filter(Boolean).join(' · ')]}><button className={'button small full '+(readable||s.noText?'primary':'secondary')} onClick={()=>onOpen(copy.id,{mode:s.mode,language:s.language})}>{readable||s.noText?msg("阅读此译本"):msg("查看进度与原图")}</button></CardBody>
   </article>;
  })}</div>
  {!visible.length&&<p className="nc-translation-empty">{!userId?msg("登录后显示当前账户在此服务上的插件译本。"):msg("还没有对应的翻译结果。阅读时完成翻译后会自动归入这里。")}</p>}
  {!!visible.length&&<p className="nc-translation-footnote">{msg("译本与原始副本共用阅读位置。打开已有结果不新建翻译任务；本地图片清理后，可恢复账户中仍可用的服务器原图与译图。")}</p>}
 </section>;
}
