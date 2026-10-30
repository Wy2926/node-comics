import {useRef,useState} from 'react';
import {settings,saveSettings} from '../comics/application/preferences';
import {readReaderSettings} from '../inline/settings';
import {normalizeAutoTranslateSites,type AutoTranslateSite} from '../inline/auto-tab-rules';
import {requireHostAccess} from '../host-permissions';
import {msg} from '../i18n/runtime';
import type {Settings} from '../types';

export const autoTranslateScopeLabel=(site:AutoTranslateSite)=>site.scope==='domain'?msg('整个网站'):site.scope==='directory'?site.value:msg('正则匹配');

export function useAutoTranslateSettings(onSaved:(value:Settings)=>void){
  const [pending,setPending]=useState(false),[error,setError]=useState(''),lock=useRef(false);
  async function update(change:(previous:Settings)=>Settings|Promise<Settings>){
    if(lock.current)return false;
    lock.current=true;setPending(true);setError('');
    try{
      const write=async()=>{
        const previous=await readReaderSettings(settings()),changed=await change(previous);
        const next={...changed,autoTranslateSites:normalizeAutoTranslateSites(changed.autoTranslateSites)};
        const expands=next.autoTranslateSites.some(site=>{
          const old=previous.autoTranslateSites.find(value=>value.hostname===site.hostname);
          return site.enabled&&(!previous.autoTranslateTabs||!old?.enabled||old.scope!==site.scope||old.value!==site.value);
        });
        if(next.autoTranslateTabs&&expands){
          if(typeof chrome==='undefined'||!chrome.runtime?.id)throw Error(msg('请在浏览器插件中开启标签页自动翻译。'));
          await requireHostAccess();
        }
        try{await saveSettings(next);}catch(error){await saveSettings(previous).catch(()=>{});throw error;}
        onSaved(next);
      };
      if(typeof navigator!=='undefined'&&navigator.locks)await navigator.locks.request('nc-auto-translate-settings',write);else await write();
      return true;
    }catch(error){setError(error instanceof Error?error.message:msg('设置未保存，请重试。'));return false;}
    finally{lock.current=false;setPending(false);}
  }
  return {pending,error,update};
}
