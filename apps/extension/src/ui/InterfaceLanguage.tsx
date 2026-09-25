import {Select,SelectOption} from './Select';
import {LanguageFlag} from './LanguageFlag';
import {useState} from 'react';
import {msg} from '../i18n/runtime';
import {uiLanguages,type UiLanguage} from '../i18n/locales';
import {setUiLanguage} from '../i18n/load';
import {SettingRow} from './components';

export function InterfaceLanguage({value,onChange}:{value:UiLanguage;onChange:(value:UiLanguage)=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState(false);
  async function change(next:UiLanguage){
    setBusy(true);setError(false);
    try{await setUiLanguage(next);onChange(next);}catch{setError(true);}finally{setBusy(false);}
  }
  return <SettingRow title={msg('界面语言')} description={msg('选择菜单和按钮的语言，不影响漫画翻译目标语言。')}>
    <div><Select aria-label={msg('界面语言')} value={value} disabled={busy} onChange={e=>void change(e.target.value as UiLanguage)}>
      <SelectOption value="auto" icon={<LanguageFlag language="auto"/>}>{msg('跟随浏览器')}</SelectOption>
      {uiLanguages.map(language=><SelectOption key={language.id} value={language.id} icon={<LanguageFlag language={language.id}/>}>{language.label}</SelectOption>)}
    </Select>{busy&&<span role="status">{msg('正在切换语言…')}</span>}{error&&<p role="alert">{msg('语言切换失败，请重试。')}</p>}</div>
  </SettingRow>;
}
