import {msg} from '../i18n/runtime';
import {useEffect,useRef,useState} from 'react';
import type {Api} from '../api';
import type {Entry} from '../comics/domain';
import type {Settings} from '../types';
import {chooseExportDestination,exportDocument,exportOriginalFile,exportName,originalFileInfo,saveBufferedExport,type ExportOptions,type ExportProgress} from '../comics/application/export-service';
import {Modal} from './components';
import {Select} from './Select';

export interface DocumentExportProps {document:Entry;api?:Api;userId?:string;settings:Pick<Settings,'language'|'translationMode'>;onClose():void}
export function DocumentExport({document:doc,api,userId,settings,onClose}:DocumentExportProps){
  const [options,setOptions]=useState<ExportOptions>({format:'cbz',images:'original',mode:settings.translationMode,language:settings.language});
  const [source,setSource]=useState<{name:string}>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState<ExportProgress>(),[done,setDone]=useState('');
  const active=useRef<AbortController|null>(null),identity=useRef({api,userId});identity.current={api,userId};
  useEffect(()=>{let alive=true;void originalFileInfo(doc.id).then(value=>{if(alive)setSource(value);});return()=>{alive=false;active.current?.abort();};},[doc.id]);
  const run=async(original=false)=>{
    if(busy)return;setBusy(true);setError('');setDone('');setProgress(undefined);
    const controller=new AbortController();active.current=controller;
    let destination:WritableStream<Uint8Array>|undefined;
    try{
      destination=await chooseExportDestination(original?source!.name:exportName(doc.title,options));
      const context={signal:controller.signal,api,userId,destination,progress:setProgress,isCurrent:()=>identity.current.api===api&&identity.current.userId===userId};
      const result=original?await exportOriginalFile(doc.id,context):await exportDocument(doc.id,options,context);
      saveBufferedExport(result);setDone(msg('已导出 {0}',{'0':result.name}));
    }catch(failure){await destination?.abort(failure).catch(()=>{});if((failure as Error).name!=='AbortError')setError((failure as Error).message);}
    finally{setBusy(false);active.current=null;}
  };
  return <Modal title={msg("导出漫画")} subtitle={doc.title} onClose={()=>{active.current?.abort();onClose();}}>
    <div className="nc-export-options">
      <p>{msg("导出会主动读取当前内容的全部页面，可能从云盘或来源网站下载图片。已有译图导出不创建翻译任务，缺少译图的页面保留原图。")}</p>
      <div className="form-grid"><label>{msg("文件格式")}<Select value={options.format} disabled={busy} onChange={event=>setOptions({...options,format:event.target.value as ExportOptions['format']})}><option value="cbz">{msg("CBZ 漫画包")}</option><option value="zip">{msg("ZIP 图片包")}</option><option value="pdf">{msg("PDF 文档")}</option></Select></label>
      <label>{msg("图片内容")}<Select value={options.images} disabled={busy} onChange={event=>setOptions({...options,images:event.target.value as ExportOptions['images']})}><option value="original">{msg("原图")}</option><option value="translation" disabled={!userId}>{msg('已有译图（{0}）',{'0':settings.language})}</option></Select></label></div>
      {doc.discoveryComplete===false&&<label><input type="checkbox" disabled={busy} checked={!!options.allowIncomplete} onChange={event=>setOptions({...options,allowIncomplete:event.target.checked})}/>{msg("仅导出目前已发现的页面")}</label>}
      <p className="nc-muted">{msg("支持文件选择器时，CBZ / ZIP 直接逐页写入文件；其他浏览器与 PDF 导出限制为 128 MiB。")}</p>
      {progress&&<div role="status"><progress value={progress.completed} max={Math.max(1,progress.total)}/><p>{progress.phase} · {progress.completed} / {progress.total}</p></div>}
      {error&&<p role="alert">{error}</p>}{done&&<p role="status">{done}</p>}
      <footer className="nc-import-footer"><div>{source&&<button className="button secondary" disabled={busy} onClick={()=>void run(true)}>{msg("保存完整源文件")}</button>}{busy?<button className="button secondary" onClick={()=>active.current?.abort()}>{msg("取消导出")}</button>:<button className="button primary" onClick={()=>void run()}>{msg("导出全部页面")}</button>}</div></footer>
    </div>
  </Modal>;
}
