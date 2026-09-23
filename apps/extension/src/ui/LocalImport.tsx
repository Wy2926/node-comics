import {useSyncExternalStore} from 'react';
import {msg} from '../i18n/runtime';
import {LocalImportQueue,importSummary,type ImportStatus} from '../comics/application/import-queue';
import {Icon} from '../icons';
import {Modal} from './components';
import './local-import.css';
const labels:Record<ImportStatus,()=>string>={queued:()=>msg('等待导入'),importing:()=>msg('导入中'),created:()=>msg('已导入'),duplicate:()=>msg('已存在 · 跳过'),failed:()=>msg('需要处理'),cancelled:()=>msg('已取消')};
export function LocalImport({queue,expanded,onExpand,onCollapse,onAdd,onOpen,reading}:{reading?:boolean;queue:LocalImportQueue;expanded:boolean;onExpand:()=>void;onCollapse:()=>void;onAdd:()=>void;onOpen:(id:string)=>void}){
 const {items,running,phase,pauseRequested}=useSyncExternalStore(queue.subscribe,queue.getSnapshot);
 const failures=items.filter(i=>i.status==='failed'||i.status==='cancelled'),active=items.find(i=>i.status==='importing'),settled=items.filter(i=>!['queued','importing'].includes(i.status)).length;
 if(!items.length||reading&&!expanded&&!running&&phase!=='paused')return null;
 const title=running?msg('正在导入 · {0} / {1} 项',{'0':settled,'1':items.length}):phase==='paused'?msg('导入已暂停'):msg('导入结果');
 if(!expanded)return <aside className="nc-import-dock" aria-label={msg('本地导入进度')}><button className="nc-import-dock-main" onClick={onExpand}><span className="nc-import-dock-icon">{running?<span className="spinner"/>:<Icon name={failures.length?'info':'folder'}/>}</span><span><strong>{title}</strong><small>{active?active.title+' · '+active.message:importSummary(items)}</small></span><span className="text-link">{msg('展开')}</span></button></aside>;
 return <Modal title={title} onClose={onCollapse} closeLabel={msg('收起导入面板')} className="nc-local-import-modal"><div className="nc-local-import">
  <p>{msg('每个文件是一本漫画，选中后自动导入。')}</p><progress aria-label={msg('批量导入总进度')} max={items.length} value={settled}/>
  <div className="nc-import-list" aria-label={msg('导入文件清单')}>{items.map(item=><article key={item.id} className={'nc-import-item '+item.status}><div className="nc-import-item-title"><strong>{item.title}</strong><span className="nc-status-badge">{labels[item.status]()}</span></div><p role={item.status==='failed'?'alert':'status'}>{item.message}</p>{item.progress&&<progress max={item.progress.total||1} value={item.progress.done}/>}{item.entryId&&<button className="text-link" onClick={()=>{onCollapse();onOpen(item.entryId!);}}>{msg('开始阅读')}</button>}{['failed','cancelled'].includes(item.status)&&<button className="text-link" disabled={running||phase==='paused'} onClick={()=>void queue.retry([item.id])}>{msg('重试')}</button>}</article>)}</div>
  <footer className="nc-import-footer"><div>{running||phase==='paused'?<><button className="button secondary small" disabled={!running} onClick={()=>queue.cancelCurrent()}>{msg('取消当前')}</button><button className="button secondary small" onClick={()=>queue.stopRemaining()}>{msg('停止剩余')}</button>{running?<button className="button secondary small" disabled={pauseRequested} onClick={()=>queue.pause()}>{msg('完成当前后暂停')}</button>:<button className="button primary small" onClick={()=>void queue.resume()}>{msg('继续导入')}</button>}</>:<>{!!failures.length&&<button className="button secondary" onClick={()=>void queue.retry(failures.map(i=>i.id))}>{msg('重试失败项（{0}）',{'0':failures.length})}</button>}<button className="button secondary" onClick={onAdd}>{msg('添加文件')}</button><button className="button primary" onClick={()=>{queue.clear();onCollapse();}}>{msg('完成')}</button></>}<button className="text-link" onClick={onCollapse}>{msg('收起，继续浏览')}</button></div></footer>
 </div></Modal>;
}
