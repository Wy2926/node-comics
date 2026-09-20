import {installDictionary,type Dictionary} from './runtime';
import {validUiLanguage,type UiLocale} from './locales';

/** Only extension-owned UI uses this dictionary; the source page's content is never translated here. */
export function connectContentLocale(){
  const apply=(value:{locale:UiLocale;dictionary:Dictionary}|undefined)=>{
    if(value&&validUiLanguage(value.locale)&&value.dictionary&&typeof value.dictionary==='object')installDictionary(value.locale,value.dictionary);
  };
  void chrome.runtime.sendMessage({type:'NC_UI_LOCALE'}).then(apply).catch(()=>{});
  chrome.runtime.onMessage.addListener((message,sender)=>{if(sender.id===chrome.runtime.id&&message?.type==='NC_UI_LOCALE_CHANGED')apply(message.data);});
}
