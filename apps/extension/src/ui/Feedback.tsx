import {msg,getLocale} from '../i18n/runtime';
import {useEffect,useState} from 'react';
import type {Api} from '../api';
import {Icon} from '../icons';
import type {FeedbackIssue,FeedbackRecord,Paginated} from '../types';
export const issueLabels:Record<FeedbackIssue,string>={get missing_text(){return msg("漏译或未识别");},get meaning(){return msg("意思不准确");},get typesetting(){return msg("文字排版问题");},get art_changed(){return msg("画面被改动");},get other(){return msg("其他问题");}};
const feedbackLabels={get received(){return msg("已收到");},get reviewing(){return msg("查看中");},get resolved(){return msg("已处理");}};
export function FeedbackInbox({api}:{api:Api}){
  const [data,setData]=useState<Paginated<FeedbackRecord>>();const [offset,setOffset]=useState(0);const [error,setError]=useState('');const [refresh,setRefresh]=useState(0);
  useEffect(()=>{let active=true;setError('');setData(undefined);void api.feedbackList(offset).then(d=>{if(active&&api.isCurrent())setData(d);}).catch(e=>{if(active&&api.isCurrent())setError(e.message);});return()=>{active=false};},[api,offset,refresh]);
  return <section className="settings-card nc-feedback-inbox"><div className="nc-section-heading"><h2><Icon name="message"/>{msg("我的反馈")}</h2><button className="button secondary" onClick={()=>setRefresh(v=>v+1)}><Icon name="refresh" size={17}/>{msg("刷新")}</button></div>{error?<p role="alert" className="inline-error">{error}</p>:!data?<p className="nc-muted">{msg("正在读取反馈…")}</p>:!data.items.length?<p className="nc-empty-copy">{msg("暂无反馈")}</p>:<>{data.items.map(row=><article className="nc-feedback-record" key={row.id}><div><b>{row.issues.map(i=>issueLabels[i]).join(' · ')||msg("补充说明")}</b><p className="nc-preserve-lines">{row.comment||msg("未填写补充说明")}</p><span className="nc-muted">{msg("{0} · 任务 {1}", {"0": new Date(row.created_at).toLocaleString(getLocale()), "1": row.translation_id.slice(0,8)})}</span></div><span className="nc-state">{feedbackLabels[row.status]}</span></article>)}<div className="nc-pagination"><span>{msg("共 {0} 条反馈", {"0": data.total})}</span><button className="button secondary" disabled={!offset} onClick={()=>setOffset(v=>Math.max(0,v-20))}>{msg("上一页")}</button><button className="button secondary" disabled={data.next_offset==null} onClick={()=>setOffset(data.next_offset!)}>{msg("下一页")}</button></div></>}</section>;
}
