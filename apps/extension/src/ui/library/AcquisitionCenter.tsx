import {useState} from 'react';
import type {LibraryState} from '../../library/types';
import type {ReadingCopy} from '../../types';
import {grantImagePermissions,pauseCopies,queueCopies} from '../../library/acquisition';
import {inExtension} from '../../sources/client';
import {Thumbnail} from '../../reader/Images';
import {Modal} from '../components';
import {copyComplete,copyCover,savedPages,type LibraryRun} from './shared';

export function AcquisitionCenter({library:s,copies,initialWorkId,onlyIds,busy,feedback,run,onOpen,onSource,onClose}:{library:LibraryState;copies:ReadingCopy[];initialWorkId?:string;onlyIds?:string[];busy:string;feedback?:{tone:string;message:string};run:LibraryRun;onOpen:(id:string)=>void;onSource:(url:string)=>void;onClose:()=>void}){
 const [scope,setScope]=useState(initialWorkId??''),[filter,setFilter]=useState('all'),[restricted,setRestricted]=useState(!!onlyIds?.length);
 const extension=inExtension();
 const queuedMessage=(title:string,permission=false)=>extension?(permission?title+'图片权限已确认，已继续采集':title+'已加入采集队列'):title+'已加入队列，请在扩展中执行采集';
 const sourceCopies=copies.filter(c=>c.sourceEntryId&&(!scope||s.coverage.some(x=>x.copyId===c.id&&x.workId===scope))&&(!restricted||onlyIds?.includes(c.id)));
 const taskFor=(id:string)=>s.tasks.find(t=>t.copyId===id);
 const active=sourceCopies.filter(c=>['queued','running'].includes(taskFor(c.id)?.status??''));
 const pending=sourceCopies.filter(c=>!copyComplete(c)&&!['queued','running'].includes(taskFor(c.id)?.status??''));
 const complete=sourceCopies.filter(copyComplete);
 const visible=(filter==='active'?active:filter==='pending'?pending:filter==='complete'?complete:sourceCopies).sort((a,b)=>(taskFor(b.id)?.updatedAt??b.updatedAt)-(taskFor(a.id)?.updatedAt??a.updatedAt));
 const catalogs=s.catalogs.filter(c=>!scope||c.workId===scope);
 return <Modal title="采集中心" subtitle="统一查看原图进度、补齐缺页和恢复采集。已保存的页面可以随时阅读。" onClose={onClose}>
  <div className="nc-acquisition-center">
   {feedback&&<div className={'nc-action-feedback '+feedback.tone} role={feedback.tone==='error'?'alert':'status'}>{feedback.tone==='busy'&&<span className="spinner"/>}{feedback.message}</div>}
   <div className="nc-library-tools"><label className="nc-sort-label">范围<select aria-label="采集作品范围" value={scope} onChange={e=>{setScope(e.target.value);setRestricted(false);}}><option value="">全部作品</option>{s.works.map(w=><option value={w.id} key={w.id}>{w.title}</option>)}</select></label>{restricted&&<button className="text-link" onClick={()=>setRestricted(false)}>已限定所选 {onlyIds?.length} 份 · 查看全部</button>}</div>
   <div className="nc-filter-chips" aria-label="采集状态筛选">{[['all','全部',sourceCopies.length],['active','进行中',active.length],['pending','待处理',pending.length],['complete','已完成',complete.length]].map(([key,label,count])=><button key={key} aria-pressed={filter===key} onClick={()=>setFilter(String(key))}>{label}<span>{count}</span></button>)}</div>
   <div className="nc-acquisition-toolbar"><span className="nc-muted">{extension?'保持插件页面打开以执行采集。':'当前是网页预览，仅保存队列；请在扩展中执行采集。'}</span><div className="nc-inline"><button className="button secondary small" disabled={!!busy||!active.length} onClick={()=>void run('pause-all','正在暂停采集',()=>pauseCopies(active.map(c=>c.id)),`已暂停 ${active.length} 份采集`) }>暂停全部</button><button className="button primary small" disabled={!!busy||!pending.length} onClick={()=>void run('queue-all','正在加入采集队列',()=>queueCopies(pending.map(c=>c.id)),queuedMessage(`${pending.length} 份副本`)) }>{busy==='queue-all'?'加入中…':'补齐待处理'}</button></div></div>
   <div className="nc-capture-grid">{visible.map(copy=>{
    const task=taskFor(copy.id),isActive=task?.status==='running'||task?.status==='queued',isComplete=copyComplete(copy),needsPermission=!!task?.error&&/授权|权限|permission/i.test(task.error);
    const total=task?.total??copy.knownTotal??(copy.discoveryComplete?copy.pages.length:undefined),completed=task?.phase==='discover'&&!copy.discoveryComplete?task.completed:savedPages(copy);
    const status=isComplete?'采集完成':task?.status==='running'?(task.phase==='discover'?'正在读取完整图片清单':'正在下载原图'):task?.status==='queued'?'等待采集':needsPermission?'等待图片授权':task?.status==='paused'?'已暂停':task?.status==='failed'?'需要处理':'等待采集';
    return <article className={'nc-capture-card '+(task?.status==='failed'?'has-error':'')} key={copy.id} aria-busy={busy.endsWith(copy.id)}>
     <div className="nc-capture-heading"><Thumbnail blobKey={copyCover(copy)?.blobKey} alt={copy.title}/><div><span className={'nc-status-badge '+(isComplete?'complete':isActive?'active':task?.status==='failed'?'failed':'')}>{isActive&&<span className="nc-pulse-dot"/>}{status}</span><h3>{copy.title}</h3><p>{copy.source} · 修订 {copy.manifestRevision}</p></div></div>
     <div className="nc-capture-progress"><span>{task?.phase==='discover'&&!copy.discoveryComplete?'已发现图片':'已保存原图'}</span><b>{completed} / {total??'待确认'}</b></div>
     <progress aria-label={copy.title+'采集进度'} value={total?Math.min(completed,total):undefined} max={total||1}/>
     {task?.error&&!isComplete&&<p className="nc-capture-error">{task.error}</p>}
     <div className="nc-card-actions">{isComplete?<span className="nc-muted">原图已完整保存</span>:isActive?<button className="button secondary small" disabled={!!busy} onClick={()=>void run('pause:'+copy.id,'正在暂停 '+copy.title,()=>pauseCopies([copy.id]),copy.title+'已暂停，已保存进度保留')}>{busy==='pause:'+copy.id?'暂停中…':'暂停'}</button>:<button className="button primary small" disabled={!!busy} onClick={()=>void run('queue:'+copy.id,needsPermission&&extension?'正在请求图片授权':'正在加入采集队列',()=>needsPermission?grantImagePermissions([copy.id],copies):queueCopies([copy.id]),queuedMessage(copy.title,needsPermission))}>{busy==='queue:'+copy.id?'处理中…':needsPermission?'授权并继续':task?.status==='paused'?'继续采集':task?.status==='failed'?'重试缺失页':'下载／补齐'}</button>}<button className="button plain small" disabled={!savedPages(copy)} onClick={()=>{onClose();onOpen(copy.id);}}>阅读已有页</button></div>
    </article>;
   })}</div>
   {!visible.length&&<div className="nc-empty nc-compact-empty"><h3>{sourceCopies.length?'此状态暂无采集':'还没有来源副本'}</h3><p>{sourceCopies.length?'切换上方筛选查看其他采集。':'从来源目录导入内容后，原图采集会统一显示在这里。'}</p></div>}
   {!!catalogs.length&&<details className="nc-catalog-disclosure"><summary>来源目录 · {catalogs.length}<span>检查更新与导入范围</span></summary><div className="nc-catalog-grid">{catalogs.map(catalog=><article className="nc-catalog-card" key={catalog.id}><span className="nc-eyebrow">{catalog.sourceId}</span><h3>{catalog.title}</h3><p>{catalog.entries.length} 个已知条目</p><button className="button secondary small" disabled={!!busy} onClick={()=>{onClose();onSource(catalog.url);}}>检查目录更新</button></article>)}</div></details>}
  </div>
 </Modal>;
}
