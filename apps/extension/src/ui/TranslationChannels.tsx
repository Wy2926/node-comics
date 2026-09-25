import {useEffect,useState} from 'react';
import {msg} from '../i18n/runtime';
import {availableChannelProtocols,connectChannel,listChannels,removeChannel,selectChannel,subscribeChannels,type ChannelProfile} from '../translation/channels';
import {Select} from './Select';
import {Modal,SettingRow} from './components';

export function TranslationChannels(){
  const protocols=availableChannelProtocols();
  const [profiles,setProfiles]=useState<ChannelProfile[]>([]),[active,setActive]=useState('');
  const [editing,setEditing]=useState<ChannelProfile|null|undefined>(),[protocol,setProtocol]=useState(protocols[0]?.id??'');
  const [name,setName]=useState(''),[values,setValues]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const definition=protocols.find(p=>p.id===protocol);
  useEffect(()=>{let live=true;const reload=()=>void listChannels().then(value=>{if(live){setProfiles(value.profiles);setActive(value.activeId);}}).catch(e=>{if(live)setError(e.message);});reload();const stop=subscribeChannels(reload);return()=>{live=false;stop();};},[]);
  function edit(profile?:ChannelProfile){setEditing(profile??null);setProtocol(profile?.adapterId??protocols[0]?.id??'');setName(profile?.name??'');setValues(profile?.settings??{});setError('');}
  async function save(){
    if(!definition||busy)return;setBusy(true);setError('');
    const settings:Record<string,string>={},secrets:Record<string,string>={};
    for(const field of definition.fields)(field.type==='password'?secrets:settings)[field.key]=values[field.key]??'';
    try{const profile=await connectChannel(protocol,name,{settings,secrets},editing?.id);await selectChannel(profile.id);setValues({});setEditing(undefined);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function remove(profile:ChannelProfile){setBusy(true);setError('');try{await removeChannel(profile.id);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <section className="settings-card">
    <h3>{msg('翻译渠道')}</h3>
    <SettingRow title={msg('当前渠道')} description={msg('阅读器与网页原位翻译使用同一渠道；本地服务无需 NodeLane 账号。')}>
      <Select aria-label={msg('当前渠道')} value={active} disabled={busy} onChange={e=>{setError('');void selectChannel(e.target.value).catch(e=>setError(e.message));}}>
        {profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </Select>
    </SettingRow>
    {profiles.filter(profile=>protocols.some(p=>p.id===profile.adapterId)).map(profile=><SettingRow key={profile.id} title={profile.name} description={protocols.find(p=>p.id===profile.adapterId)?.label??''}>
      <div className="nc-inline"><button className="button secondary small" disabled={busy} onClick={()=>edit(profile)}>{msg('重新连接')}</button><button className="button secondary small" disabled={busy} onClick={()=>void remove(profile)}>{msg('移除')}</button></div>
    </SettingRow>)}
    <button className="button secondary" disabled={busy} onClick={()=>edit()}>{msg('添加翻译渠道')}</button>
    {error&&editing===undefined&&<p role="alert" className="error">{error}</p>}
    {editing!==undefined&&<Modal title={editing?msg('重新连接翻译渠道'):msg('添加翻译渠道')} onClose={()=>{if(!busy){setValues({});setEditing(undefined);}}}>
      <form className="nc-stack" onSubmit={e=>{e.preventDefault();void save();}}>
        {protocols.length>1&&<label className="field">{msg('协议')}<Select value={protocol} disabled={busy} onChange={e=>{setProtocol(e.target.value);setValues({});}}>{protocols.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</Select></label>}
        <p className="nc-muted">{definition?.label}</p>
        <label className="field">{msg('名称')}<input value={name} disabled={busy} maxLength={80} placeholder={definition?.label} onChange={e=>setName(e.target.value)}/></label>
        {definition?.fields.map(field=><label className="field" key={field.key}>{field.label}<input type={field.type} required={field.required} value={values[field.key]??''} placeholder={field.placeholder} disabled={busy} autoComplete={field.type==='password'?'new-password':'off'} onChange={e=>setValues({...values,[field.key]:e.target.value})}/></label>)}
        <p className="nc-muted">{msg('连接成功后仅保存服务令牌，密码不会保存。')}</p>
        {error&&<p role="alert" className="error">{error}</p>}
        <button className="button primary" type="submit" disabled={busy}>{busy?msg('正在连接…'):msg('连接并使用')}</button>
      </form>
    </Modal>}
  </section>;
}
