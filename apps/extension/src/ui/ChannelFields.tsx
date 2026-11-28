import {useId} from 'react';
import type {ChannelField} from '../translation/channels/contracts';
import {msg} from '../i18n/runtime';
import {Select} from './Select';
import './channel-options.css';

export function ChannelFields({fields,values,onChange,disabled=false,saved=[],invalid}:{fields:readonly ChannelField[];values:Record<string,string>;onChange:(value:Record<string,string>)=>void;disabled?:boolean;saved?:readonly string[];invalid?:string}){
  const id=useId();
  return <div className="nc-config-fields">{fields.map(field=>{
    const value=values[field.key]??field.defaultValue??'',retained=field.type==='password'&&saved.includes(field.key),fieldId=id+field.key;
    const control={id:fieldId,'data-field':field.key,'aria-invalid':invalid===field.key||undefined,'aria-label':field.label,'aria-describedby':field.help?fieldId+'-help':undefined,value,disabled,
      onChange:(event:{target:{value:string}})=>onChange({...values,[field.key]:event.target.value})};
    return <div className="nc-config-field" key={field.key}>
      <label className="nc-config-row" htmlFor={fieldId}><span>{field.label}</span>
        {field.type==='select'?<Select {...control}>
          {field.options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>:field.type==='textarea'?<textarea {...control} rows={3} maxLength={field.maxLength} required={field.required} placeholder={field.placeholder}/>
          :<input {...control} type={field.type} step={field.type==='number'?'any':undefined} maxLength={field.maxLength??(field.type==='password'?4096:512)} required={field.required&&!retained} placeholder={retained?msg('已保存，留空继续使用'):field.placeholder} autoComplete={field.type==='password'?'new-password':'off'}/>}
      </label>
      {field.help&&<p id={fieldId+'-help'} className="nc-muted nc-config-help">{field.help}</p>}
    </div>;
  })}</div>;
}
