import {resolveLocale} from '../i18n/locales';
import {defaults,type Settings} from '../types';

export const settingsKey='nc-reader-settings';
const extensionStorage=()=>typeof chrome!=='undefined'&&chrome.storage?.local;
/** Browser matching is only for a new preference record, never a migration default. */
export function initialReaderSettings():Settings {
  const languages=typeof navigator==='undefined'?[]:navigator.languages?.length?navigator.languages:[navigator.language].filter(Boolean);
  const locale=resolveLocale('auto',languages);
  return {...defaults,language:locale==='zh-CN'?'zh-Hans':locale==='zh-TW'?'zh-Hant':locale};
}
const restoredSettings=(value?:unknown):Settings=>value==null?initialReaderSettings():{...defaults,...(typeof value==='object'?value as Partial<Settings>:{})};
export const translationLanguageChanged=(before?:unknown,after?:unknown)=>restoredSettings(before).language!==restoredSettings(after).language;
async function settingsLock<T>(run:()=>Promise<T>):Promise<T> {
  return await (typeof navigator!=='undefined'&&navigator.locks?navigator.locks.request(settingsKey,run):run());
}
export async function readReaderSettings(fallback?:Settings):Promise<Settings> {
  const storage=extensionStorage();if(!storage)return fallback??initialReaderSettings();
  const read=async()=>(await storage.get([settingsKey]))[settingsKey];
  const saved=await read();if(saved!=null)return restoredSettings(saved);
  // Ordinary translation reads stay lock-free; only first-use writes need a recheck.
  return settingsLock(async()=>{
    const current=await read();if(current!=null)return restoredSettings(current);
    const settings=fallback??initialReaderSettings();
    await storage.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
    await storage.set({[settingsKey]:settings});
    return settings;
  });
}
export async function mirrorReader(values:{settings?:Settings}){
  const storage=extensionStorage();if(!storage)return;
  await settingsLock(async()=>{
    await storage.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
    const data:Record<string,unknown>={};
    if(values.settings)data[settingsKey]=values.settings;
    const previous=await storage.get(Object.keys(data));
    for(const key of Object.keys(data))if(JSON.stringify(previous[key])===JSON.stringify(data[key]))delete data[key];
    if(Object.keys(data).length)await storage.set(data);
  });
}
export async function connectReaderSettings(settings:Settings){
  const storage=extensionStorage();
  if(storage)await storage.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
  let changedDuringLoad=false;
  if(storage)chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local')return;
    for(const [key,local] of [[settingsKey,'nc-settings']]){
      if(!changes[key])continue;
      changedDuringLoad=true;
      const value=changes[key].newValue,newValue=value?JSON.stringify(value):null;
      if(localStorage.getItem(local)===newValue)continue;
      if(newValue)localStorage.setItem(local,newValue);else localStorage.removeItem(local);
      window.dispatchEvent(new StorageEvent('storage',{key:local,newValue}));
    }
  });
  const saved=await readReaderSettings(settings);
  if(!changedDuringLoad)localStorage.setItem('nc-settings',JSON.stringify(saved));
}
