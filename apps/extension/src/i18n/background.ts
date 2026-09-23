import {setUiLanguage,localePayload} from './load';
import {validUiLanguage} from './locales';
import {msg} from './runtime';

const settingsKey='nc-reader-settings';
const preference=(value:unknown)=>(value&&typeof value==='object'&&'uiLanguage' in value)?value.uiLanguage:undefined;
export function registerLocaleBackground(){
  const apply=async(value?:unknown)=>{
    const language=preference(value);
    await setUiLanguage(validUiLanguage(language)?language:'auto');
    await Promise.allSettled([
      chrome.contextMenus.update('nc-translate-page',{title:msg('翻译当前页面')}),
    ]);
  };
  let ready=chrome.storage.local.get(settingsKey).then(data=>apply(data[settingsKey]));
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||message?.type!=='NC_UI_LOCALE')return;
    void ready.then(()=>respond(localePayload())).catch(()=>respond(undefined));return true;
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    const change=changes[settingsKey];if(area!=='local'||!change||preference(change.newValue)===preference(change.oldValue))return;
    ready=apply(change.newValue);
    void ready.then(async()=>{const tabs=await chrome.tabs.query({});await Promise.allSettled(tabs.filter(t=>t.id!=null).map(t=>chrome.tabs.sendMessage(t.id!,{type:'NC_UI_LOCALE_CHANGED',data:localePayload()},{frameId:0})));}).catch(()=>{});
  });
  return ()=>ready;
}
