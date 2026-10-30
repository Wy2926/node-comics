import {useEffect,useId,useState} from 'react';
import {msg} from '../i18n/runtime';
import {automaticTabUrl,directoryPath,matchAutomaticTab,siteFromInput,tabDirectories,type AutoTranslateSite} from '../inline/auto-tab-rules';
import {runAutoTabRegex} from '../inline/auto-tab-regex';
import {Modal} from './components';
import {Select} from './Select';

export function AutoTranslateSiteEditor({site,sourceUrl,onSave,onClose,pending,error}:{site?:AutoTranslateSite;sourceUrl?:string;onSave:(site:AutoTranslateSite)=>Promise<void>;onClose:()=>void;pending:boolean;error:string}){
  const form=useId(),[input,setInput]=useState(site?.hostname??''),[scope,setScope]=useState<AutoTranslateSite['scope']>(site?.scope??'domain');
  const base=siteFromInput(input),source=automaticTabUrl(sourceUrl)??base;
  const paths=source?tabDirectories(source):[];
  const [path,setPath]=useState(site?.scope==='directory'?site.value:paths[0]??''),[custom,setCustom]=useState(false);
  const [pattern,setPattern]=useState(site?.scope==='regex'?site.value:''),[test,setTest]=useState(sourceUrl??'');
  const hostname=base?.hostname??'',testUrl=automaticTabUrl(test||source?.href),value=scope==='domain'?'':scope==='directory'?directoryPath(path)??'':pattern.trim();
  const key=JSON.stringify([hostname,scope,value,testUrl?.href]),[check,setCheck]=useState<{key:string;matches:boolean;error:string}>();
  const valid=!!base&&(scope==='domain'||!!value);
  useEffect(()=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>{
      const rule:AutoTranslateSite={hostname,scope,value,enabled:true};
      if(!valid){setCheck({key,matches:false,error:msg('请填写有效的网站和翻译范围。')});return;}
      if(scope!=='regex'){setCheck({key,matches:!!testUrl&&matchAutomaticTab(rule,testUrl)===true,error:''});return;}
      void runAutoTabRegex(value,testUrl?.hostname===hostname?testUrl.href:base!.origin,controller.signal).then(result=>{
        if(controller.signal.aborted)return;
        setCheck({key,matches:!!testUrl&&testUrl.hostname===hostname&&result.matches,error:result.error==='invalid'?msg('正则格式有误，请检查表达式。'):result.error==='timeout'?msg('匹配超时，请简化正则表达式。'):result.error?msg('规则检查失败，请重试。'):''});
      });
    },scope==='regex'?180:0);
    return()=>{clearTimeout(timer);controller.abort();};
  },[key,valid]);
  function choose(next:AutoTranslateSite['scope']){
    setScope(next);
    if(next==='directory'&&!path)setPath(paths[0]??'');
    if(next==='regex'&&!pattern){const url=source??base;setPattern('^'+(url?url.origin+url.pathname:'https://').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:[?#].*)?$');}
  }
  return <Modal title={msg('自动翻译范围')} subtitle={msg('仅匹配标签页网址，不匹配图片地址。')} icon="globe" onClose={()=>{if(!pending)onClose();}} className="nc-auto-site-editor"
    footer={<><button type="button" className="button secondary" disabled={pending} onClick={onClose}>{msg('取消')}</button><button type="submit" form={form} className="button primary" disabled={pending||!valid||check?.key!==key||!!check.error}>{pending?msg('正在保存…'):site?.enabled?msg('保存'):msg('保存并开启')}</button></>}>
    <form id={form} className="nc-auto-site-form" onSubmit={event=>{event.preventDefault();if(valid&&check?.key===key&&!check.error&&!pending)void onSave({hostname,enabled:true,scope,value});}}>
      <label className="field">{msg('网站网址或域名')}<input value={input} disabled={pending} readOnly={!!site} onChange={event=>setInput(event.target.value)} placeholder="comics.example.com" autoComplete="off" spellCheck={false}/></label>
      <p className="muted">{msg('仅此域名，不包含子域名。')}</p>
      <fieldset className="nc-auto-site-choices" disabled={pending}><legend>{msg('翻译范围')}</legend>
        <label><input type="radio" name={form+'-scope'} checked={scope==='domain'} onChange={()=>choose('domain')}/>{msg('整个网站')}</label>
        <label><input type="radio" name={form+'-scope'} checked={scope==='directory'} onChange={()=>choose('directory')}/>{msg('指定目录')}</label>
      </fieldset>
      {scope==='directory'&&<div className="nc-auto-site-fields">
        {!!paths.length&&<label className="field">{msg('选择目录')}<Select disabled={pending} value={custom||!paths.includes(path)?'custom':path} onChange={event=>{setCustom(event.target.value==='custom');if(event.target.value!=='custom')setPath(event.target.value);}}>{paths.map(path=><option key={path} value={path}>{path}/</option>)}<option value="custom">{msg('手动输入目录')}</option></Select></label>}
        {(custom||!paths.length||!paths.includes(path))&&<label className="field">{msg('目录路径')}<input disabled={pending} value={path} onChange={event=>setPath(event.target.value)} placeholder="/manga/" spellCheck={false}/></label>}
        <p className="muted">{msg('包含目录及下级页面，忽略查询参数与锚点。')}</p>
      </div>}
      <details open={scope==='regex'||undefined}><summary>{msg('高级：正则匹配')}</summary><label className="nc-auto-site-regex-choice"><input type="radio" disabled={pending} name={form+'-scope'} checked={scope==='regex'} onChange={()=>choose('regex')}/>{msg('正则匹配')}</label>
        {scope==='regex'&&<><label className="field">{msg('网址正则')}<textarea disabled={pending} value={pattern} rows={2} maxLength={300} aria-describedby={form+'-regex-help'} onChange={event=>setPattern(event.target.value)} spellCheck={false}/></label><p id={form+'-regex-help'} className="muted">{msg('匹配完整网址，区分大小写；始终限定在此域名内。')}</p></>}
      </details>
      <label className="field">{msg('测试标签页网址')}<input disabled={pending} value={test} onChange={event=>setTest(event.target.value)} placeholder={source?.href??'https://comics.example.com/manga/1'} spellCheck={false}/></label>
      <p role={valid&&check?.key===key&&check.error?'alert':'status'} className={valid&&check?.key===key&&check.error?'inline-error':check?.key===key&&check.matches?'nc-auto-site-match':'muted'}>{check?.key!==key?msg('正在检查…'):check.error?check.error:check.matches?msg('本页匹配'):msg('本页不匹配')}</p>
      {error&&<p className="inline-error" role="alert">{error}</p>}
    </form>
  </Modal>;
}
