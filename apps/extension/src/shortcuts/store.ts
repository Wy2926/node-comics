import type {ShortcutOverrides} from './catalog';
import {normalizeOverrides} from './model';

export const shortcutStorageKey='nc-shortcuts';
type Snapshot={overrides:ShortcutOverrides;ready:boolean;error:boolean};
let snapshot:Snapshot={overrides:{},ready:false,error:false};
let initialization:Promise<void>|undefined;
let revision=0,connected=false;
const listeners=new Set<()=>void>();
const storage=()=>typeof chrome!=='undefined'&&chrome.storage?.local;
export const decodeShortcutOverrides=(value:unknown):ShortcutOverrides=>value&&typeof value==='object'&&'version' in value&&value.version===1&&'overrides' in value?normalizeOverrides(value.overrides):{};
function publish(value:Snapshot){snapshot=value;for(const listener of listeners)listener();}

export async function loadShortcutOverrides():Promise<ShortcutOverrides> {
  const extension=storage();
  if(extension)return decodeShortcutOverrides((await extension.get(shortcutStorageKey))[shortcutStorageKey]);
  const raw=localStorage.getItem(shortcutStorageKey);
  try{return raw?decodeShortcutOverrides(JSON.parse(raw)):{};}catch{return {};}
}
export const getShortcutSnapshot=()=>snapshot;
export function subscribeShortcutPreferences(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
export function initializeShortcuts():Promise<void> {
  if(initialization)return initialization;
  if(snapshot.ready&&!snapshot.error)return Promise.resolve();
  if(!connected){
    connected=true;
    if(storage())chrome.storage.onChanged.addListener((changes,area)=>{
      if(area!=='local'||!changes[shortcutStorageKey])return;
      revision++;publish({overrides:decodeShortcutOverrides(changes[shortcutStorageKey].newValue),ready:true,error:false});
    });
    else if(typeof window!=='undefined')window.addEventListener('storage',event=>{
      if(event.key!==shortcutStorageKey&&event.key!==null)return;
      revision++;let overrides:ShortcutOverrides={};
      try{overrides=event.newValue?decodeShortcutOverrides(JSON.parse(event.newValue)):{};}catch{/* Corrupt local preference resets to defaults. */}
      publish({overrides,ready:true,error:false});
    });
  }
  const started=revision;
  initialization=loadShortcutOverrides().then(overrides=>{
    if(revision===started)publish({overrides,ready:true,error:false});
  }).catch(()=>{if(revision===started)publish({...snapshot,error:true});}).finally(()=>{initialization=undefined;});
  return initialization;
}
export async function saveShortcutOverrides(value:ShortcutOverrides):Promise<void> {
  const overrides=normalizeOverrides(value),envelope={version:1,overrides},extension=storage();
  const started=revision;
  // Persist before publishing. A failed save must never appear as successful in the panel.
  try{
    if(extension)await extension.set({[shortcutStorageKey]:envelope});
    else localStorage.setItem(shortcutStorageKey,JSON.stringify(envelope));
    if(revision===started){revision++;publish({overrides,ready:true,error:false});}
  }catch(error){if(revision===started)publish({...snapshot,error:true});throw error;}
}
