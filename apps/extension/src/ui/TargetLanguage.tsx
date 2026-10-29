import {Select,SelectOption} from './Select';
import {LanguageFlag} from './LanguageFlag';
import {msg} from '../i18n/runtime';
import {fallbackLanguages,languageLabel,supportsLanguage,type Capabilities} from '../types';

export function TargetLanguage({value,onChange,caps,disabled,describedBy,label}:{value:string;onChange:(language:string)=>void;caps?:Capabilities;disabled?:boolean;describedBy?:string;label?:string}){
  const languages=caps?.languages??fallbackLanguages;
  const display=(id:string,name:string)=>name+(caps&&!supportsLanguage(caps,'classic',id)?' · '+msg('待支持'):'');
  return <Select aria-label={label??msg("默认目标语言")} aria-describedby={describedBy} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}>
    {!languages.some(language=>language.id===value)&&<SelectOption value={value} icon={<LanguageFlag language={value}/>}>{display(value,languageLabel(value))}</SelectOption>}
    {languages.map(language=><SelectOption key={language.id} value={language.id} icon={<LanguageFlag language={language.id}/>}>{display(language.id,language.label)}</SelectOption>)}
  </Select>;
}
