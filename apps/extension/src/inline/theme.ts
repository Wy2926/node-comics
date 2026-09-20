import type {Settings} from '../types';
import {settingsKey} from './settings';

type InlineTheme=Pick<Settings,'appearance'|'accentTheme'|'textScale'>;
/** Only presentation preferences cross into a source tab; storage remains trusted-only. */
function inlineTheme(input?:unknown):InlineTheme{
  const value=input&&typeof input==='object'?input as Partial<InlineTheme>:undefined;
  return {
    appearance:value?.appearance==='light'||value?.appearance==='dark'?value.appearance:'system',
    accentTheme:value?.accentTheme==='rose'||value?.accentTheme==='mint'||value?.accentTheme==='iris'?value.accentTheme:'sky',
    textScale:value?.textScale===1.125||value?.textScale===1.25?value.textScale:1,
  };
}
export function connectInlineTheme(surface:HTMLElement){
  const media=matchMedia('(prefers-color-scheme: dark)');let theme=inlineTheme(),revision=0;
  const apply=()=>{
    surface.dataset.appearance=theme.appearance==='system'?(media.matches?'dark':'light'):theme.appearance;
    surface.dataset.accent=theme.accentTheme;
    surface.style.setProperty('--text-scale',String(theme.textScale));
  };
  apply();media.addEventListener('change',apply);
  chrome.runtime.onMessage.addListener((message,sender)=>{
    if(sender.id!==chrome.runtime.id||message?.type!=='NC_INLINE_THEME_CHANGED')return;
    revision++;theme=inlineTheme(message.data);apply();
  });
  const requested=revision;
  void chrome.runtime.sendMessage({type:'NC_INLINE_THEME'}).then(value=>{if(revision!==requested)return;theme=inlineTheme(value);apply();}).catch(()=>{});
}
export function registerInlineThemeBackground(){
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||sender.tab?.id==null||sender.frameId!==0||message?.type!=='NC_INLINE_THEME')return;
    void chrome.storage.local.get(settingsKey).then(saved=>respond(inlineTheme(saved[settingsKey]))).catch(()=>respond(inlineTheme()));return true;
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    const change=changes[settingsKey];if(area!=='local'||!change)return;
    const theme=inlineTheme(change.newValue);if(JSON.stringify(theme)===JSON.stringify(inlineTheme(change.oldValue)))return;
    void chrome.tabs.query({}).then(tabs=>Promise.allSettled(tabs.filter(tab=>tab.id!=null).map(tab=>chrome.tabs.sendMessage(tab.id!,{type:'NC_INLINE_THEME_CHANGED',data:theme},{frameId:0})))).catch(()=>{});
  });
}
