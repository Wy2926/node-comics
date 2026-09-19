import {useEffect,useState} from 'react';
import type {Api} from '../api';
import {Icon} from '../icons';
import {languageLabel,modeLabels,type ReadingCopy,type TranslationOperation,type Job,type Paginated} from '../types';
import {Thumbnail} from '../reader/Images';
import {taskText} from '../reader/presentation';
import {historyPollDelay,pollVisibleHistory} from './history-polling';

type Props={api:Api;copies:ReadingCopy[];userId?:string;onOpen:(copy:ReadingCopy,job:Job)=>void;
  onLogin:()=>void;onDelete:(job:Job,onDeleted:()=>void)=>void};

/** History is a paged view of durable page operations, never a queue preflight. */
export function TranslationHistory({api,copies,userId,onOpen,onLogin,onDelete}:Props){
  const [data,setData]=useState<Paginated<TranslationOperation>>();
  const [offset,setOffset]=useState(0),[refresh,setRefresh]=useState(0);
  const [error,setError]=useState(''),[busy,setBusy]=useState('');
  useEffect(()=>{
    if(!api.token)return;
    setData(undefined);setError('');
    return pollVisibleHistory({load:()=>api.operations(offset),current:()=>api.isCurrent(),
      receive:value=>{setData(value);setError('');},error:failure=>setError(failure.message),
      delay:value=>historyPollDelay(value.items.map(item=>item.job?.status??'failed'))});
  },[api,offset,refresh]);

  const reload=()=>setRefresh(value=>value+1);
  async function download(job:Job){
    setBusy(job.id);setError('');
    try{
      const latest=await api.latestResult(job.id);
      if(!latest.result?.output_asset_id)throw Error('当前模式的最新译图已过期、删除或尚未完成。');
      const blob=await api.image(latest.result.output_asset_id);
      if(!api.isCurrent())return;
      const url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download=`漫画译图-${job.mode}-${job.target_language}.${blob.type==='image/jpeg'?'jpg':blob.type==='image/webp'?'webp':'png'}`;
      link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(failure){if(api.isCurrent())setError((failure as Error).message);}
    finally{if(api.isCurrent())setBusy('');}
  }
  async function cancel(job:Job){
    setBusy(job.id);setError('');
    try{await api.cancel(job.id);if(api.isCurrent())reload();}
    catch(failure){if(api.isCurrent())setError((failure as Error).message);}
    finally{if(api.isCurrent())setBusy('');}
  }

  return <div>
    <div className="nc-page-heading"><div><span className="nc-eyebrow">TRANSLATION JOURNAL</span><h1>翻译记录</h1>
      <p>逐页查看翻译进度与结果。</p></div>{api.token&&<button className="button secondary" onClick={reload}><Icon name="refresh"/>刷新记录</button>}</div>
    {!api.token?<div className="nc-empty"><Icon name="clock" size={36}/><h2>登录后找回翻译记录</h2>
      <p>任务保存在账户中，关闭阅读器也会继续处理。</p><button className="button primary" onClick={onLogin}>登录账户</button></div>:<>
      {error&&<div className="nc-error" role="alert">{error}<button className="text-link" onClick={reload}>重试</button></div>}
      {!data&&!error?<p className="nc-loading">正在读取翻译记录…</p>:data&&!data.items.length?<div className="nc-empty"><Icon name="clock" size={36}/>
        <h2>还没有翻译记录</h2><p>打开一本漫画，从需要翻译的那一页开始。</p></div>:data&&<>
        <div className="nc-history-list">{data.items.map(operation=>{
          const job=operation.job;
          const copy=job?copies.find(c=>c.pages.some(p=>p.ownerId===userId&&p.apiOrigin===new URL(api.base).origin&&
            (p.jobs.some(j=>j.id===job.id)||!!p.assetId&&p.assetId===(job.requested_asset_id??job.input_asset_id)))):undefined;
          const page=copy?.pages.find(p=>p.jobs.some(j=>j.id===job?.id)||!!p.assetId&&p.assetId===(job?.requested_asset_id??job?.input_asset_id));
          const attention=operation.disposition==='blocked'||job&&['failed','outcome_unknown','unknown_released'].includes(job.status);
          return <article className="nc-history-card" key={operation.operation_key}>
            <div className="nc-history-summary"><Thumbnail blobKey={page?.blobKey}/><div className="nc-history-copy">
              <div className="nc-section-heading"><h2>{copy?.title??'未关联本机漫画'}{copy&&page?` · 第 ${copy.pages.indexOf(page)+1} 页`:''}</h2>
                <span className={`nc-state ${attention?'attention':''}`}>{job?taskText(job):operation.message??'记录不可用'}</span></div>
              {job&&<p>{modeLabels[job.mode]} → {languageLabel(job.target_language)}{job.cache_hit?' · 复用已有结果':''}</p>}
              <p className="nc-muted">{new Date(operation.created_at ?? job?.created_at ?? 0).toLocaleString()}</p>
              {(job?.error?.message||operation.message)&&<p className="nc-attention">{job?.error?.message??operation.message}</p>}
              <div className="nc-history-bottom"><details className="nc-technical"><summary>技术详情</summary>
                <span>操作 {operation.operation_key}{job&&<><br/>任务 {job.id}</>}{operation.code&&<><br/>{operation.code}</>}</span></details>
                <div className="nc-inline">
                  {job&&copy&&<button className="button primary" onClick={()=>onOpen(copy,job)}>打开此页</button>}
                  {job?.output_asset_id&&<button className="button secondary" disabled={!!busy} onClick={()=>void download(job)}>保存最新译图</button>}
                  {job&&['awaiting_upload','validating_upload','queued','running'].includes(job.status)&&<button className="button secondary"
                    disabled={!!busy||job.cancel_requested} onClick={()=>void cancel(job)}>{job.cancel_requested?'正在停止':'停止任务'}</button>}
                  {job?.output_asset_id&&<button className="icon-button" aria-label="删除服务器译图" onClick={()=>onDelete(job,reload)}><Icon name="trash" size={18}/></button>}
                </div></div>
            </div></div>
          </article>;
        })}</div>
        <div className="nc-pagination"><span>共 {data.total} 条记录</span>
          <button className="button secondary" disabled={!offset} onClick={()=>setOffset(value=>Math.max(0,value-12))}>上一页</button>
          <button className="button secondary" disabled={data.next_offset==null} onClick={()=>setOffset(data.next_offset!)}>下一页</button></div>
      </>}
    </>}
  </div>;
}
