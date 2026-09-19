import type {Settings} from '../types';
import type {Session} from '../library/store';

export const settingsKey='nc-reader-settings',sessionKey='nc-reader-session';
const extensionStorage=()=>typeof chrome!=='undefined'&&chrome.storage?.local;
export async function mirrorReader(values:{settings?:Settings;session?:Session|null}){
  const storage=extensionStorage();if(!storage)return;
  await storage.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const data:Record<string,unknown>={};
  if(values.settings)data[settingsKey]=values.settings;
  if('session' in values)data[sessionKey]=values.session;
  const previous=await storage.get(Object.keys(data));
  for(const key of Object.keys(data))if(JSON.stringify(previous[key])===JSON.stringify(data[key]))delete data[key];
  if(Object.keys(data).length)await storage.set(data);
}
export async function connectReaderSettings(settings:Settings,session:Session|null){
  const storage=extensionStorage();if(!storage)return;
  await storage.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const saved=await storage.get([settingsKey,sessionKey]);
  if(saved[settingsKey])localStorage.setItem('nc-settings',JSON.stringify(saved[settingsKey]));
  if(sessionKey in saved){if(saved[sessionKey])localStorage.setItem('nc-session',JSON.stringify(saved[sessionKey]));else localStorage.removeItem('nc-session');}
  await mirrorReader({settings:saved[settingsKey] as Settings??settings,session:sessionKey in saved?saved[sessionKey] as Session|null:session});
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local')return;
    for(const [key,local] of [[settingsKey,'nc-settings'],[sessionKey,'nc-session']]){
      if(!changes[key])continue;
      const value=changes[key].newValue,newValue=value?JSON.stringify(value):null;
      if(localStorage.getItem(local)===newValue)continue;
      if(newValue)localStorage.setItem(local,newValue);else localStorage.removeItem(local);
      window.dispatchEvent(new StorageEvent('storage',{key:local,newValue}));
    }
  });
}
