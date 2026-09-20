import {Select} from '../Select';
import {msg,messageSource} from '../../i18n/runtime';
import {useState} from 'react';
import type {LibraryState} from '../../library/types';
import type {ReadingCopy} from '../../types';
import {grantImagePermissions,pauseCopies} from '../../library/acquisition';
import {acquisitionCopies} from '../../library/acquisition-order';
import {copyPageTotal} from '../../library/model';
import {inExtension} from '../../sources/client';
import {Thumbnail} from '../../reader/Images';
import {Modal} from '../components';
import {copyComplete,copyCover,savedPages,type LibraryRun} from './shared';
import {useImagePermissions} from '../useImagePermissions';
import {copyOrigins} from '../../sources/permissions';

export function AcquisitionCenter({library:s,copies,initialWorkId,onlyIds,busy,feedback,run,onOpen,onSource,onClose}:{library:LibraryState;copies:ReadingCopy[];initialWorkId?:string;onlyIds?:string[];busy:string;feedback?:{tone:string;message:string};run:LibraryRun;onOpen:(id:string)=>void;onSource:(url:string)=>void;onClose:()=>void}){
 const [scope,setScope]=useState(initialWorkId??''),[filter,setFilter]=useState('all'),[restricted,setRestricted]=useState(!!onlyIds?.length);
 const extension=inExtension();
 const queuedMessage=(title:string,permission=false)=>extension?(permission?msg("{0}图片权限已确认，已继续采集", {"0": title}):msg("{0}已加入采集队列", {"0": title})):msg("{0}已加入队列，请在扩展中执行采集", {"0": title});
 const sourceCopies=acquisitionCopies(s,copies).filter(c=>(!scope||s.coverage.some(x=>x.copyId===c.id&&x.workId===scope))&&(!restricted||onlyIds?.includes(c.id)));
 const taskFor=(id:string)=>s.tasks.find(t=>t.copyId===id);
 const active=sourceCopies.filter(c=>['queued','running'].includes(taskFor(c.id)?.status??''));
 const pending=sourceCopies.filter(c=>!copyComplete(c)&&!['queued','running'].includes(taskFor(c.id)?.status??''));
 const complete=sourceCopies.filter(copyComplete);
 const visible=filter==='active'?active:filter==='pending'?pending:filter==='complete'?complete:sourceCopies;
 const catalogs=s.catalogs.filter(c=>!scope||c.workId===scope);
 const permissions=useImagePermissions(catalogs.flatMap(catalog=>{
  const relevant=pending.filter(c=>catalog.entries.some(e=>e.id===c.sourceEntryId));
  return relevant.length&&!relevant.some(c=>c.pages.some(p=>p.sourceUrl))?[{catalog,entryId:relevant[0].sourceEntryId!}]:[];
 }));
 const permissionBusy=permissions.preparing||!!permissions.error;
 const grant=(ids:string[])=>{
  const selected=copies.filter(c=>ids.includes(c.id));
  const related=s.catalogs.filter(catalog=>selected.some(c=>catalog.entries.some(e=>e.id===c.sourceEntryId)));
  const known=copies.filter(c=>related.some(catalog=>catalog.entries.some(e=>e.id===c.sourceEntryId)));
  return grantImagePermissions(ids,copies,[...permissions.origins,...copyOrigins(known)]);
 };
 return <Modal title={msg("采集中心")} subtitle={msg("按来源目录顺序逐章、逐页采集。已保存的页面可以随时阅读。")} onClose={onClose}>
  <div className="nc-acquisition-center">
   {feedback&&<div className={'nc-action-feedback '+feedback.tone} role={feedback.tone==='error'?'alert':'status'}>{feedback.tone==='busy'&&<span className="spinner"/>}{feedback.message}</div>}
   {permissions.preparing&&<p role="status">{msg("正在提前读取图片域名，完成后即可授权并开始采集…")}</p>}
   {permissions.error&&<p role="alert">{permissions.error} <button className="text-link" onClick={permissions.retry}>{msg("重新检查图片域名")}</button></p>}
   <div className="nc-library-tools"><label className="nc-sort-label">{msg("范围")}<Select aria-label={msg("采集作品范围")} value={scope} onChange={e=>{setScope(e.target.value);setRestricted(false);}}><option value="">{msg("全部作品")}</option>{s.works.map(w=><option value={w.id} key={w.id}>{w.title}</option>)}</Select></label>{restricted&&<button className="text-link" onClick={()=>setRestricted(false)}>{msg("已限定所选 {0} 份 · 查看全部", {"0": onlyIds?.length})}</button>}</div>
   <div className="nc-filter-chips" aria-label={msg("采集状态筛选")}>{[['all',msg("全部"),sourceCopies.length],['active',msg("进行中"),active.length],['pending',msg("待处理"),pending.length],['complete',msg("已完成"),complete.length]].map(([key,label,count])=><button key={key} aria-pressed={filter===key} onClick={()=>setFilter(String(key))}>{label}<span>{count}</span></button>)}</div>
   <div className="nc-acquisition-toolbar"><span className="nc-muted">{extension?msg("开始前授权图片域名；发现链接后立即逐页下载。"):msg("当前是网页预览，仅保存队列；请在扩展中执行采集。")}</span><div className="nc-inline"><button className="button secondary small" disabled={!!busy||!active.length} onClick={()=>void run('pause-all',msg("正在暂停采集"),()=>pauseCopies(active.map(c=>c.id)),msg("已暂停 {0} 份采集", {"0": active.length})) }>{msg("暂停全部")}</button><button className="button primary small" disabled={!!busy||permissionBusy||!pending.length} onClick={()=>void run('queue-all',msg("正在确认图片权限"),()=>grant(pending.map(c=>c.id)),queuedMessage(msg("{0} 份副本", {"0": pending.length}))) }>{busy==='queue-all'?msg("加入中…"):msg("补齐待处理")}</button></div></div>
   <div className="nc-capture-grid">{visible.map(copy=>{
    const task=taskFor(copy.id),isActive=task?.status==='running'||task?.status==='queued',isComplete=copyComplete(copy),needsPermission=!!task?.error&&/授权|权限|permission/i.test(messageSource(task.error));
    const total=task?.total??copyPageTotal(copy),completed=task?.phase==='discover'&&!copy.discoveryComplete?task.completed:savedPages(copy);
    const status=isComplete?msg("采集完成"):task?.status==='running'?(task.phase==='discover'?msg("正在读取完整图片清单"):msg("正在下载原图")):task?.status==='queued'?msg("等待采集"):needsPermission?msg("等待图片授权"):task?.status==='paused'?msg("已暂停"):task?.status==='failed'?msg("需要处理"):msg("等待采集");
    return <article className={'nc-capture-card '+(task?.status==='failed'?'has-error':'')} key={copy.id} aria-busy={busy.endsWith(copy.id)}>
     <div className="nc-capture-heading"><Thumbnail blobKey={copyCover(copy)?.blobKey} alt={copy.title}/><div><span className={'nc-status-badge '+(isComplete?'complete':isActive?'active':task?.status==='failed'?'failed':'')}>{isActive&&<span className="nc-pulse-dot"/>}{status}</span><h3>{copy.title}</h3><p>{msg("{0} · 修订 {1}", {"0": copy.source, "1": copy.manifestRevision})}</p></div></div>
     <div className="nc-capture-progress"><span>{task?.phase==='discover'&&!copy.discoveryComplete?msg("已发现图片"):msg("已保存原图")}</span><b>{completed} / {total??msg("待确认")}</b></div>
     <progress aria-label={msg("{0}采集进度", {"0": copy.title})} value={total?Math.min(completed,total):undefined} max={total||1}/>
     {task?.error&&!isComplete&&<p className="nc-capture-error">{task.error}</p>}
     <div className="nc-card-actions">{isComplete?<span className="nc-muted">{msg("原图已完整保存")}</span>:isActive?<button className="button secondary small" disabled={!!busy} onClick={()=>void run('pause:'+copy.id,msg("正在暂停 {0}", {"0": copy.title}),()=>pauseCopies([copy.id]),msg("{0}已暂停，已保存进度保留", {"0": copy.title}))}>{busy==='pause:'+copy.id?msg("暂停中…"):msg("暂停")}</button>:<button className="button primary small" disabled={!!busy||permissionBusy} onClick={()=>void run('queue:'+copy.id,msg("正在确认图片权限"),()=>grant([copy.id]),queuedMessage(copy.title,needsPermission))}>{busy==='queue:'+copy.id?msg("处理中…"):needsPermission?msg("授权并继续"):task?.status==='paused'?msg("继续采集"):task?.status==='failed'?msg("重试缺失页"):msg("下载／补齐")}</button>}<button className="button plain small" disabled={!savedPages(copy)} onClick={()=>{onClose();onOpen(copy.id);}}>{msg("阅读已有页")}</button></div>
    </article>;
   })}</div>
   {!visible.length&&<div className="nc-empty nc-compact-empty"><h3>{sourceCopies.length?msg("此状态暂无采集"):msg("还没有来源副本")}</h3><p>{sourceCopies.length?msg("切换上方筛选查看其他采集。"):msg("从来源目录导入内容后，原图采集会统一显示在这里。")}</p></div>}
   {!!catalogs.length&&<details className="nc-catalog-disclosure"><summary>{msg("来源目录 · {0}", {"0": catalogs.length})}<span>{msg("检查更新与导入范围")}</span></summary><div className="nc-catalog-grid">{catalogs.map(catalog=><article className="nc-catalog-card" key={catalog.id}><span className="nc-eyebrow">{catalog.sourceId}</span><h3>{catalog.title}</h3><p>{msg("{0} 个已知条目", {"0": catalog.entries.length})}</p><button className="button secondary small" disabled={!!busy} onClick={()=>{onClose();onSource(catalog.url);}}>{msg("检查目录更新")}</button></article>)}</div></details>}
  </div>
 </Modal>;
}
