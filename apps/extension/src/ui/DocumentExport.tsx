import {msg} from '../i18n/runtime';
import {useEffect,useRef,useState} from 'react';
import type {ChannelConnection} from '../translation/channels/contracts';
import type {Entry} from '../comics/domain';
import type {Settings} from '../types';
import {chooseExportDestination,exportDocument,exportOriginalFile,exportName,originalFileInfo,saveBufferedExport,type ExportOptions,type ExportProgress} from '../comics/application/export-service';
import {Modal} from './components';
import {Select} from './Select';
import {Icon} from '../icons';
import {DialogNotice,DialogSubject} from './ConfirmationDialog';

export interface DocumentExportProps {document:Entry;channel?:ChannelConnection;settings:Pick<Settings,'language'>;onClose():void}
export function DocumentExport({document:doc,channel,settings,onClose}:DocumentExportProps){
  const [options,setOptions]=useState<ExportOptions>({format:'cbz',images:'original',mode:'classic',language:settings.language});
  const [source,setSource]=useState<{name:string}>(),[sourceLoading,setSourceLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState<ExportProgress>(),[done,setDone]=useState('');
  const active=useRef<AbortController|null>(null),identity=useRef(channel);identity.current=channel;
  useEffect(()=>{let alive=true;setSource(undefined);setSourceLoading(true);setError('');void originalFileInfo(doc.id).then(value=>{if(alive)setSource(value);}).catch(failure=>{if(alive)setError((failure as Error).message);}).finally(()=>{if(alive)setSourceLoading(false);});return()=>{alive=false;active.current?.abort();};},[doc.id]);
  const run=async(original=false)=>{
    if(active.current||busy||original&&!source)return;setBusy(true);setError('');setDone('');setProgress(undefined);
    const controller=new AbortController();active.current=controller;
    let destination:WritableStream<Uint8Array>|undefined;
    try{
      destination=await chooseExportDestination(original?source!.name:exportName(doc.title,options));
      const context={signal:controller.signal,scope:channel?.scope,readResult:channel?.readResult.bind(channel),destination,progress:setProgress,isCurrent:()=>identity.current===channel&&channel?.isCurrent()!==false};
      const result=original?await exportOriginalFile(doc.id,context):await exportDocument(doc.id,options,context);
      saveBufferedExport(result);setDone(msg('已导出 {0}',{'0':result.name}));
    }catch(failure){await destination?.abort(failure).catch(()=>{});if((failure as Error).name!=='AbortError')setError((failure as Error).message);}
    finally{setBusy(false);active.current=null;}
  };
  return <Modal title={msg("导出漫画")} icon="download" onClose={()=>{active.current?.abort();onClose();}} footer={
    <div className="nc-dialog-footer">{source&&<button className="button secondary" disabled={busy} onClick={()=>void run(true)}><Icon name="folder" size={18}/>{msg("保存完整源文件")}</button>}{busy?<button className="button secondary" onClick={()=>active.current?.abort()}>{msg("取消导出")}</button>:doc.format!=='epub'&&<button className="button primary" disabled={doc.discoveryComplete===false&&!options.allowIncomplete} onClick={()=>void run()}><Icon name="download" size={18}/>{doc.discoveryComplete===false?msg('导出已发现页面'):msg("导出全部页面")}</button>}</div>
  }>
    <div className="nc-export-options nc-dialog-content">
      <DialogSubject title={doc.title} meta={doc.format==='epub'?source?.name:doc.discoveryComplete===false?msg('当前已发现 {0} 页',{'0':doc.pageCount??0}):doc.pageCount!==undefined?msg('共 {0} 页',{'0':doc.pageCount}):undefined}/>
      {doc.format!=='epub'&&<>
      <div className="form-grid"><label>{msg("文件格式")}<Select value={options.format} disabled={busy} onChange={event=>setOptions({...options,format:event.target.value as ExportOptions['format']})}><option value="cbz">{msg("CBZ 漫画包")}</option><option value="zip">{msg("ZIP 图片包")}</option><option value="pdf">{msg("PDF 文档")}</option></Select></label>
      <label>{msg("图片内容")}<Select value={options.images} disabled={busy} onChange={event=>setOptions({...options,images:event.target.value as ExportOptions['images']})}><option value="original">{msg("原图")}</option><option value="translation" disabled={!channel?.available}>{msg('已有译图（{0}）',{'0':settings.language})}</option></Select></label></div>
      <DialogNotice title={msg('导出范围')}>{msg('仅当前内容，不包含其他章节。')}<p>{msg('会读取全部页面，可能需要从来源下载图片。')}</p></DialogNotice>
      {options.images==='translation'&&<DialogNotice title={msg('已有译图')}>{msg('只使用已有译图，缺少时保留原图；不会创建翻译任务。')}</DialogNotice>}
      {doc.discoveryComplete===false&&<label className="nc-export-incomplete"><input type="checkbox" disabled={busy} checked={!!options.allowIncomplete} onChange={event=>setOptions({...options,allowIncomplete:event.target.checked})}/><span>{msg("仅导出目前已发现的页面")}</span></label>}
      <DialogNotice title={msg('保存方式')}>{msg("支持文件选择器时，CBZ / ZIP 直接逐页写入文件；其他浏览器与 PDF 导出限制为 128 MiB。")}</DialogNotice>
      </>}
      {doc.format==='epub'&&!source&&!error&&<DialogNotice role="status">{sourceLoading?msg('加载中…'):msg('完整源文件不可用，请重新获取后再导出。')}</DialogNotice>}
      {busy&&<div className="nc-export-progress" role="status"><div><strong>{progress?.phase??msg('处理中…')}</strong>{progress&&<span>{progress.completed} / {progress.total}</span>}</div><progress aria-label={msg('导出漫画')} value={progress?.completed} max={Math.max(1,progress?.total??1)}/></div>}
      {error&&<DialogNotice tone="danger" role="alert">{error}</DialogNotice>}{done&&<DialogNotice tone="success" role="status">{done}</DialogNotice>}
    </div>
  </Modal>;
}
