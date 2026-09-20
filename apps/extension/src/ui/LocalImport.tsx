import {msg} from '../i18n/runtime';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {LocalImportQueue,importSummary,selectableImport,type ImportStatus} from '../library/import-queue';
import type {ImportAssignment,LibraryState} from '../library/types';
import {Icon} from '../icons';
import {Modal} from './components';
import {ImportAssignmentFields} from './ImportAssignment';
import './local-import.css';

const labels:Record<ImportStatus,string>={get checking(){return msg("检查重复中");},get ready(){return msg("待导入");},get restore(){return msg("待补齐原图");},get duplicate(){return msg("已存在 · 跳过");},get queued(){return msg("等待导入");},get importing(){return msg("导入中");},get created(){return msg("已导入");},get restored(){return msg("已补齐原图");},get failed(){return msg("需要处理");},get cancelled(){return msg("已取消");}};
const size=(bytes:number)=>bytes<1024*1024?`${Math.max(1,Math.ceil(bytes/1024))} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
interface Props {queue:LocalImportQueue;expanded:boolean;onExpand:()=>void;onCollapse:()=>void;onAdd:()=>void;onOpen:(id:string)=>void;library:LibraryState;limitMb:number;}
export function LocalImport({queue,expanded,onExpand,onCollapse,onAdd,onOpen,library,limitMb}:Props){
 const state=useSyncExternalStore(queue.subscribe,queue.getSnapshot),{items,checking,running,phase,pauseRequested}=state;
 const [assignment,setAssignment]=useState<ImportAssignment>(),[separate,setSeparate]=useState(false),[filter,setFilter]=useState('all');
 useEffect(()=>{if(!items.length){setAssignment(undefined);setSeparate(false);setFilter('all');}},[items.length]);
 const firstTitle=items.find(item=>item.status!=='duplicate')?.title??items[0]?.title??'';
 const value:ImportAssignment=assignment??{title:firstTitle.replace(/\.[^.]+$/,''),kind:'unclassified'};
 const available=items.filter(selectableImport),selected=available.filter(item=>item.selected),failures=items.filter(item=>item.status==='failed');
 const duplicates=items.filter(item=>item.status==='duplicate');
 const locked=running||phase==='paused',active=items.find(item=>item.status==='importing'||item.status==='checking');
 const queued=items.filter(item=>item.status==='queued');
 const settled=items.filter(item=>['created','restored','duplicate','failed','cancelled'].includes(item.status));
 const total=settled.length+queued.length+(items.some(item=>item.status==='importing')?1:0);
 const summary=importSummary(items),valid=separate||!!value.workId||!!value.title.trim();
 const list=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const container=list.current;if(!container)return;
  if(!checking&&phase==='review'){container.scrollTop=0;return;}
  const row=active&&container.querySelector<HTMLElement>(`[data-import-id="${active.id}"]`);
  if(row)container.scrollTop+=row.getBoundingClientRect().top-container.getBoundingClientRect().top;
 },[active?.id,phase,checking,expanded]);
 const retry=(ids:string[])=>{setFilter('all');void queue.retry(ids,value,limitMb,separate);};
 if(!items.length)return null;
 if(!expanded)return <aside className="nc-import-dock" aria-label={msg("本地导入进度")}>
  <button className="nc-import-dock-main" onClick={onExpand}><span className="nc-import-dock-icon">{running||checking?<span className="spinner"/>:<Icon name={failures.length?'info':'folder'}/>}</span><span><strong>{running?msg("正在导入 · {0} / {1} 项", {"0": settled.length, "1": total}):checking?msg("正在检查文件"):phase==='paused'?msg("导入已暂停"):phase==='done'?msg("导入结果"):msg("待确认导入")}</strong><small>{active?`${active.title} · ${active.message}`:summary}</small></span><span className="text-link">{msg("展开")}</span></button>
  {running&&<progress aria-label={msg("批量导入总进度")} max={Math.max(1,total)} value={settled.length}/>}
 </aside>;
 const visible=items.filter(item=>filter==='all'||filter==='pending'&&['ready','restore','checking','queued','importing'].includes(item.status)||filter==='duplicate'&&item.status==='duplicate'||filter==='failed'&&item.status==='failed');
 return <Modal title={msg("导入本地漫画")} subtitle={msg("先检查重复，再逐份加入书架。多张图片按文件名顺序组成一份漫画。")} onClose={onCollapse} closeLabel={msg("收起导入面板")} className="nc-local-import-modal">
  <div className="nc-local-import">
   <ol className="nc-import-steps" aria-label={msg("导入步骤")}>{[msg("选择与检查"),msg("逐份导入"),msg("查看结果")].map((label,index)=><li key={label} aria-current={(phase==='review'?0:locked?1:2)===index?'step':undefined}><span>{index+1}</span>{label}</li>)}</ol>
   <section className="nc-import-overview" aria-label={msg("导入概况")}>
    <div className="nc-import-overview-title"><strong>{checking?msg("正在检查文件内容"):running?(pauseRequested?msg("当前文件完成后暂停"):msg("正在逐份导入")):phase==='paused'?msg("已暂停，随时可以继续"):phase==='done'?(failures.length?msg("导入已结束，部分文件需要处理"):msg("本次导入已完成")):!selected.length&&duplicates.length===items.length?msg("所选漫画均已在书架中"):msg("已选择 {0} / {1} 份待导入漫画", {"0": selected.length, "1": available.length})}</strong><span>{msg("{0} 项 · {1}", {"0": items.length, "1": size(items.reduce((sum,item)=>sum+item.bytes,0))})}</span></div>
    {(running||phase==='paused'||phase==='done')&&<progress aria-label={msg("批量导入总进度")} max={Math.max(1,total)} value={settled.length}/>}
    <p role="status" aria-live="polite">{checking?msg("只读取本机文件以核对内容；检测到重复会立即标出。"):locked?msg("{0} / {1} 项已处理 · {2} 项等待导入", {"0": settled.length, "1": total, "2": queued.length}):summary}</p>
    {active&&<p className="nc-import-current" role="status">{active.title} · {active.message}</p>}
    {locked&&<small>{msg("可以收起面板继续浏览。请保持当前页面打开；暂停或停止会在当前文件完成后生效。")}</small>}
   </section>
   <div className="nc-import-toolbar"><div className="nc-filter-chips" aria-label={msg("导入状态筛选")}>{[['all',msg("全部"),items.length],['pending',msg("待处理"),items.length-settled.length],['duplicate',msg("已存在"),duplicates.length],['failed',msg("失败"),failures.length]].map(([key,label,count])=><button key={key} aria-pressed={filter===key} onClick={()=>setFilter(String(key))}>{label}<span>{count}</span></button>)}</div><button className="button secondary small" disabled={locked||checking} onClick={onAdd}><Icon name="plus" size={16}/>{msg("添加文件")}</button></div>
   {!!available.length&&!locked&&<label className="nc-import-select-all"><input type="checkbox" aria-label={msg("全选待导入漫画")} checked={available.length===selected.length} disabled={checking} onChange={e=>queue.selectAll(e.target.checked)}/>{msg("全选待导入项")}<span>{msg("已存在的漫画自动跳过")}</span></label>}
   <div className="nc-import-list" aria-label={msg("导入文件清单")} ref={list}>
    {visible.map(item=>{const same=items.find(other=>other.id!==item.id&&!!item.key&&other.key===item.key);const canSelect=selectableImport(item)&&!locked;
     return <article key={item.id} data-import-id={item.id} className={'nc-import-item '+item.status} aria-label={item.title}>
      <div className="nc-import-item-main">
       {canSelect?<input type="checkbox" aria-label={msg("导入 {0}", {"0": item.title})} checked={item.selected} disabled={checking} onChange={e=>queue.select(item.id,e.target.checked)}/>:<span className="nc-import-item-icon">{['checking','importing'].includes(item.status)?<span className="spinner"/>:<Icon name={['created','restored','duplicate'].includes(item.status)?'check':item.status==='failed'?'info':'file'} size={18}/>}</span>}
       <div className="nc-import-item-body"><div className="nc-import-item-title"><strong>{item.files.length>1?msg("{0} 等 {1} 张图片", {"0": item.title, "1": item.files.length}):item.title}</strong><span className={'nc-status-badge '+(['created','restored','duplicate'].includes(item.status)?'complete':item.status==='failed'?'failed':item.status==='importing'?'active':'')}>{labels[item.status]}</span></div><p className="nc-import-item-message" role={item.status==='failed'?'alert':undefined}>{item.message}</p>
        {same&&selectableImport(item)&&<p className="nc-import-same">{msg("与清单中的《{0}》内容相同，成功导入一份后其余自动跳过。", {"0": same.title})}</p>}
        {item.progress&&<progress aria-label={msg("{0}的处理进度", {"0": item.title})} max={item.progress.total||1} value={item.progress.done}/>}
        <div className="nc-import-item-meta"><small>{size(item.bytes)}{item.files.length>1?msg(" · {0} 页图片", {"0": item.files.length}):' · '+item.files[0].name.split('.').at(-1)?.toUpperCase()}</small>
         <div className="nc-import-item-actions">{item.copyId&&['duplicate','created','restored'].includes(item.status)&&<button className="text-link" onClick={()=>{onCollapse();onOpen(item.copyId!);}}>{item.status==='duplicate'?msg("打开已有漫画"):msg("开始阅读")}</button>}
          {['failed','cancelled'].includes(item.status)&&<button className="text-link" disabled={locked||checking||!valid} onClick={()=>retry([item.id])}>{msg("重试")}</button>}
          {item.status!=='importing'&&<button className="text-link" aria-label={msg("从导入清单移除 {0}", {"0": item.title})} onClick={()=>queue.remove(item.id)}>{msg("移除")}</button>}</div></div>
        {item.files.length>1&&<details className="nc-import-files"><summary>{msg("查看图片顺序")}</summary><ol>{item.files.map((file,index)=><li key={index}>{file.name}</li>)}</ol></details>}
       </div>
      </div>
     </article>;
    })}
    {!visible.length&&<p className="nc-import-empty">{msg("此分类没有文件。")}</p>}
   </div>
   {!locked&&!!available.length&&<fieldset className="nc-import-assignment" disabled={checking}><legend>{msg("导入归属")}</legend>
    {items.length>1&&<label className="nc-import-separate"><input type="checkbox" checked={separate} onChange={e=>setSeparate(e.target.checked)}/>{msg("每份文件分别新建作品")}<small>{msg("作品名使用文件名")}</small></label>}
    {separate?<p className="nc-muted">{msg("每个漫画文件独立归档；同次选择的多张图片组成一份作品。内容归属为待整理材料。")}</p>:<ImportAssignmentFields value={value} onChange={setAssignment} library={library}/>}
   </fieldset>}
   <footer className="nc-import-footer"><span>{locked?msg("已完成的漫画可以随时阅读"):msg("文件与原图保存在当前设备")}</span><div>
    {locked?<><button className="button secondary small" onClick={()=>queue.stopRemaining()} disabled={!queued.length}>{msg("停止剩余")}</button>{running?<button className="button secondary small" onClick={()=>queue.pause()} disabled={pauseRequested||!queued.length}>{pauseRequested?msg("等待暂停…"):msg("完成当前后暂停")}</button>:<button className="button primary small" onClick={()=>void queue.resume()}>{msg("继续导入")}</button>}<button className="button primary small" onClick={onCollapse}>{msg("收起，继续浏览")}</button></>:<>
     {phase==='done'&&!!failures.length&&<button className="button secondary small" disabled={checking||!valid} onClick={()=>retry(failures.map(item=>item.id))}>{msg("重试失败项（{0}）", {"0": failures.length})}</button>}
     {!!available.length?<button className="button primary" disabled={checking||!selected.length||!valid} onClick={()=>{setFilter('all');void queue.start(separate?{title:value.title,kind:'unclassified'}:value,limitMb,separate);}}>{phase==='done'?msg("导入其余所选"):msg("开始导入")}{selected.length?`（${selected.length}）`:''}</button>:<button className="button primary" disabled={checking} onClick={()=>{queue.clear();onCollapse();}}>{msg("完成")}</button>}
    </>}
   </div></footer>
  </div>
 </Modal>;
}
