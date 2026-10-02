import {useEffect,useRef,useSyncExternalStore} from 'react';
import type {ShortcutHandlers} from './catalog';
import {bindShortcuts} from './runtime';
import {getShortcutSnapshot,initializeShortcuts,saveShortcutOverrides,subscribeShortcutPreferences} from './store';

export function useShortcutPreferences(){
  const snapshot=useSyncExternalStore(subscribeShortcutPreferences,getShortcutSnapshot);
  useEffect(()=>{void initializeShortcuts();},[]);
  return {...snapshot,save:saveShortcutOverrides};
}
/** Keep the one listener stable; live callbacks never capture old reader/page state. */
export function useShortcuts(handlers:ShortcutHandlers,{enabled=true}:{enabled?:boolean}={}){
  const preferences=useShortcutPreferences(),current=useRef({handlers,enabled,preferences});
  current.current={handlers,enabled,preferences};
  const ids=Object.keys(handlers).sort().join('|');
  useEffect(()=>{
    const live:ShortcutHandlers={};
    for(const id of Object.keys(current.current.handlers) as (keyof ShortcutHandlers)[])live[id]=event=>{const handler=current.current.handlers[id];return handler?handler(event):false;};
    return bindShortcuts(window,live,{getOverrides:()=>current.current.preferences.overrides,enabled:()=>current.current.enabled&&current.current.preferences.ready});
  },[ids]);
}
