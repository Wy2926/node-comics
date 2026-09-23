import {msg} from '../i18n/runtime';
import {useEffect,useState} from 'react';
import {downloadItems,grantDownloads,pauseDownloads,deleteDownloads,subscribeDownloads} from '../comics/application/download-service';
import {Modal} from './components';
export function DownloadManagement({notify,onOpen}:{notify:(message:string)=>void;onOpen:(id:string)=>void}){
 const [tasks,setTasks]=useState<Awaited<ReturnType<typeof downloadItems>>>([]),[remove,setRemove]=useState<string>(),[expanded,setExpanded]=useState(false);
 const [failure,setFailure]=useState('');
 useEffect(()=>{let alive=true,timer:ReturnType<typeof setTimeout>;const reload=()=>{clearTimeout(timer);timer=setTimeout(()=>void downloadItems().then(values=>{if(alive){setTasks(values);setFailure('');}}).catch(error=>{if(alive)setFailure((error as Error).message);}),100);};reload();const unsubscribe=subscribeDownloads(reload);return()=>{alive=false;clearTimeout(timer);unsubscribe();};},[]);
 if(failure)return <p className="global-error" role="alert">{failure}</p>;
 if(!tasks.length)return null;
 const labels={queued:msg("等待下载"),running:msg("正在下载"),paused:msg("已暂停"),failed:msg("部分失败"),complete:msg("下载完成")};
 return <section className="settings-card"><div className="nc-section-heading"><h2>{msg("网站下载资料")}</h2><button className="text-link" onClick={()=>setExpanded(v=>!v)}>{expanded?msg("收起"):msg("管理下载")} · {tasks.length}</button></div>{expanded&&tasks.slice(0,100).map(task=><div className="setting-row" key={task.id}><div><b>{task.title}</b><p>{labels[task.status]} · {task.completed} / {task.total??'?'} {msg("页")}</p>{task.error&&<p role="status">{task.error}</p>}</div><div className="nc-inline"><button className="text-link" onClick={()=>onOpen(task.documentId)}>{msg("阅读")}</button>{['running','queued'].includes(task.status)?<button className="button secondary small" onClick={()=>void pauseDownloads([task.documentId]).catch(e=>notify(e.message))}>{msg("暂停")}</button>:task.status!=='complete'?<button className="button secondary small" onClick={()=>void grantDownloads([task.documentId],task.origins).catch(e=>notify(e.message))}>{msg("授权并继续")}</button>:null}<button className="text-link" onClick={()=>setRemove(task.documentId)}>{msg("删除下载资料")}</button></div></div>)}{remove&&<Modal title={msg("删除已下载的原图？")} subtitle={msg("保留书架来源、阅读位置和译图。以后阅读时按需从网站获取。")} onClose={()=>setRemove(undefined)}><button className="button danger" onClick={()=>{const id=remove;setRemove(undefined);void deleteDownloads(id).catch(e=>notify(e.message));}}>{msg("确认删除下载资料")}</button></Modal>}</section>;
}
