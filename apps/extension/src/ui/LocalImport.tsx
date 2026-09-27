import {useSyncExternalStore} from 'react';
import {msg} from '../i18n/runtime';
import {importSummary,type LocalImportQueue,type ImportStatus} from '../comics/application/import-queue';
import {Icon} from '../icons';
import {Modal} from './components';
import './local-import.css';
const labels:Record<ImportStatus,()=>string>={queued:()=>msg('等待导入'),importing:()=>msg('导入中'),created:()=>msg('已导入'),duplicate:()=>msg('已存在 · 跳过'),failed:()=>msg('需要处理'),cancelled:()=>msg('已取消')};
const statusIcons:Record<ImportStatus,string>={queued:'clock',importing:'folder',created:'check',duplicate:'book',failed:'info',cancelled:'close'};
const summaryStatuses:ImportStatus[]=['created','duplicate','failed','cancelled'];

export function LocalImport({queue,expanded,onExpand,onCollapse,onOpen,reading}:{
 reading?:boolean;queue:LocalImportQueue;expanded:boolean;onExpand:()=>void;onCollapse:()=>void;onOpen:(id:string)=>void;
}){
 const {items,running,phase,pauseRequested}=useSyncExternalStore(queue.subscribe,queue.getSnapshot);
 const counts:Record<ImportStatus,number>={queued:0,importing:0,created:0,duplicate:0,failed:0,cancelled:0};
 for(const item of items)counts[item.status]++;
 const failures=items.filter(item=>item.status==='failed'||item.status==='cancelled');
 const active=items.find(item=>item.status==='importing'),settled=items.length-counts.queued-counts.importing;
 const busy=running||phase==='paused';
 if(!items.length||reading&&!expanded&&!busy)return null;
 const title=running?msg('正在导入 · {0} / {1} 项',{'0':settled,'1':items.length}):phase==='paused'?msg('导入已暂停'):msg('导入结果');
 if(!expanded)return <aside className="nc-import-dock" aria-label={msg('本地导入进度')}>
  <button className="nc-import-dock-main" onClick={onExpand}>
   <span className="nc-import-dock-icon">{running?<span className="spinner"/>:<Icon name={failures.length?'info':'folder'}/>}</span>
   <span><strong>{title}</strong><small>{active?active.title+' · '+active.message:importSummary(items)}</small></span>
   <span className="text-link">{msg('展开')}</span>
  </button>
 </aside>;
 return <Modal title={title} onClose={onCollapse} closeLabel={msg('收起导入面板')} className="nc-local-import-modal">
  <div className="nc-local-import">
   <dl className="nc-import-summary nc-comic-paper">
    {summaryStatuses.filter(status=>status!=='cancelled'||counts.cancelled>0).map(status=><div key={status} data-status={status}>
     <dt><Icon name={statusIcons[status]} size={16}/>{labels[status]()}</dt><dd>{counts[status]}</dd>
    </div>)}
   </dl>
   {busy&&<div className="nc-import-progress">
    <div><span>{msg('批量导入总进度')}</span><strong>{settled} / {items.length}</strong></div>
    <progress aria-label={msg('批量导入总进度')} max={items.length} value={settled}/>
   </div>}
   <div className="nc-import-list-heading"><h3>{msg('导入文件清单')}</h3><span className="nc-comic-tag">{items.length}</span></div>
   <div className="nc-import-list" role="list" aria-label={msg('导入文件清单')}>
    {items.map(item=><article key={item.id} role="listitem" className={'nc-import-item '+item.status} data-status={item.status}>
     <span className="nc-import-item-icon">{item.status==='importing'?<span className="spinner"/>:<Icon name={statusIcons[item.status]}/>}</span>
     <div className="nc-import-item-body">
      <div className="nc-import-item-title"><strong>{item.title}</strong><span className="nc-status-badge">{labels[item.status]()}</span></div>
      <p role={item.status==='failed'?'alert':'status'}>{item.message}</p>
      {item.progress&&<progress aria-label={item.title} max={item.progress.total||1} value={item.progress.done}/>}
     </div>
     {item.entryId&&<button className="button secondary small nc-import-item-action" onClick={()=>{onCollapse();onOpen(item.entryId!);}}><Icon name="book" size={16}/>{msg('开始阅读')}</button>}
     {(item.status==='failed'||item.status==='cancelled')&&<button className="button secondary small nc-import-item-action" disabled={busy} onClick={()=>void queue.retry([item.id])}><Icon name="refresh" size={16}/>{msg('重试')}</button>}
    </article>)}
   </div>
  </div>
  <footer className="nc-import-footer">
   <button className="text-link" onClick={onCollapse}>{msg('收起，继续浏览')}</button>
   <div className="nc-import-footer-actions">{busy?<>
    <button className="button secondary small" disabled={!running} onClick={()=>queue.cancelCurrent()}>{msg('取消当前')}</button>
    <button className="button secondary small" onClick={()=>queue.stopRemaining()}>{msg('停止剩余')}</button>
    {running?<button className="button secondary small" disabled={pauseRequested} onClick={()=>queue.pause()}>{msg('完成当前后暂停')}</button>:<button className="button primary small" onClick={()=>void queue.resume()}>{msg('继续导入')}</button>}
   </>:<>
    {!!failures.length&&<button className="button secondary small" onClick={()=>void queue.retry(failures.map(item=>item.id))}><Icon name="refresh" size={16}/>{msg('重试失败项（{0}）',{'0':failures.length})}</button>}
    <button className="button primary small" onClick={()=>{queue.clear();onCollapse();}}><Icon name="check" size={16}/>{msg('完成')}</button>
   </>}</div>
  </footer>
 </Modal>;
}
