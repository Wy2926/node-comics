import type {Settings} from '../types';

export const settingsKey='nc-reader-settings';
const extensionStorage=()=>typeof chrome!=='undefined'&&chrome.storage?.local;
export async function mirrorReader(values:{settings?:Settings}){
  const storage=extensionStorage();if(!storage)return;
  await storage.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
  const data:Record<string,unknown>={};
  if(values.settings)data[settingsKey]=values.settings;
  const previous=await storage.get(Object.keys(data));
  for(const key of Object.keys(data))if(JSON.stringify(previous[key])===JSON.stringify(data[key]))delete data[key];
  if(Object.keys(data).length)await storage.set(data);
}
export async function connectReaderSettings(settings:Settings){
  const storage=extensionStorage();if(!storage)return;
  const saved=await storage.get([settingsKey]);
  if(saved[settingsKey])localStorage.setItem('nc-settings',JSON.stringify(saved[settingsKey]));
  await mirrorReader({settings:saved[settingsKey] as Settings??settings});
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local')return;
    for(const [key,local] of [[settingsKey,'nc-settings']]){
      if(!changes[key])continue;
      const value=changes[key].newValue,newValue=value?JSON.stringify(value):null;
      if(localStorage.getItem(local)===newValue)continue;
      if(newValue)localStorage.setItem(local,newValue);else localStorage.removeItem(local);
      window.dispatchEvent(new StorageEvent('storage',{key:local,newValue}));
    }
  });
}
