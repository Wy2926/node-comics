import {Select,SelectOption} from './Select';
import {LanguageFlag} from './LanguageFlag';
import {msg} from '../i18n/runtime';
import {fallbackLanguages,languageLabel,type Capabilities} from '../types';

export function TargetLanguage({value,onChange,caps,disabled,describedBy}:{value:string;onChange:(language:string)=>void;caps?:Capabilities;disabled?:boolean;describedBy?:string}){
  const languages=caps?.languages??fallbackLanguages;
  return <Select aria-label={msg("默认目标语言")} aria-describedby={describedBy} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}>
    {!languages.some(language=>language.id===value)&&<SelectOption value={value} icon={<LanguageFlag language={value}/>}>{languageLabel(value)}</SelectOption>}
    {languages.map(language=><SelectOption key={language.id} value={language.id} icon={<LanguageFlag language={language.id}/>}>{language.label}</SelectOption>)}
  </Select>;
}
