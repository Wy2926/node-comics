import {msg,getLocale} from '../i18n/runtime';
import {useEffect,useRef,useState} from 'react';
import type {Api} from '../api';
import {ApiError} from '../api';
import {Modal} from './components';
import {Icon} from '../icons';
import {languageLabel,modeLabels,type FeedbackIssue,type FeedbackRecord,type Job,type Paginated} from '../types';
export const issueLabels:Record<FeedbackIssue,string>={get missing_text(){return msg("漏译或未识别");},get meaning(){return msg("意思不准确");},get typesetting(){return msg("文字排版问题");},get art_changed(){return msg("画面被改动");},get other(){return msg("其他问题");}};
const feedbackLabels={get received(){return msg("已收到");},get reviewing(){return msg("查看中");},get resolved(){return msg("已处理");}};
type Draft={key:string;issues:FeedbackIssue[];comment:string;submitted?:boolean;locked?:boolean};
export function FeedbackForm({api,job,pageNumber,onClose,onRerun,canRerun}:{api:Api;job:Job;pageNumber:number;onClose:()=>void;onRerun:()=>void;canRerun:boolean}){
  const storageKey=`nc-feedback:${api.base}:${job.id}`;
  const [draft,setDraft]=useState<Draft>(()=>{try{return JSON.parse(localStorage.getItem(storageKey)??'null')??{key:crypto.randomUUID(),issues:[],comment:''};}catch{return {key:crypto.randomUUID(),issues:[],comment:''};}});
  const [sending,setSending]=useState(false);const lock=useRef(false);const [error,setError]=useState('');
  useEffect(()=>{localStorage.setItem(storageKey,JSON.stringify(draft));},[storageKey,draft]);
  async function submit(){if(lock.current)return;lock.current=true;setSending(true);setError('');const payload={...draft,locked:true};setDraft(payload);
    try{await api.feedback(job.id,{issues:payload.issues,comment:payload.comment,output_asset_id:job.output_asset_id},payload.key);if(api.isCurrent())setDraft({...payload,submitted:true});}
    catch(e){if(!api.isCurrent())return;const known=e instanceof ApiError&&e.status>=400&&e.status<500;setDraft({...payload,locked:!known});setError((e as Error).message+(known?'':msg(" 可重试确认，同一份反馈不会重复保存。")));}
    finally{lock.current=false;setSending(false);}
  }
  return <Modal title={draft.submitted?msg("反馈已收到"):msg("这页译图哪里需要改进？")} subtitle={msg("第 {0} 页 · {1} · {2}", {"0": pageNumber, "1": modeLabels[job.mode], "2": languageLabel(job.target_language)})} onClose={onClose}>
    {draft.submitted?<div className="nc-feedback-success"><Icon name="check" size={32}/><p>{msg("感谢你帮助改善翻译。反馈已绑定刚才看到的译图。")}</p><span className="nc-muted">{msg("提交反馈免费，也不会自动重新翻译。")}</span></div>:<><div className="nc-issue-options">{(Object.keys(issueLabels) as FeedbackIssue[]).map(issue=><label key={issue} className={draft.issues.includes(issue)?'selected':''}><input type="checkbox" checked={draft.issues.includes(issue)} disabled={sending||draft.locked} onChange={()=>setDraft(d=>({...d,issues:d.issues.includes(issue)?d.issues.filter(i=>i!==issue):[...d.issues,issue]}))}/>{issueLabels[issue]}</label>)}</div><label className="field">{msg("补充说明（选填）")}<textarea rows={4} maxLength={500} placeholder={msg("例如：右下角的对白漏译了。")} value={draft.comment} disabled={sending||draft.locked} onChange={e=>setDraft(d=>({...d,comment:e.target.value}))}/></label><p className="nc-muted">{msg("选择问题类型或填写说明即可。反馈免费，原图不会被修改。")}</p>{error&&<p className="inline-error" role="alert">{error}</p>}<button className="button primary full" disabled={sending||(!draft.issues.length&&!draft.comment.trim())} onClick={()=>void submit()}>{sending?msg("正在提交…"):draft.locked?msg("重试确认反馈"):msg("提交反馈 · 免费")}</button></>}
    <div className="nc-feedback-rerun"><p>{msg("想获得新的翻译效果？")}</p><button className="button secondary" disabled={!canRerun||sending} onClick={onRerun}><Icon name="refresh" size={17}/>{msg("重新翻译此页")}</button>{!canRerun&&<span className="nc-muted">{msg("当前任务完成或核实后可重新翻译。")}</span>}</div>
  </Modal>;
}
export function FeedbackInbox({api}:{api:Api}){
  const [data,setData]=useState<Paginated<FeedbackRecord>>();const [offset,setOffset]=useState(0);const [error,setError]=useState('');const [refresh,setRefresh]=useState(0);
  useEffect(()=>{let active=true;setError('');setData(undefined);void api.feedbackList(offset).then(d=>{if(active&&api.isCurrent())setData(d);}).catch(e=>{if(active&&api.isCurrent())setError(e.message);});return()=>{active=false};},[api,offset,refresh]);
  return <section className="settings-card nc-feedback-inbox"><div className="nc-section-heading"><h2><Icon name="message"/>{msg("我的反馈")}</h2><button className="button secondary" onClick={()=>setRefresh(v=>v+1)}><Icon name="refresh" size={17}/>{msg("刷新")}</button></div>{error?<p role="alert" className="inline-error">{error}</p>:!data?<p className="nc-muted">{msg("正在读取反馈…")}</p>:!data.items.length?<p className="nc-empty-copy">{msg("暂无反馈")}</p>:<>{data.items.map(row=><article className="nc-feedback-record" key={row.id}><div><b>{row.issues.map(i=>issueLabels[i]).join(' · ')||msg("补充说明")}</b><p className="nc-preserve-lines">{row.comment||msg("未填写补充说明")}</p><span className="nc-muted">{msg("{0} · 任务 {1}", {"0": new Date(row.created_at).toLocaleString(getLocale()), "1": row.job_id.slice(0,8)})}</span></div><span className="nc-state">{feedbackLabels[row.status]}</span></article>)}<div className="nc-pagination"><span>{msg("共 {0} 条反馈", {"0": data.total})}</span><button className="button secondary" disabled={!offset} onClick={()=>setOffset(v=>Math.max(0,v-20))}>{msg("上一页")}</button><button className="button secondary" disabled={data.next_offset==null} onClick={()=>setOffset(data.next_offset!)}>{msg("下一页")}</button></div></>}</section>;
}
