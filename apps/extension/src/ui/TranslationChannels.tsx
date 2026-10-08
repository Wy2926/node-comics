import {useEffect,useId,useState} from 'react';
import {msg} from '../i18n/runtime';
import {availableChannelProtocols,connectChannel,listChannels,removeChannel,savedChannelSecretFields,selectChannel,subscribeChannels,type ChannelProfile} from '../translation/channels';
import {Icon} from '../icons';
import {Modal} from './components';
import './translation-channels.css';

function ChannelGuide({url}:{url?:string}){
  if(!url)return null;
  return <a className="text-link nc-channel-guide" href={url} target="_blank" rel="noopener noreferrer">
    <Icon name="book" size={16}/>
    {msg('使用教程')}
    <Icon name="external" size={14}/>
  </a>;
}

export function TranslationChannels(){
  const formId=useId();
  const definitions=availableChannelProtocols();
  const protocols=definitions.filter(item=>item.configurable);
  const [profiles,setProfiles]=useState<ChannelProfile[]>([]);
  const [active,setActive]=useState('');
  const [editing,setEditing]=useState<ChannelProfile|null|undefined>();
  const [protocol,setProtocol]=useState(protocols[0]?.id??'');
  const [name,setName]=useState('');
  const [values,setValues]=useState<Record<string,string>>({});
  const [savedFields,setSavedFields]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const definition=protocols.find(p=>p.id===protocol);
  const settingFields=definition?.fields.filter(field=>field.type!=='password')??[];
  const canReuse=!!editing&&editing.adapterId===protocol
    &&Object.keys(editing.settings).length===settingFields.length
    &&settingFields.every(field=>(values[field.key]??'')===editing.settings[field.key]);

  useEffect(()=>{
    let live=true;
    const reload=()=>void listChannels().then(value=>{
      if(live){
        setProfiles(value.profiles);
        setActive(value.activeId);
      }
    }).catch(e=>{if(live)setError(e.message);});
    reload();
    const stop=subscribeChannels(reload);
    return()=>{live=false;stop();};
  },[]);

  useEffect(()=>{
    let live=true;
    if(editing){
      void savedChannelSecretFields(editing.id)
        .then(fields=>{if(live)setSavedFields(fields);})
        .catch(e=>{if(live)setError(e.message);});
    }
    return()=>{live=false;};
  },[editing]);

  function edit(profile?:ChannelProfile){
    setEditing(profile??null);
    setProtocol(profile?.adapterId??protocols[0]?.id??'');
    setName(profile?.name??'');
    setValues(profile?.settings??{});
    setSavedFields([]);
    setError('');
  }

  function close(){
    if(busy)return;
    setValues({});
    setError('');
    setEditing(undefined);
  }

  async function save(){
    if(!definition||busy)return;
    setBusy(true);
    setError('');
    const settings:Record<string,string>={},secrets:Record<string,string>={};
    for(const field of definition.fields){
      (field.type==='password'?secrets:settings)[field.key]=values[field.key]??'';
    }
    try{
      const profile=await connectChannel(protocol,name,{settings,secrets},editing?.id);
      await selectChannel(profile.id);
      setValues({});
      setEditing(undefined);
    }catch(e){
      setError((e as Error).message);
      if(editing){
        // A failed settings write may have changed the bound credential record.
        setSavedFields(await savedChannelSecretFields(editing.id).catch(()=>[]));
      }
    }finally{
      setBusy(false);
    }
  }

  async function select(id:string){
    if(busy||id===active)return;
    setError('');
    try{
      await selectChannel(id);
    }catch(e){
      setError((e as Error).message);
    }
  }

  async function remove(profile:ChannelProfile){
    if(busy)return;
    setBusy(true);
    setError('');
    try{
      await removeChannel(profile.id);
    }catch(e){
      setError((e as Error).message);
    }finally{
      setBusy(false);
    }
  }

  return <section className="settings-card nc-channel-settings">
    <div className="nc-channel-heading">
      <h3><Icon name="translate"/>{msg('翻译渠道')}</h3>
      <button type="button" className="button secondary small" disabled={busy||!protocols.length} onClick={()=>edit()}>
        <Icon name="plus" size={18}/>{msg('添加翻译渠道')}
      </button>
    </div>
    <p className="nc-channel-intro">{msg('阅读器与网页原位翻译共用当前渠道，每次使用一个渠道。')}</p>
    <fieldset className="nc-channel-list" disabled={busy}>
      <legend>{msg('当前渠道')}</legend>
      <div className="nc-channel-grid">
        {profiles.map(profile=>{
          const info=definitions.find(item=>item.id===profile.adapterId);
          const selected=profile.id===active;
          return <article key={profile.id} className="nc-channel-card" data-selected={selected||undefined}>
            <label className="nc-channel-choice">
              <input type="radio" name="translation-channel" aria-label={profile.name}
                checked={selected} onChange={()=>void select(profile.id)}/>
              <span className="nc-channel-identity">
                <strong>{profile.name}</strong>
                <span className="nc-channel-type">
                  {info?(info.configurable?info.label:msg('内置渠道')):profile.adapterId}
                </span>
              </span>
              <span className="nc-channel-selected" aria-hidden={!selected}>
                {selected&&<><Icon name="check" size={14}/>{msg('当前渠道')}</>}
              </span>
            </label>
            {info?.description&&<p className="nc-channel-description">{info.description}</p>}
            {(info?.guideUrl||info?.configurable)&&<div className="nc-channel-footer">
              <ChannelGuide url={info.guideUrl}/>
              {info.configurable&&<div className="nc-channel-actions">
                <button type="button" className="text-link" onClick={()=>edit(profile)}>{msg('重新连接')}</button>
                <button type="button" className="text-link nc-channel-remove" onClick={()=>void remove(profile)}>{msg('移除')}</button>
              </div>}
            </div>}
          </article>;
        })}
      </div>
    </fieldset>
    {error&&editing===undefined&&<p role="alert" className="error">{error}</p>}
    {editing!==undefined&&<Modal className="nc-channel-dialog" title={editing?msg('重新连接翻译渠道'):msg('添加翻译渠道')} onClose={close} footer={
      <div className="nc-channel-form-actions">
        <button className="button secondary" type="button" disabled={busy} onClick={close}>{msg('取消')}</button>
        <button className="button primary" type="submit" form={formId} disabled={busy||!definition}>
          {busy?msg('正在连接…'):msg('连接并使用')}
        </button>
      </div>
    }>
      <form id={formId} className="nc-channel-form" onSubmit={e=>{
        e.preventDefault();
        void save();
      }}>
        <fieldset className="nc-channel-services" disabled={busy}>
          <legend>{msg('服务类型')}</legend>
          <div className="nc-channel-service-grid">
            {(editing?protocols.filter(item=>item.id===protocol):protocols).map(item=><label
              className="nc-channel-service" data-selected={protocol===item.id||undefined} key={item.id}>
              <input type="radio" name="translation-service" aria-label={item.label}
                checked={protocol===item.id} onChange={()=>{
                  setProtocol(item.id);
                  setValues({});
                  setError('');
                }}/>
              <span>
                <strong>{item.label}</strong>
                {item.description&&<small>{item.description}</small>}
              </span>
            </label>)}
          </div>
        </fieldset>
        {definition?.guideUrl&&<div className="nc-channel-form-guide">
          <ChannelGuide url={definition.guideUrl}/>
        </div>}
        <label className="field">
          {msg('名称')}
          <input value={name} disabled={busy} maxLength={80} placeholder={definition?.label}
            onChange={e=>setName(e.target.value)}/>
        </label>
        {definition?.fields.map(field=>{
          const saved=field.type==='password'&&canReuse&&savedFields.includes(field.key);
          return <label className="field" key={field.key}>
            {field.label}
            <input type={field.type} required={field.required&&!saved} value={values[field.key]??''}
              placeholder={saved?msg('已保存，留空继续使用'):field.placeholder} disabled={busy}
              autoComplete={field.type==='password'?'new-password':'off'}
              onChange={e=>setValues({...values,[field.key]:e.target.value})}/>
          </label>;
        })}
        <p className="nc-channel-credential-note">
          <Icon name="shield" size={16}/>
          {msg('账号凭据保存在本机；修改服务地址或用户名时需重新输入密码。')}
        </p>
        {error&&<p role="alert" className="error">{error}</p>}
      </form>
    </Modal>}
  </section>;
}
