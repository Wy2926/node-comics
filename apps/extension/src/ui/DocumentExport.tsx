import {msg} from '../i18n/runtime';
import {useEffect,useRef,useState} from 'react';
import type {ChannelConnection} from '../translation/channels/contracts';
import type {Entry} from '../comics/domain';
import type {Settings} from '../types';
import {chooseExportDestination,exportDocument,exportOriginalFile,exportName,originalFileInfo,exportDirectoryInfo,saveBufferedExport,type ExportOptions,type ExportProgress} from '../comics/application/export-service';
import {Modal} from './components';
import {Select} from './Select';
import {Icon} from '../icons';
import {DialogNotice,DialogSubject} from './ConfirmationDialog';

export interface DocumentExportProps {document:Entry;channel?:ChannelConnection;settings:Pick<Settings,'language'>;onClose():void}
export function DocumentExport({document:doc,channel,settings,onClose}:DocumentExportProps){
  const [options,setOptions]=useState<ExportOptions>({format:'cbz',images:'original',mode:'classic',language:settings.language});
  const [directory,setDirectory]=useState<Awaited<ReturnType<typeof exportDirectoryInfo>>>();
  const [source,setSource]=useState<{name:string}>(),[sourceLoading,setSourceLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState<ExportProgress>(),[done,setDone]=useState('');
  const [prepared,setPrepared]=useState<File>();
  const active=useRef<AbortController|null>(null),identity=useRef(channel);identity.current=channel;
  useEffect(()=>{setPrepared(undefined);},[channel]);
  useEffect(()=>{let alive=true;setSource(undefined);setDirectory(undefined);setSourceLoading(true);setError('');setDone('');setPrepared(undefined);setOptions(value=>({...value,range:'entry',allowIncomplete:false,language:settings.language}));
    void Promise.all([originalFileInfo(doc.id),doc.format==='epub'?undefined:exportDirectoryInfo(doc.id,settings.language)]).then(([file,chapters])=>{if(alive){setSource(file);setDirectory(chapters);}}).catch(failure=>{if(alive)setError((failure as Error).message);}).finally(()=>{if(alive)setSourceLoading(false);});
    return()=>{alive=false;active.current?.abort();};},[doc.id,settings.language]);
  const wholeDirectory=options.range==='directory',hasDirectory=!!directory&&(directory.chapters.length>1||!directory.complete);
  const incomplete=!wholeDirectory&&doc.discoveryComplete===false;
  const changeOptions=(change:Partial<ExportOptions>)=>{setOptions(value=>({...value,...change}));setDone('');setError('');setPrepared(undefined);};
  const save=async()=>{
    if(!prepared||busy)return;
    setBusy(true);setError('');
    try{await navigator.share({files:[prepared]});setDone(msg('已导出 {0}',{'0':prepared.name}));setPrepared(undefined);}
    catch(failure){if((failure as Error)?.name!=='AbortError')setError((failure as Error)?.message??String(failure));}
    finally{setBusy(false);}
  };
  const run=async(original=false)=>{
    if(active.current||busy||sourceLoading||original&&!source)return;setBusy(true);setError('');setDone('');setProgress(undefined);
    const controller=new AbortController();active.current=controller;
    let destination:WritableStream<Uint8Array>|undefined;
    try{
      destination=await chooseExportDestination(original?source!.name:exportName(wholeDirectory?directory!.title:doc.title,options));
      controller.signal.throwIfAborted();
      const context={signal:controller.signal,scope:channel?.scope,readResult:channel?.readResult.bind(channel),destination,progress:(value:ExportProgress)=>{if(!controller.signal.aborted)setProgress(value);},isCurrent:()=>identity.current===channel&&channel?.isCurrent()!==false};
      const result=original?await exportOriginalFile(doc.id,context):await exportDocument(doc.id,options,context);
      controller.signal.throwIfAborted();
      const file=saveBufferedExport(result);
      if(file)setPrepared(file);else setDone(msg('已导出 {0}',{'0':result.name}));
    }catch(failure){await destination?.abort(failure).catch(()=>{});if((failure as Error).name!=='AbortError')setError((failure as Error).message);}
    finally{setBusy(false);active.current=null;}
  };
  return <Modal title={msg("导出漫画")} icon="download" onClose={()=>{active.current?.abort();onClose();}} footer={
    <div className="nc-dialog-footer">{prepared?<button className="button primary" disabled={busy} onClick={()=>void save()}><Icon name="folder" size={18}/>{msg('保存')}</button>:<>{source&&!wholeDirectory&&<button className="button secondary" disabled={busy||sourceLoading} onClick={()=>void run(true)}><Icon name="folder" size={18}/>{msg("保存完整源文件")}</button>}{busy?<button className="button secondary" onClick={()=>active.current?.abort()}>{msg("取消导出")}</button>:doc.format!=='epub'&&<button className="button primary" disabled={sourceLoading||incomplete&&!options.allowIncomplete||options.images==='translation'&&!channel?.available} onClick={()=>void run()}><Icon name="download" size={18}/>{wholeDirectory?msg('导出整个章节目录'):incomplete?msg('导出已发现页面'):msg("导出全部页面")}</button>}</>}</div>
  }>
    <div className="nc-export-options nc-dialog-content">
      <DialogSubject title={wholeDirectory?directory!.title:doc.title} meta={wholeDirectory?msg('共 {0} 章',{'0':directory!.chapters.length}):doc.format==='epub'?source?.name:incomplete?msg('当前已发现 {0} 页',{'0':doc.pageCount??0}):doc.pageCount!==undefined?msg('共 {0} 页',{'0':doc.pageCount}):undefined}/>
      {doc.format!=='epub'&&<>
      <div className="form-grid">{hasDirectory&&<label className="nc-export-range">{msg('导出范围')}<Select value={options.range??'entry'} disabled={busy} onChange={event=>changeOptions({range:event.target.value as ExportOptions['range'],allowIncomplete:false})}><option value="entry">{msg('当前章节')}</option><option value="directory">{msg('整个章节目录')}</option></Select></label>}
      <label>{msg("文件格式")}<Select value={options.format} disabled={busy} onChange={event=>changeOptions({format:event.target.value as ExportOptions['format']})}><option value="cbz">{msg("CBZ 漫画包")}</option><option value="zip">{msg("ZIP 图片包")}</option><option value="pdf">{msg("PDF 文档")}</option></Select></label>
      <label>{msg("图片内容")}<Select value={options.images} disabled={busy} onChange={event=>changeOptions({images:event.target.value as ExportOptions['images']})}><option value="original">{msg("原图")}</option><option value="translation" disabled={!channel?.available}>{msg('已有译图（{0}）',{'0':settings.language})}</option></Select></label></div>
      <DialogNotice title={msg('导出范围')}>{wholeDirectory?msg('按阅读目录顺序导出，每话沿用当前语言与版本选择；不会重复导出同一话的其他版本。'):msg('仅当前内容，不包含其他章节。')}<p>{msg('会读取全部页面，可能需要从来源下载图片。')}</p>{wholeDirectory&&<p>{msg('CBZ / ZIP 按章节分文件夹，PDF 按章节顺序合并。')}</p>}</DialogNotice>
      {wholeDirectory&&!directory?.complete&&<DialogNotice>{msg('章节目录尚未完整加载，导出时会先补齐目录。')}</DialogNotice>}
      {options.images==='translation'&&<DialogNotice title={msg('已有译图')}>{msg('只使用已有译图，缺少时保留原图；不会创建翻译任务。')}</DialogNotice>}
      {incomplete&&<label className="nc-export-incomplete"><input type="checkbox" disabled={busy} checked={!!options.allowIncomplete} onChange={event=>changeOptions({allowIncomplete:event.target.checked})}/><span>{msg("仅导出目前已发现的页面")}</span></label>}
      <DialogNotice title={msg('保存方式')}>{msg("支持文件选择器时，CBZ / ZIP 直接逐页写入文件；其他浏览器与 PDF 导出限制为 128 MiB。")}</DialogNotice>
      </>}
      {doc.format==='epub'&&!source&&!error&&<DialogNotice role="status">{sourceLoading?msg('加载中…'):msg('完整源文件不可用，请重新获取后再导出。')}</DialogNotice>}
      {busy&&<div className="nc-export-progress" role="status"><div><strong>{progress?.phase??msg('处理中…')}</strong>{!!progress?.total&&<span>{progress.completed} / {progress.total}</span>}</div>{wholeDirectory&&progress?.file&&<span className="nc-export-current">{progress.file}</span>}<progress aria-label={msg('导出漫画')} value={progress?.total?progress.completed:undefined} max={Math.max(1,progress?.total??1)}/></div>}
      {prepared&&<DialogNotice role="status" title={prepared.name}>{msg('文件已准备好，请点击“保存”选择位置。')}</DialogNotice>}
      {error&&<DialogNotice tone="danger" role="alert">{error}</DialogNotice>}{done&&<DialogNotice tone="success" role="status">{done}</DialogNotice>}
    </div>
  </Modal>;
}
