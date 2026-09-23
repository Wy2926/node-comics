import {useCallback,useEffect,useRef,useState} from 'react';
import {getLocale,msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {listSourceAccounts,subscribeSourceAccounts} from '../comics/application/source-service';
import {reconnectSource,disconnectSource} from '../comics/application/source-lifecycle';

export function SourceAccounts({onNotice,onChanged}:{onNotice:(message:string)=>void;onChanged:()=>void}){
 const [value,setValue]=useState<Awaited<ReturnType<typeof listSourceAccounts>>>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const request=useRef(0),running=useRef(false),locale=getLocale();
 const reload=useCallback(async()=>{
  const current=++request.current;
  try{const next=await listSourceAccounts();if(current===request.current){setValue(next);setError('');}}
  catch(error){if(current===request.current)setError((error as Error).message);}
 },[]);
 useEffect(()=>{
  void reload();const refresh=()=>{void reload();},unsubscribe=subscribeSourceAccounts(refresh);
  window.addEventListener('focus',refresh);
  return()=>{unsubscribe();window.removeEventListener('focus',refresh);request.current++;};
 },[reload,locale]);
 const run=async(action:()=>Promise<unknown>)=>{
  if(running.current)return;running.current=true;setBusy(true);
  try{await action();onChanged();}catch(error){onNotice((error as Error).message);}
  finally{await reload();running.current=false;setBusy(false);}
 };
 const states={connected:msg('已连接'),offline:msg('离线'),'reauth-required':msg('需要重新连接'),disconnected:msg('已断开连接'),revoked:msg('授权已撤销')};
 const errors=[...(error?[error]:[]),...(value?.errors.map(item=>`${item.providerLabel}: ${item.error}`)??[])];
 return <section className="settings-card nc-source-accounts"><h3><Icon name="user"/>{msg('云盘账户')}</h3>
  {!value&&!error&&<p role="status" className="nc-muted">{msg('正在读取云盘账户…')}</p>}
  {!!errors.length&&<div className="nc-inline" role="alert"><div>{errors.map((message,index)=><p key={index}>{message}</p>)}</div><button className="button secondary small" disabled={busy} onClick={()=>void reload()}>{msg('重试')}</button></div>}
  {value&&!value.accounts.length&&!errors.length&&<p className="nc-muted">{msg('暂无云盘账户，可从「我的漫画」连接云盘。')}</p>}
  {value?.accounts.map(connection=><article className="nc-source-account" key={connection.id}>
   <div className="nc-source-account-info">
    <div className="nc-source-account-heading"><h4>{connection.displayName}</h4><span className="nc-muted">{connection.providerLabel}</span></div>
    {!!connection.accountDetails.length&&<dl className="nc-source-account-details">{connection.accountDetails.map(field=><div key={field.id}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>}
   </div>
   <div className="nc-inline nc-source-account-actions">
    <span className="nc-source-account-status" data-status={connection.status}>{states[connection.status]}</span>
    {connection.canReconnect&&<button className="button secondary small" disabled={busy} onClick={()=>void run(()=>reconnectSource(connection.id))}>{msg('重新连接')}</button>}
    {connection.canDisconnect&&connection.status!=='disconnected'&&<button className="button danger small" disabled={busy} onClick={()=>void run(()=>disconnectSource(connection.id))}>{msg('断开连接')}</button>}
   </div>
  </article>)}
 </section>;
}
