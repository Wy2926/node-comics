import {useEffect,useRef,useState} from 'react';
import {msg} from '../../i18n/runtime';
import type {SourceAccount} from '../../comics/sources/contracts';
import type {SourceConnection} from '../../comics/domain';
import {connectRemoteLibrary,listRemoteProviders} from '../../comics/application/remote-library-service';
import {Modal} from '../components';
import {Select} from '../Select';

/** Provider-owned fields; the UI never reads the provider's private credential store. */
export function ConnectionDialog({account,onClose,onConnected}:{account?:SourceAccount;onClose:()=>void;onConnected:(connection:SourceConnection)=>void}){
  const providers=listRemoteProviders(),[providerId,setProviderId]=useState(account?.provider??providers[0]?.id??'');
  const provider=providers.find(value=>value.id===providerId);
  const [values,setValues]=useState<Record<string,string>>({name:account?.displayName??''});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),request=useRef<AbortController|undefined>(undefined);
  useEffect(()=>()=>request.current?.abort(),[]);
  const close=()=>{request.current?.abort();setValues({});onClose();};
  async function connect(){
    if(!provider||request.current)return;
    const controller=new AbortController();request.current=controller;setBusy(true);setError('');
    try{
      const connection=await connectRemoteLibrary(provider.id,values,account?.id,controller.signal);
      controller.signal.throwIfAborted();setValues({});onConnected(connection);
    }catch(error){if(!controller.signal.aborted)setError((error as Error).message);}
    finally{if(request.current===controller){request.current=undefined;if(!controller.signal.aborted)setBusy(false);}}
  }
  return <Modal title={account?msg('重新连接书库'):msg('连接远程书库')} onClose={close}>
    <form className="nc-stack" onSubmit={event=>{event.preventDefault();void connect();}}>
      {providers.length>1&&!account&&<label className="field">{msg('协议')}<Select value={providerId} disabled={busy} onChange={event=>{setProviderId(event.target.value);setValues({});setError('');}}>{providers.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</Select></label>}
      <p className="nc-muted">{msg('连接后浏览远程目录，打开时才加入我的漫画。')}</p>
      {provider?.fields.map(field=><label className="field" key={field.id}>{field.label}
        {field.type==='select'?<Select value={values[field.id]??field.options?.[0]?.value??''} disabled={busy} onChange={event=>setValues(previous=>({...previous,[field.id]:event.target.value}))}>{field.options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</Select>:
          <input type={field.type} required={field.required} value={values[field.id]??''} placeholder={field.placeholder} disabled={busy} maxLength={field.type==='url'?8192:field.type==='password'?4096:256} autoComplete={field.type==='password'?'new-password':'off'} spellCheck={false} onChange={event=>setValues(previous=>({...previous,[field.id]:event.target.value}))}/>}
        {field.description&&<small className="nc-muted">{field.description}</small>}
      </label>)}
      <p className="nc-muted">{msg('书库凭据仅保存在当前浏览器，不会上传至 NodeLane。')}</p>
      {error&&<p role="alert" className="error">{error}</p>}
      <div className="nc-inline"><button className="button primary" type="submit" disabled={busy||!provider}>{busy?msg('正在连接…'):msg('连接并浏览')}</button><button className="button secondary" type="button" onClick={close}>{msg('取消')}</button></div>
    </form>
  </Modal>;
}
