import {useId} from 'react';
import type {ChannelField} from '../translation/channels/contracts';
import {msg} from '../i18n/runtime';
import {Select} from './Select';
import './channel-options.css';

export function ChannelFields({fields,values,onChange,disabled=false,saved=[]}:{fields:readonly ChannelField[];values:Record<string,string>;onChange:(value:Record<string,string>)=>void;disabled?:boolean;saved?:readonly string[]}){
  const id=useId();
  return <div className="nc-config-fields">{fields.map(field=>{
    const value=values[field.key]??field.defaultValue??'',retained=field.type==='password'&&saved.includes(field.key),fieldId=id+field.key;
    return <div className="nc-config-field" key={field.key}>
      <label className="nc-config-row" htmlFor={fieldId}><span>{field.label}</span>
        {field.type==='select'?<Select id={fieldId} aria-label={field.label} value={value} disabled={disabled} onChange={event=>onChange({...values,[field.key]:event.target.value})}>
          {field.options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>:<input id={fieldId} aria-label={field.label} aria-describedby={field.help?fieldId+'-help':undefined} type={field.type} step={field.type==='number'?'any':undefined} maxLength={field.type==='password'?4096:512} value={value} required={field.required&&!retained} disabled={disabled} placeholder={retained?msg('已保存，留空继续使用'):field.placeholder} autoComplete={field.type==='password'?'new-password':'off'} onChange={event=>onChange({...values,[field.key]:event.target.value})}/>}
      </label>
      {field.help&&<p id={fieldId+'-help'} className="nc-muted nc-config-help">{field.help}</p>}
    </div>;
  })}</div>;
}
