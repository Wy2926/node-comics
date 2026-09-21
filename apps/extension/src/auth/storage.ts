import {msg} from '../i18n/runtime';
import {API_ORIGIN} from '../service';
import {validSession,type AuthState,type Session} from './model';
import {readPrivateAuth,writePrivateAuth} from './private-store';

export const authKey='nc-auth';
const localChanges=new EventTarget();
const extensionStorage=()=>typeof chrome!=='undefined'?chrome.storage?.local:undefined;
// Use restricted extension storage where supported, otherwise extension-origin
// IndexedDB. Web reader tabs keep their separate origin-local store.
export async function readAuth():Promise<AuthState>{
  const storage=extensionStorage();
  let value:AuthState|undefined;
  try{
    if(!storage)value=JSON.parse(localStorage.getItem(authKey)??'null');
    else if(typeof storage.setAccessLevel==='function')value=(await storage.get(authKey))[authKey] as AuthState|undefined;
    else value=await readPrivateAuth();
  }catch{return {session:null};}
  if(!value)return {session:null};
  if(value.session===null)return {session:null,...(value.reason==='expired'?{reason:'expired' as const}:{})};
  if(!validSession(value.session)||value.session.apiOrigin!==API_ORIGIN)return {session:null,reason:'expired'};
  return value;
}
async function writeAuth(value:AuthState){
  const storage=extensionStorage();
  if(storage){
    if(typeof storage.setAccessLevel==='function'){
      await storage.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await storage.set({[authKey]:value});
    }else{
      await writePrivateAuth(value);
      // Wake other extension contexts and preserve account-change detection,
      // without putting credentials or profile data in content-readable storage.
      await storage.set({[authKey]:{session:value.session?{id:value.session.id}:null,revision:crypto.randomUUID()}});
    }
  }
  else localStorage.setItem(authKey,JSON.stringify(value));
  localChanges.dispatchEvent(new Event('change'));
}
export async function saveSession(session:Session|null){
  if(session&&(!validSession(session)||session.apiOrigin!==API_ORIGIN))throw Error(msg("登录会话或服务地址无效。"));
  await navigator.locks.request('nc-auth-write',()=>writeAuth({session}));
}
// A late refresh or 401 from an old login must never replace the new account.
export async function updateSession(id:string,token:string,change:(session:Session)=>AuthState){
  return navigator.locks.request('nc-auth-write',async()=>{
    const current=await readAuth();
    if(current.session?.id!==id||current.session.token!==token)return false;
    await writeAuth(change(current.session));return true;
  });
}
export async function signOut(id:string){
  await navigator.locks.request('nc-auth-write',async()=>{if((await readAuth()).session?.id===id)await writeAuth({session:null});});
}
export function subscribeAuth(listener:()=>void){
  const changed=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{if(area==='local'&&changes[authKey])listener();};
  const webChanged=(event:StorageEvent)=>{if(event.key===authKey||event.key===null)listener();};
  localChanges.addEventListener('change',listener);
  if(extensionStorage())chrome.storage.onChanged.addListener(changed);
  else if(typeof window!=='undefined')window.addEventListener('storage',webChanged);
  return ()=>{localChanges.removeEventListener('change',listener);if(extensionStorage())chrome.storage.onChanged.removeListener(changed);else if(typeof window!=='undefined')window.removeEventListener('storage',webChanged);};
}
