import {msg} from '../i18n/runtime';
import {useEffect,useState} from 'react';
import {storageOverview,clearStorage,reconnectSource,disconnectSource} from '../comics/application/source-lifecycle';
import {SettingRow} from './components';
export function StorageManagement({onNotice,onChanged}:{onNotice:(message:string)=>void;onChanged:()=>void}){
 const [value,setValue]=useState<Awaited<ReturnType<typeof storageOverview>>>(),[busy,setBusy]=useState(false);
 const reload=()=>storageOverview().then(setValue);
 useEffect(()=>{void reload().catch(e=>onNotice(e.message));},[]);
 const run=async(action:()=>Promise<unknown>)=>{setBusy(true);try{await action();await reload();onChanged();}catch(e){onNotice((e as Error).message);}finally{setBusy(false);}};
 const size=(bytes:number)=>`${(bytes/1024/1024).toFixed(1)} MB`;
 return <section className="settings-card"><h3>{msg("本机资料与独立缓存")}</h3><SettingRow title={msg("本地源文件")} description={msg('{0} · 不自动淘汰；移除最后一份引用后释放。',{'0':size(value?.containers??0)})}><a href="#library">{msg("管理漫画")}</a></SettingRow><SettingRow title={msg("网站下载资料")} description={msg('{0} · 主动下载的原图，不参与缓存淘汰。',{'0':size(value?.downloads.bytes??0)})}><a href="#library">{msg("管理下载")}</a></SettingRow>
 {([['sourcePages',msg("原图页缓存")],['ranges',msg("源文件分段")],['translations',msg("译图缓存")],['thumbnails',msg("缩略图")]] as const).map(([kind,label])=><SettingRow key={kind} title={label} description={msg('{0} · 清理后按需重新读取，文档版本与阅读位置保留。',{'0':size(value?.[kind].bytes??0)})}><button className="button secondary small" disabled={busy} onClick={()=>void run(()=>clearStorage(kind))}>{msg("清理")}</button></SettingRow>)}
 {value?.connections.filter(c=>c.canReconnect||c.canDisconnect).map(c=><SettingRow key={c.id} title={c.displayName} description={c.status==='connected'?msg("{0} 已连接",{'0':c.providerLabel}):msg("{0} 需要重新连接",{'0':c.providerLabel})}><div className="nc-inline">{c.canReconnect&&<button className="button secondary small" disabled={busy} onClick={()=>void run(()=>reconnectSource(c.id))}>{msg("重新连接")}</button>}{c.canDisconnect&&<button className="button danger small" disabled={busy} onClick={()=>void run(()=>disconnectSource(c.id))}>{msg("断开连接")}</button>}</div></SettingRow>)}
 </section>;
}
