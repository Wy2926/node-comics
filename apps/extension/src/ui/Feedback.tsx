import {useEffect,useRef,useState} from 'react';
import type {Api} from '../api';
import {ApiError} from '../api';
import {Modal} from './components';
import {Icon} from '../icons';
import {languageLabel,modeLabels,type FeedbackIssue,type FeedbackRecord,type Job,type Paginated} from '../types';
export const issueLabels:Record<FeedbackIssue,string>={missing_text:'漏译或未识别',meaning:'意思不准确',typesetting:'文字排版问题',art_changed:'画面被改动',other:'其他问题'};
const feedbackLabels={received:'已收到',reviewing:'查看中',resolved:'已处理'};
type Draft={key:string;issues:FeedbackIssue[];comment:string;submitted?:boolean;locked?:boolean};
export function FeedbackForm({api,job,pageNumber,onClose,onRerun,canRerun}:{api:Api;job:Job;pageNumber:number;onClose:()=>void;onRerun:()=>void;canRerun:boolean}){
  const storageKey=`nc-feedback:${api.base}:${job.id}`;
  const [draft,setDraft]=useState<Draft>(()=>{try{return JSON.parse(localStorage.getItem(storageKey)??'null')??{key:crypto.randomUUID(),issues:[],comment:''};}catch{return {key:crypto.randomUUID(),issues:[],comment:''};}});
  const [sending,setSending]=useState(false);const lock=useRef(false);const [error,setError]=useState('');
  useEffect(()=>{localStorage.setItem(storageKey,JSON.stringify(draft));},[storageKey,draft]);
  async function submit(){if(lock.current)return;lock.current=true;setSending(true);setError('');const payload={...draft,locked:true};setDraft(payload);
    try{await api.feedback(job.id,{issues:payload.issues,comment:payload.comment,output_asset_id:job.output_asset_id},payload.key);if(api.isCurrent())setDraft({...payload,submitted:true});}
    catch(e){if(!api.isCurrent())return;const known=e instanceof ApiError&&e.status>=400&&e.status<500;setDraft({...payload,locked:!known});setError((e as Error).message+(known?'':' 可重试确认，同一份反馈不会重复保存。'));}
    finally{lock.current=false;setSending(false);}
  }
  return <Modal title={draft.submitted?'反馈已收到':'这页译图哪里需要改进？'} subtitle={`第 ${pageNumber} 页 · ${modeLabels[job.mode]} · ${languageLabel(job.target_language)}`} onClose={onClose}>
    {draft.submitted?<div className="nc-feedback-success"><Icon name="check" size={32}/><p>感谢你帮助改善翻译。反馈已绑定刚才看到的译图。</p><span className="nc-muted">提交反馈不扣点数，也不会自动重新翻译。</span></div>:<><div className="nc-issue-options">{(Object.keys(issueLabels) as FeedbackIssue[]).map(issue=><label key={issue} className={draft.issues.includes(issue)?'selected':''}><input type="checkbox" checked={draft.issues.includes(issue)} disabled={sending||draft.locked} onChange={()=>setDraft(d=>({...d,issues:d.issues.includes(issue)?d.issues.filter(i=>i!==issue):[...d.issues,issue]}))}/>{issueLabels[issue]}</label>)}</div><label className="field">补充说明（选填）<textarea rows={4} maxLength={500} placeholder="例如：右下角的对白漏译了。" value={draft.comment} disabled={sending||draft.locked} onChange={e=>setDraft(d=>({...d,comment:e.target.value}))}/></label><p className="nc-muted">选择问题类型或填写说明即可。反馈免费，原图不会被修改。</p>{error&&<p className="inline-error" role="alert">{error}</p>}<button className="button primary full" disabled={sending||(!draft.issues.length&&!draft.comment.trim())} onClick={()=>void submit()}>{sending?'正在提交…':draft.locked?'重试确认反馈':'提交反馈 · 免费'}</button></>}
    <div className="nc-feedback-rerun"><p>想获得新的翻译效果？</p><button className="button secondary" disabled={!canRerun||sending} onClick={onRerun}><Icon name="refresh" size={17}/>重新翻译 · 确认页数</button>{!canRerun&&<span className="nc-muted">当前任务完成或核实后可重新翻译。</span>}</div>
  </Modal>;
}
export function FeedbackInbox({api,admin=false}:{api:Api;admin?:boolean}){
  const [data,setData]=useState<Paginated<FeedbackRecord>>();const [offset,setOffset]=useState(0);const [error,setError]=useState('');const [refresh,setRefresh]=useState(0);const [saving,setSaving]=useState<string>();
  useEffect(()=>{let active=true;setError('');setData(undefined);void api.feedbackList(admin,offset).then(d=>{if(active&&api.isCurrent())setData(d);}).catch(e=>{if(active&&api.isCurrent())setError(e.message);});return()=>{active=false};},[api,offset,refresh,admin]);
  return <section className="settings-card nc-feedback-inbox"><div className="nc-section-heading"><h2>{admin?'读者反馈':'我的反馈'}</h2><button className="button secondary" onClick={()=>setRefresh(v=>v+1)}><Icon name="refresh" size={17}/>刷新</button></div>{error?<p role="alert" className="inline-error">{error}</p>:!data?<p className="nc-muted">正在读取反馈…</p>:!data.items.length?<p className="nc-empty-copy">暂无反馈</p>:<>{data.items.map(row=><article className="nc-feedback-record" key={row.id}><div><b>{row.issues.map(i=>issueLabels[i]).join(' · ')||'补充说明'}</b><p className="nc-preserve-lines">{row.comment||'未填写补充说明'}</p><span className="nc-muted">{new Date(row.created_at).toLocaleString()} · 任务 {row.job_id.slice(0,8)}</span></div>{admin?<select aria-label={`处理反馈 ${row.id}`} value={row.status} disabled={!!saving} onChange={async e=>{setSaving(row.id);try{const updated=await api.reviewFeedback(row.id,e.target.value as FeedbackRecord['status']);if(api.isCurrent())setData(d=>d?{...d,items:d.items.map(i=>i.id===row.id?updated:i)}:d);}catch(e){setError((e as Error).message);}finally{setSaving(undefined);}}}>{Object.entries(feedbackLabels).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select>:<span className="nc-state">{feedbackLabels[row.status]}</span>}</article>)}<div className="nc-pagination"><span>共 {data.total} 条反馈</span><button className="button secondary" disabled={!offset} onClick={()=>setOffset(v=>Math.max(0,v-20))}>上一页</button><button className="button secondary" disabled={data.next_offset==null} onClick={()=>setOffset(data.next_offset!)}>下一页</button></div></>}</section>;
}
