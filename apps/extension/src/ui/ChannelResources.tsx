import {useEffect,useState} from 'react';
import type {ChannelResource,ChannelResources as ResourceManager} from '../translation/channels/contracts';
import {msg} from '../i18n/runtime';
import {Modal,SettingRow} from './components';
import {Select,SelectOption} from './Select';
import {LanguageFlag} from './LanguageFlag';

const resourceState=(state:ChannelResource['state'])=>({missing:msg('未下载'),downloading:msg('下载中'),paused:msg('已暂停'),verifying:msg('正在校验'),ready:msg('已就绪'),error:msg('下载失败')})[state];
const size=(bytes:number)=>bytes<1024*1024?Math.ceil(bytes/1024)+' KB':(bytes/1024/1024).toFixed(1)+' MB';
export function ChannelResources({manager,language}:{manager:ResourceManager;language?:string}){
  const [open,setOpen]=useState(false),[resources,setResources]=useState<ChannelResource[]>([]),[category,setCategory]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
  const [resourceLanguage,setResourceLanguage]=useState<string>();
  useEffect(()=>{
    if(!open)return;
    let live=true;setLoading(true);
    const refresh=()=>void manager.read(language).then(value=>{if(live){setResources(value);setLoading(false);}}).catch(()=>{if(live){setError(msg('资源状态读取失败，请重新打开。'));setLoading(false);}});
    refresh();const stop=manager.subscribe(refresh),timer=setInterval(refresh,3000);
    return()=>{live=false;stop();clearInterval(timer);};
  },[open,manager,language]);
  async function act(action:'download'|'pause'|'remove'|'verify'|'stop',id?:string){
    setError('');setBusy(true);
    try{if(action==='stop')await manager.stop?.();else await manager.act(action,id,language);setResources(await manager.read(language));}catch(error){setError(error instanceof Error?error.message:msg('资源操作失败；请检查空间、网络或正在运行的任务。'));}finally{setBusy(false);}
  }
  const categories=[...new Map(resources.flatMap(resource=>resource.category?[[resource.category.id,resource.category] as const]:[])).values()];
  const current=categories.find(item=>item.id===category)??categories[0],selectedLanguage=current?.languages?.find(item=>item.id===(resourceLanguage??language))??current?.languages?.[0];
  const visible=resources.filter(resource=>(!current||resource.category?.id===current.id)&&(!selectedLanguage||selectedLanguage.supported&&resource.languages?.[selectedLanguage.id]))
    .map(resource=>({...resource,...(selectedLanguage?resource.languages?.[selectedLanguage.id]:{})}));
  const required=resources.filter(resource=>resource.required),ready=required.filter(resource=>resource.state==='ready').length;
  return <>
    <SettingRow title={msg('模型与字体')} description={msg('按需下载到浏览器，用于文字识别、画面处理和译文绘制。')}>
      <button type="button" className="button secondary" onClick={()=>{setError('');setResourceLanguage(undefined);setOpen(true);}}>{msg('管理模型与字体')}</button>
    </SettingRow>
    {open&&<Modal className="nc-resources-dialog" title={msg('模型与字体')} onClose={()=>setOpen(false)} footer={<div className="nc-resources-notice">
      {manager.stop&&<div className="nc-config-actions"><button type="button" className="button secondary small" disabled={busy} onClick={()=>void act('stop')}>{msg('停止本地任务')}</button></div>}
      <p className="nc-muted nc-resource-note">{msg('删除模型或字体只释放本机空间，已有译图仍会保留。')}</p>
      {error&&<p className="error" role="alert">{error}</p>}
    </div>}>
      <div className="nc-resources-overview nc-comic-paper">
        <div><strong>{loading?msg('正在读取资源…'):msg('必需资源 {0} / {1} 已就绪',{'0':ready,'1':required.length})}</strong>
          <p className="nc-muted">{msg('已占用 {0}；资源保存在当前浏览器。',{'0':size(resources.reduce((total,item)=>total+item.downloaded,0))})}</p>
        </div>
        <button type="button" className="button primary small" disabled={busy||loading||!required.length||ready===required.length} onClick={()=>void act('download')}>{msg('下载缺少的必需资源')}</button>
      </div>
      <div className="nc-resource-categories" role="group" aria-label={msg('资源分类')}>{categories.map(item=><button key={item.id} className="button secondary small" type="button" aria-pressed={current?.id===item.id} onClick={()=>setCategory(item.id)}>{item.label}<span>{resources.filter(resource=>resource.category?.id===item.id&&resource.state==='ready').length} / {resources.filter(resource=>resource.category?.id===item.id).length}</span></button>)}</div>
      {current&&<p className="nc-muted nc-resource-description">{current.description}</p>}
      {selectedLanguage&&<label className="nc-config-row nc-resource-language"><span>{msg('字体语言')}</span><Select aria-label={msg('字体语言')} placement="end" value={selectedLanguage.id} onChange={event=>setResourceLanguage(event.target.value)}>
        {current?.languages?.map(item=><SelectOption key={item.id} value={item.id} icon={<LanguageFlag language={item.id}/>}>{item.label+(item.supported?'':' · '+msg('待支持'))}</SelectOption>)}
      </Select></label>}
      <div key={(current?.id??'')+(selectedLanguage?.id??'')} className="nc-resource-list" role="region" aria-label={current?.label??msg('模型与字体')} tabIndex={0}>
        {selectedLanguage&&!selectedLanguage.supported&&<p className="nc-muted" role="status">{msg('此语言的字体暂未开放，支持后可在这里下载和管理。')}</p>}
        {visible.map(resource=><article key={resource.id} className="nc-resource-card">
        <div className="nc-resource-identity"><strong>{resource.label}</strong><span className="nc-resource-badge nc-comic-tag" data-state={resource.state} data-ready={resource.state==='ready'||undefined}>{resourceState(resource.state)}</span></div>
        <p className="nc-muted">{resource.description}</p>
        <div className="nc-resource-meta"><span>{size(resource.bytes)}</span><span>{resource.selected?msg('当前所选字体'):resource.required?msg('翻译必需'):msg('按需下载')}</span></div>
        {['downloading','paused','verifying'].includes(resource.state)&&<><progress max={resource.bytes} value={resource.downloaded} aria-label={resource.label}/><small>{size(resource.downloaded)} / {size(resource.bytes)}</small></>}
        {resource.state==='error'&&resource.detail&&<p role="alert" className="error">{resource.detail}</p>}
        <div className="nc-resource-footer"><details><summary>{msg('来源与许可')}</summary><p>{resource.license}</p><a href={resource.source} target="_blank" rel="noopener noreferrer">{msg('查看来源说明')}</a></details>
          <div className="nc-config-actions">
            {['missing','paused','error'].includes(resource.state)&&<button type="button" className="button secondary small" disabled={busy} onClick={()=>void act('download',resource.id)}>{resource.state==='paused'?msg('继续下载'):resource.state==='error'?msg('重试下载'):msg('下载')}</button>}
            {resource.state==='downloading'&&<button type="button" className="button secondary small" disabled={busy} onClick={()=>void act('pause',resource.id)}>{msg('暂停')}</button>}
            {resource.state==='ready'&&<button type="button" className="text-link" disabled={busy} onClick={()=>void act('verify',resource.id)}>{msg('校验')}</button>}
            {resource.downloaded>0&&!['downloading','verifying'].includes(resource.state)&&<button type="button" className="text-link nc-danger-text" disabled={busy} onClick={()=>void act('remove',resource.id)}>{msg('删除')}</button>}
          </div>
        </div>
      </article>)}</div>
    </Modal>}
  </>;
}
