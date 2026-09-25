import {getLocale,msg} from '../i18n/runtime';
import {useCallback,useEffect,useRef,useState} from 'react';
import {storageOverview,clearStorage} from '../comics/application/source-lifecycle';
import {Icon} from '../icons';
import {SettingRow} from './components';
import {SourceAccounts} from './SourceAccounts';
import './storage-management.css';
export function StorageManagement({onNotice,onChanged}:{onNotice:(message:string)=>void;onChanged:()=>void}){
 const [value,setValue]=useState<Awaited<ReturnType<typeof storageOverview>>>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const request=useRef(0),running=useRef(false),locale=getLocale();
 const reload=useCallback(async()=>{
  const current=++request.current;
  try{const next=await storageOverview();if(current===request.current){setValue(next);setError('');}}
  catch(error){if(current===request.current)setError((error as Error).message);}
 },[]);
 useEffect(()=>{
  void reload();return()=>{request.current++;};
 },[reload,locale]);
 const run=async(action:()=>Promise<unknown>)=>{
  if(running.current)return;running.current=true;setBusy(true);
  try{await action();onChanged();}catch(e){onNotice((e as Error).message);}
  finally{await reload();running.current=false;setBusy(false);}
 };
 const size=(bytes?:number)=>bytes===undefined?'—':`${(bytes/1024/1024).toFixed(1)} MB`;
 return <>
  <section className="settings-card"><h3><Icon name="storage"/>{msg('本机资料与独立缓存')}</h3>
   {error&&<div className="nc-inline" role="alert"><p>{error}</p><button className="button secondary small" disabled={busy} onClick={()=>void reload()}>{msg('重试')}</button></div>}
   {!value&&!error&&<p role="status" className="nc-muted">{msg('正在读取本机资料…')}</p>}
   <SettingRow title={msg('本地源文件')} description={msg('{0} · 不自动淘汰；移除最后一份引用后释放。',{'0':size(value?.containers)})}/>
   <SettingRow title={msg('网站下载资料')} description={msg('{0} · 主动下载的原图，不参与缓存淘汰。',{'0':size(value?.downloads.bytes)})}/>
   {([['sourcePages',msg('原图页缓存')],['ranges',msg('源文件分段')],['translations',msg('译图缓存')],['thumbnails',msg('缩略图')]] as const).map(([kind,label])=><SettingRow key={kind} title={label} description={msg(kind==='translations'?'{0} · 清理后本地渠道需要重新翻译，漫画与阅读位置保留。':'{0} · 清理后按需重新读取，漫画与阅读位置保留。',{'0':size(value?.[kind].bytes)})}><button className="button secondary small" disabled={busy||!value} onClick={()=>void run(()=>clearStorage(kind))}>{msg('清理')}</button></SettingRow>)}
  </section>
  <SourceAccounts onNotice={onNotice} onChanged={onChanged}/>
 </>;
}
