import {openSourceDatabase} from '../../storage/database';
import type {ChannelProfile} from './contracts';

export const channelSettingsKey='nc-translation-channels';
export const defaultChannel:ChannelProfile={id:'nodelane',adapterId:'nodelane',name:'NodeLane',revision:1,settings:{}};
export interface ChannelSettings {activeId:string;profiles:ChannelProfile[];modelPreferences?:Record<string,string>;}
const defaults=():ChannelSettings=>({activeId:defaultChannel.id,profiles:[]});
function normalize(value:unknown):ChannelSettings {
  if(!value||typeof value!=='object')return defaults();
  const input=value as ChannelSettings;
  const profiles=Array.isArray(input.profiles)?input.profiles.filter(p=>p&&typeof p.id==='string'&&p.id!==defaultChannel.id&&typeof p.adapterId==='string'&&typeof p.name==='string'&&Number.isSafeInteger(p.revision)&&p.revision>0&&p.settings&&Object.values(p.settings).every(v=>typeof v==='string')):[];
  const modelPreferences=input.modelPreferences&&typeof input.modelPreferences==='object'?Object.fromEntries(Object.entries(input.modelPreferences).filter(([,id])=>typeof id==='string'&&id.length>0&&id.length<=36)):undefined;
  return {activeId:input.activeId===defaultChannel.id||profiles.some(p=>p.id===input.activeId)?input.activeId:defaultChannel.id,profiles,...(modelPreferences?{modelPreferences}:{})};
}
export async function readChannelSettings():Promise<ChannelSettings>{
  if(typeof chrome!=='undefined'&&chrome.storage?.local)return normalize((await chrome.storage.local.get(channelSettingsKey))[channelSettingsKey]);
  try{return normalize(JSON.parse(localStorage.getItem(channelSettingsKey)??'null'));}catch{return defaults();}
}
const localListeners=new Set<()=>void>();
export async function writeChannelSettings(value:ChannelSettings){
  // Reconnecting can change only the secret. Still invalidate connections in every context.
  const stored={...value,changeId:crypto.randomUUID()};
  if(typeof chrome!=='undefined'&&chrome.storage?.local)await chrome.storage.local.set({[channelSettingsKey]:stored});
  else {localStorage.setItem(channelSettingsKey,JSON.stringify(stored));for(const listener of localListeners)listener();}
}
let pendingMutation:Promise<unknown>=Promise.resolve();
async function withChannelSettings<T>(run:()=>Promise<T>):Promise<T>{
  if(typeof navigator!=='undefined'&&navigator.locks){
    return await navigator.locks.request(channelSettingsKey,run);
  }
  const next=pendingMutation.then(run,run);
  pendingMutation=next.catch(()=>{});
  return next;
}
export async function updateChannelSettings(change:(value:ChannelSettings)=>Promise<ChannelSettings>|ChannelSettings):Promise<void>{
  return withChannelSettings(async()=>{
    await writeChannelSettings(await change(await readChannelSettings()));
  });
}
export async function readChannelCredentials(id:string){
  return withChannelSettings(async()=>{
    const profile=(await readChannelSettings()).profiles.find(p=>p.id===id);
    const record=await readCredentialRecord(id);
    const secrets=profile&&record?.binding&&matchesBinding(record.binding,profile)?record.values:{};
    return {profile,secrets};
  });
}
export function subscribeChannelSettings(listener:()=>void){
  localListeners.add(listener);
  const stored=(changes:Record<string,unknown>,area:string)=>{if(area==='local'&&channelSettingsKey in changes)listener();};
  const storage=(event:StorageEvent)=>{if(event.key===channelSettingsKey||event.key===null)listener();};
  if(typeof chrome!=='undefined'&&chrome.storage?.onChanged)chrome.storage.onChanged.addListener(stored);
  if(typeof window!=='undefined')window.addEventListener('storage',storage);
  return ()=>{localListeners.delete(listener);if(typeof chrome!=='undefined'&&chrome.storage?.onChanged)chrome.storage.onChanged.removeListener(stored);if(typeof window!=='undefined')window.removeEventListener('storage',storage);};
}
// Credentials belong to the extension origin's IndexedDB, never content-script storage.
let credentialDatabase:Promise<IDBDatabase>|undefined;
type CredentialBinding=Pick<ChannelProfile,'adapterId'|'settings'>;
interface CredentialRecord {
  id:string;
  values:Record<string,string>;
  binding?:CredentialBinding;
}
function matchesBinding(binding:CredentialBinding,profile:CredentialBinding){
  return binding.adapterId===profile.adapterId
    &&Object.keys(binding.settings).length===Object.keys(profile.settings).length
    &&Object.entries(binding.settings).every(([key,value])=>profile.settings[key]===value);
}
async function secretsStore<T>(mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const db=await (credentialDatabase??=openSourceDatabase('translation-channel-credentials',{credentials:{keyPath:'id'}},()=>{credentialDatabase=undefined;}).catch(error=>{credentialDatabase=undefined;throw error;}));
  return new Promise((resolve,reject)=>{const tx=db.transaction('credentials',mode),request=action(tx.objectStore('credentials'));tx.oncomplete=()=>resolve(request.result);tx.onerror=tx.onabort=()=>reject(tx.error);});
}
async function readCredentialRecord(id:string){
  return secretsStore<CredentialRecord|undefined>('readonly',s=>s.get(id));
}
export async function readChannelSecrets(id:string,profile?:CredentialBinding):Promise<Record<string,string>>{
  const record=await readCredentialRecord(id);
  return record&&(!profile||!record.binding||matchesBinding(record.binding,profile))?record.values:{};
}
export async function writeChannelSecrets(id:string,values:Record<string,string>,binding?:CredentialBinding){
  const record:CredentialRecord={id,values};
  if(binding)record.binding={adapterId:binding.adapterId,settings:binding.settings};
  await secretsStore('readwrite',s=>s.put(record));
}
export async function deleteChannelSecrets(id:string){await secretsStore('readwrite',s=>s.delete(id));}
