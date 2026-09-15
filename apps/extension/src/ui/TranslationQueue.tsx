import {useState} from 'react';
import type {Job,Mode,ModeQueue} from '../types';
import {modeLabels} from '../types';
import {pendingStatuses} from '../reader/jobs';
import {taskText} from '../reader/presentation';
import type {UploadManifest} from '../translation/store';
import {Icon} from '../icons';
import './translation-queue.css';

export function TranslationQueue({queues,jobs,manifests,error,onPause,onLocalPause,onCancel,onOpen,onLogin,loggedIn,compact=false}:{queues:ModeQueue[];jobs:Job[];manifests:UploadManifest[];error:string;onPause:(mode:Mode,paused:boolean)=>Promise<void>;onLocalPause:(id:string,paused:boolean)=>Promise<void>;onCancel:(job:Job)=>Promise<void>;onOpen:(job:Job)=>void;onLogin:()=>void;loggedIn:boolean;compact?:boolean}){
 const [selected,setSelected]=useState<Mode>('classic'),[busy,setBusy]=useState(''),[actionError,setActionError]=useState('');
 const act=async(key:string,fn:()=>Promise<void>)=>{setBusy(key);setActionError('');try{await fn();}catch(e){setActionError((e as Error).message);}finally{setBusy('');}};
 const queue=queues.find(q=>q.mode===selected),active=jobs.filter(j=>j.mode===selected&&pendingStatuses.has(j.status)).sort((a,b)=>Number(b.priority==='realtime')-Number(a.priority==='realtime')||(a.user_order??0)-(b.user_order??0));
 const local=manifests.filter(m=>m.mode===selected&&(m.pending||m.items.some(i=>i.state==='local'||i.state==='failed')));
 return <section className={`nc-translation-queues ${compact?'compact':''}`} aria-label="翻译队列">
  {!compact&&<div className="nc-page-heading"><div><span className="nc-eyebrow">YOUR TRANSLATION QUEUES</span><h1>翻译队列</h1><p>提前上传，服务器持续翻译。当前阅读优先，同级用户按套餐权重公平分配。</p></div></div>}
  {!loggedIn?<div className="nc-empty"><Icon name="globe" size={32}/><h2>登录后管理服务器队列</h2><button className="button primary" onClick={onLogin}>登录账户</button></div>:<>
  <div className="nc-mode-queues" role="tablist" aria-label="翻译模式队列">{(['classic','redraw'] as const).map(mode=>{const value=queues.find(q=>q.mode===mode);return <button role="tab" aria-selected={selected===mode} className={selected===mode?'active':''} key={mode} onClick={()=>setSelected(mode)}><Icon name={mode==='classic'?'globe':'spark'}/><span>{modeLabels[mode]}<strong>{value?`${value.in_flight} / ${value.capacity}`:'正在同步'}</strong><small>{value?`实时 ${value.realtime_count} / ${value.realtime_limit}`:'各模式独立计数'}</small></span></button>;})}</div>
  {(error||actionError)&&<p className="inline-error" role="alert">{actionError||error}</p>}
  {queue&&<div className="nc-queue-summary"><div><b>{queue.paused?'服务器队列已暂停':'服务器持续处理'}</b><p>等待 {queue.queued} · 处理中 {queue.running} · 等待原图 {queue.awaiting_upload}</p></div><button className="button secondary small" disabled={!!busy} onClick={()=>void act(selected,()=>onPause(selected,!queue.paused))}>{queue.paused?'恢复服务器队列':'暂停服务器队列'}</button></div>}
  <p className="nc-muted nc-queue-note">已通过校验的任务关闭页面后继续处理。暂停仍占容量，已开始的阶段完成后停止领取后续阶段。</p>
  {!!local.length&&<div className="nc-local-upload-list"><h3>本机上传清单</h3>{local.map(manifest=>{const pending=manifest.items.filter(i=>i.state!=='accepted'),accepted=manifest.items.length-pending.length;return <article className="nc-upload-manifest" key={manifest.id}><div><b>{manifest.title}</b><p>{accepted} / {manifest.items.length} 页已有服务器回执 · {manifest.paused?'本机补充已暂停':manifest.pending&&!manifest.pending.submissionId?'正在核实提交':pending.some(i=>i.state==='uploading')?'正在上传原图':'等待空位补充'}</p>{manifest.error&&<p className="nc-attention" role="status">{manifest.error}</p>}</div><button className="button secondary small" disabled={!!busy} onClick={()=>void act(manifest.id,()=>onLocalPause(manifest.id,!manifest.paused))}>{manifest.paused?'继续补充':'暂停本机补充'}</button>{pending.some(i=>i.error)&&<details><summary>查看未完成图片</summary>{pending.filter(i=>i.error).map(item=><p key={item.id}>{item.image.name}：{item.error}</p>)}</details>}</article>;})}<p className="nc-muted">尚未上传的页保存在本机；请保持页面打开并保留原图。回到此账户后会继续恢复原请求。</p></div>}
  <div className="nc-queue-job-list">{!active.length?<div className="nc-queue-empty"><Icon name="check"/><p>当前没有待处理任务</p><small>在漫画中选择页段或预存本章；完成的译图会保留在账户中。</small></div>:active.slice(0,compact?8:100).map((job,n)=><article key={job.id} className="nc-queue-job"><span className={`nc-queue-priority ${job.priority==='realtime'?'realtime':''}`}>{job.priority==='realtime'?'实时':'预存'}</span><div><b>{job.page_index!=null?`第 ${job.page_index+1} 页`:`任务 ${n+1}`}</b><p>{taskText(job)}</p>{job.error&&<small className="nc-attention">{job.error.message}</small>}</div><div className="nc-inline"><button className="text-link" onClick={()=>onOpen(job)}>查看</button>{job.status!=='outcome_unknown'&&<button className="text-link" disabled={!!busy||job.cancel_requested} onClick={()=>void act(job.id,()=>onCancel(job))}>{job.cancel_requested?'正在停止':'停止'}</button>}</div></article>)}</div>
  {!compact&&active.length>100&&<p className="nc-muted">显示前 100 个活动任务，共 {active.length} 个。阅读时将自动调整本人顺序。</p>}
  </>}
 </section>;
}
