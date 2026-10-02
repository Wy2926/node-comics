import type {ShortcutHandlers,ShortcutOverrides} from './catalog';
import {normalizeOverrides} from './model';
import {bindShortcuts} from './runtime';

const trustedBackground = (sender:chrome.runtime.MessageSender) => sender.id===chrome.runtime.id
  && !sender.tab&&(!sender.url||sender.url.startsWith(chrome.runtime.getURL('')));

/** Public shortcut preferences only: content scripts never receive account or reader storage. */
export function bindWebShortcuts(handlers:ShortcutHandlers, enabled:()=>boolean) {
  let overrides:ShortcutOverrides={},disposed=false,ready=false,revision=0;
  const changed=(message:{type?:string;overrides?:unknown},sender:chrome.runtime.MessageSender)=>{
    if(message?.type!=='NC_SHORTCUTS_CHANGED'||!trustedBackground(sender))return;
    revision++;overrides=normalizeOverrides(message.overrides);ready=true;
  };
  chrome.runtime.onMessage.addListener(changed);
  const initialRevision=revision;
  void chrome.runtime.sendMessage({type:'NC_SHORTCUTS_GET'}).then(response=>{
    if(!disposed&&revision===initialRevision&&response?.ok){overrides=normalizeOverrides(response.overrides);ready=true;}
  }).catch(()=>{});
  // The page must not invoke extension actions through synthetic keyboard events.
  const guarded=Object.fromEntries(Object.entries(handlers).map(([id,handler])=>[id,(event:KeyboardEvent)=>
    event.isTrusted?handler!(event):false])) as ShortcutHandlers;
  const unbind=bindShortcuts(window,guarded,{getOverrides:()=>overrides,enabled:()=>ready&&!disposed&&!document.hidden&&enabled()});
  return ()=>{disposed=true;unbind();chrome.runtime.onMessage.removeListener(changed);};
}

/** Always-on entry is deliberately limited to keyboard matching and public preferences. */
export function installWebShortcuts() {
  // Content scripts on ordinary HTTP pages cannot use secure-context-only randomUUID.
  const instanceId=Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
  let busy=false,disposed=false,errorHost:HTMLElement|undefined,errorTimer:ReturnType<typeof setTimeout>|undefined;
  const identity=(message:{type?:string;error?:string},sender:chrome.runtime.MessageSender,respond:(value:unknown)=>void)=>{
    if(!trustedBackground(sender))return;
    if(message?.type==='NC_SHORTCUTS_IDENTITY')respond({instanceId,url:location.href});
    if(message?.type==='NC_SHORTCUTS_ERROR'&&typeof message.error==='string'){showError(message.error);respond({ok:true});}
  };
  chrome.runtime.onMessage.addListener(identity);
  function showError(message:string){
    if(disposed||document.hidden)return;
    clearTimeout(errorTimer);errorHost?.remove();
    const host=document.createElement('div');host.style.cssText='all:initial!important;position:fixed!important;inset:auto 20px 20px!important;z-index:2147483647!important;pointer-events:none!important';
    const shadow=host.attachShadow({mode:'closed'}),notice=document.createElement('div');
    notice.setAttribute('role','alert');notice.textContent=message;
    notice.style.cssText='max-width:600px;margin:auto;padding:12px 16px;border-radius:10px;background:#20242c;color:white;font:14px/1.5 system-ui;box-shadow:0 4px 24px #0004';
    shadow.append(notice);document.documentElement.append(host);errorHost=host;
    errorTimer=setTimeout(()=>{host.remove();if(errorHost===host)errorHost=undefined;},7000);
  }
  function execute(action:'web.translate'|'web.shortcuts'){
    if(busy)return false;
    busy=true;
    void chrome.runtime.sendMessage({type:'NC_SHORTCUTS_EXECUTE',action,url:location.href,instanceId})
      .then(response=>{if(!response?.ok&&response?.error)showError(response.error);})
      .catch(()=>{}).finally(()=>{busy=false;});
  }
  const unbind=bindWebShortcuts({
    'web.translate':()=>execute('web.translate'),
    'web.shortcuts':()=>execute('web.shortcuts'),
  },()=>!disposed);
  return ()=>{
    disposed=true;unbind();chrome.runtime.onMessage.removeListener(identity);
    clearTimeout(errorTimer);errorHost?.remove();
  };
}
