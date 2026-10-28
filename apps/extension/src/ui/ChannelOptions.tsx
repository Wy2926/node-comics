import {useEffect,useRef,useState} from 'react';
import type {ChannelOptions} from '../translation/channels/contracts';
import {msg} from '../i18n/runtime';
import {ChannelFields} from './ChannelFields';
import {ChannelServices} from './ChannelServices';
import {ChannelResources} from './ChannelResources';
import './channel-options.css';

export function ChannelOptionsPanel({options}:{options?:ChannelOptions}){
  const [values,setValues]=useState<Record<string,string>>({}),[saving,setSaving]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  const [expanded,setExpanded]=useState(false),current=useRef(options);
  current.current=options;
  useEffect(()=>{setValues(options?.values??{});},[options]);
  if(!options)return null;
  async function save(next:Record<string,string>){
    if(saving)return;
    const source=options!;
    setValues(next);setSaving(true);setError('');setSaved(false);
    try{await source.save(next);setSaved(true);}catch(error){
      if(current.current===source){setValues(source.values);setError((error as Error).message);}
    }finally{setSaving(false);}
  }
  const form=<form aria-busy={saving} onSubmit={event=>event.preventDefault()}>
    <ChannelFields fields={options.fields} values={values} onChange={next=>void save(next)} disabled={saving}/>
    {saved&&<span role="status" className="nc-muted">{msg('已保存')}</span>}
    {error&&<p className="error" role="alert">{error}</p>}
  </form>;
  return <section className="nc-channel-options">
    {options.services&&<ChannelServices services={options.services}/>}
    {options.fields.length>0&&(options.settingsLabel?<details className="nc-config-advanced" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}><summary>{options.settingsLabel}</summary>{form}</details>:form)}
    {options.resources&&<ChannelResources manager={options.resources}/>}
  </section>;
}
