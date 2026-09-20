import {fallbackLanguages,languageLabel,supportsLanguage,type Capabilities,type Settings} from '../types';

/** The popup and preferences edit the same setting, including the mode fallback. */
export function withTargetLanguage(settings:Settings,language:string,caps?:Capabilities):Settings{
  return {...settings,language,translationMode:supportsLanguage(caps,settings.translationMode,language)?settings.translationMode:'classic'};
}

export function TargetLanguage({value,onChange,caps,disabled,describedBy}:{value:string;onChange:(language:string)=>void;caps?:Capabilities;disabled?:boolean;describedBy?:string}){
  const languages=caps?.languages??fallbackLanguages;
  return <select aria-label="默认目标语言" aria-describedby={describedBy} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}>
    {!languages.some(language=>language.id===value)&&<option value={value}>{languageLabel(value)}</option>}
    {languages.map(language=><option key={language.id} value={language.id}>{language.label}</option>)}
  </select>;
}
