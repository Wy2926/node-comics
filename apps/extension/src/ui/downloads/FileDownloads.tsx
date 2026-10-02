import {useEffect,useState} from 'react';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {Modal} from '../components';
import {Thumbnail} from '../../reader/Images';
import {coverReference} from '../../comics/application/library-service';
import {clearRemoteFileDownload,pauseRemoteFileDownload,resumeRemoteFileDownload,type FileDownloadView} from '../../comics/acquisition/files';
import type {BookDownloadsController} from './useBookDownloads';

export function FileDownloadRows({controller,onRead}:{controller:BookDownloadsController;onRead:(comicId:string)=>void}){
  if(!controller.files.length)return null;
  return <section aria-label={msg('完整文件下载')}><h2>{msg('完整文件下载')}</h2><div className="nc-download-books">{controller.files.map(file=><FileRow key={file.intent.id} file={file} onRead={onRead} onChanged={controller.refresh}/>)}</div></section>;
}
function FileRow({file,onRead,onChanged}:{file:FileDownloadView;onRead:(comicId:string)=>void;onChanged:()=>void}){
  const {intent,comic}=file,[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [confirmation,setConfirmation]=useState<'resume'|'clear'>();
  const running=intent.status==='running'||intent.status==='queued',complete=intent.status==='complete';
  const label=complete?msg('已缓存'):intent.status==='queued'?msg('等待缓存'):intent.status==='running'?msg('正在保存完整文件'):intent.status==='clearing'?msg('正在清理离线内容…'):intent.status==='failed'?msg('需要处理'):msg('已暂停');
  async function act(action:()=>Promise<unknown>){if(busy)return;setBusy(true);setError('');try{await action();setConfirmation(undefined);onChanged();}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  return <><article className="nc-download-book" data-file-download-id={intent.id}>
    <button className="nc-download-cover" disabled={!comic} onClick={()=>{if(comic)onRead(comic.id);}} aria-label={msg('打开漫画 {0}',{'0':intent.title})}>{comic?<Thumbnail blobKey={coverReference(comic)} alt=""/>:<Icon name="book" size={40}/>}</button>
    <div className="nc-download-info"><div className="nc-download-title"><h2>{comic?<button onClick={()=>onRead(comic.id)}>{intent.title}</button>:intent.title}</h2><span className="nc-download-status" data-state={intent.status} data-tone={complete?'complete':running?'active':'attention'}>{label}</span></div>
      <p className="nc-muted">{complete?msg('下载完成，可开始阅读'):msg('已保存 {0} MB',{'0':(intent.bytes/1024**2).toFixed(1)})}{intent.totalBytes!==undefined&&!complete&&' / '+(intent.totalBytes/1024**2).toFixed(1)+' MB'}</p>
      {running&&<div className="nc-download-progress">{intent.totalBytes?<progress aria-label={msg('完整文件下载')} max={intent.totalBytes} value={intent.bytes}/>:<progress aria-label={msg('完整文件下载')}/>}</div>}
      {(intent.error||error)&&<p className="nc-download-feedback" role="alert">{error||intent.error}</p>}
      {intent.retryAt!==undefined&&intent.retryAt>Date.now()&&<p className="nc-muted">{msg('来源暂时限制请求，请在 {0} 后继续。',{'0':new Date(intent.retryAt).toLocaleTimeString()})}</p>}
    </div>
    <div className="nc-download-actions"><div className="nc-download-controls">
      {complete&&comic?<button className="button primary small" onClick={()=>onRead(comic.id)}>{msg('开始阅读')}</button>:running?<button className="button secondary small" disabled={busy} onClick={()=>void act(()=>pauseRemoteFileDownload(intent.id,intent.generation))}>{msg('暂停缓存')}</button>:intent.status!=='clearing'&&<button className="button primary small" disabled={busy} onClick={()=>setConfirmation('resume')}>{msg('重新下载')}</button>}
      <button className="button secondary small" disabled={busy} onClick={()=>setConfirmation('clear')}>{complete?msg('清除离线内容'):msg('取消缓存')}</button>
    </div><div className="nc-download-size"><span>{msg('离线占用')}</span><strong>{((complete?intent.totalBytes??intent.bytes:intent.bytes)/1024**2).toFixed(1)} MB</strong></div></div>
  </article>{confirmation&&<Modal title={confirmation==='resume'?msg('重新下载'):msg('清除离线内容')} onClose={()=>{if(!busy)setConfirmation(undefined);}}><p>{confirmation==='resume'?msg('中断的文件需要从头下载。继续吗？'):msg('清除《{0}》的完整离线文件？漫画与阅读记录保留，再次阅读可能需要重新下载。',{'0':intent.title})}</p>{error&&<p role="alert">{error}</p>}<div className="nc-inline"><button className={'button '+(confirmation==='resume'?'primary':'danger')} disabled={busy} onClick={()=>void act(()=>confirmation==='resume'?resumeRemoteFileDownload(intent.id,intent.generation):clearRemoteFileDownload(intent.id,intent.generation))}>{confirmation==='resume'?msg('重新下载'):msg('清除离线内容')}</button><button className="button secondary" disabled={busy} onClick={()=>setConfirmation(undefined)}>{msg('取消')}</button></div></Modal>}</>;
}
export function FileDownloadPrompt({controller}:{controller:BookDownloadsController}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setError('');},[controller.filePrompt]);
  const request=controller.filePrompt;if(!request)return null;
  return <Modal title={msg('下载后阅读')} onClose={()=>{if(!busy)controller.closeFilePrompt();}}><p>{request.plan.publication.title}</p><p>{msg('此书需要先保存完整文件。下载期间请保持插件页打开；中断后需重新下载，已完成的文件可离线阅读。')}</p>{request.plan.size!==undefined&&<p>{msg('文件大小约 {0} MB',{'0':(request.plan.size/1024**2).toFixed(1)})}</p>}{error&&<p role="alert">{error}</p>}<div className="nc-inline"><button className="button primary" disabled={busy} onClick={()=>{setBusy(true);setError('');void controller.confirmFile().catch(error=>setError(error.message)).finally(()=>setBusy(false));}}>{msg('下载后阅读')}</button><button className="button secondary" disabled={busy} onClick={()=>controller.closeFilePrompt()}>{msg('取消')}</button></div></Modal>;
}
