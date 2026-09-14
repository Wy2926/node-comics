import {modeLabels} from '../types';
import {useEffect,useState} from 'react';
import {Api} from '../api';
import {Status} from '../App';
import {Icon} from '../icons';
import type {Job} from '../types';
/** Server history remains available after a local chapter or browser cache is removed. */
export function ServerJobs({api,knownIds}:{api:Api;knownIds:string[]}){
  const [jobs,setJobs]=useState<Job[]>([]);const [offset,setOffset]=useState(0);const [total,setTotal]=useState(0);const [error,setError]=useState('');
  useEffect(()=>{if(!api.token)return;let active=true;let timer:ReturnType<typeof setTimeout>;async function fetchPage(){try{const response=await api.request<{items:Job[];total:number}>(`/v1/jobs?offset=${offset}&limit=30`);if(active){setJobs(response.items);setTotal(response.total);setError('');}}catch(e){if(active)setError((e as Error).message);}if(active)timer=setTimeout(fetchPage,5000);}void fetchPage();return()=>{active=false;clearTimeout(timer);};},[api,offset]);
  if(!api.token)return null;
  const remaining=jobs.filter(j=>!knownIds.includes(j.id));
  async function download(job:Job){try{const blob=await api.image(job.output_asset_id!);const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`AI-${job.target_language}-v${job.version}.${blob.type==='image/jpeg'?'jpg':blob.type==='image/webp'?'webp':'png'}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setError((e as Error).message);}}
  return <section className="settings-card" style={{marginTop:24}}><h3><Icon name="globe"/>服务器任务档案</h3><p className="small-muted" style={{margin:'12px 0',lineHeight:1.8}}>本地漫画被移除后，已提交的任务仍可在这里找回。下方显示尚未关联本地书架的任务。</p>{error&&<p className="inline-error">{error}</p>}{remaining.map(job=><div className="job-row" key={job.id}><span className="feature-icon pink"><Icon name="spark"/></span><div className="job-main"><b>{modeLabels[job.mode]} · {job.target_language} · 版本 {job.version}</b><small>{job.id.slice(0,8)} · {new Date(job.created_at).toLocaleString()}</small>{job.error&&<p className="inline-error">{job.error.message}</p>}</div><Status job={job}/>{job.output_asset_id?<button className="button secondary small" onClick={()=>void download(job)}>保存译图</button>:job.status==='succeeded'?<span className="small-muted">结果已过期 / 删除</span>:null}</div>)}{!remaining.length&&<p className="empty-copy">本页服务器任务已关联书架，或暂时没有记录。</p>}<div className="section-actions" style={{justifyContent:'flex-end'}}><span className="small-muted">服务器共 {total} 项</span><button className="button secondary small" disabled={offset===0} onClick={()=>setOffset(n=>Math.max(0,n-30))}>上一页</button><button className="button secondary small" disabled={offset+30>=total} onClick={()=>setOffset(n=>n+30)}>下一页</button></div></section>;
}
